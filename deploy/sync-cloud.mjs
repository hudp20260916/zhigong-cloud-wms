/**
 * 啊平智能 — 一键同步到腾讯云（Node 版，不依赖 sshpass / rsync）
 *
 * 用法（项目根目录执行）：
 *   方式一 密码认证：  CLOUD_PASS='服务器密码' node deploy/sync-cloud.mjs
 *   方式二 密钥认证：  CLOUD_KEY='C:/Users/admin/.ssh/xxx' node deploy/sync-cloud.mjs
 *   跳过重新构建：    node deploy/sync-cloud.mjs --no-build
 *   不上传前端：      node deploy/sync-cloud.mjs --no-web
 *   只验证不改动：    node deploy/sync-cloud.mjs --check
 *
 * 同步内容：server/src、shared、server/package.json、package.json、web/dist
 * 流程：本地构建 → 备份云端旧版 → 逐个上传为 .tmp → 逐个 mv 替换 →
 *       清理失效 assets → 重启服务 → 按 index.html 引用逐个验活 → 失败自动回滚
 *
 * 踩过的坑（已在此脚本中固化）：
 *   1. mv 不能串成 a && b && c —— 中间一个失败会连坐，导致后面全部没替换
 *   2. 上传前必须 mkdir -p 目标目录（云端缺 server/src/scripts 时整批上传失败）
 *   3. 必须先替换再清理旧 assets，否则新文件还是 .tmp 而旧文件已被删 → 页面白屏
 *   4. 健康检查不能只看首页 200，必须逐个验 http 资产是否 200
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire('C:/Users/admin/.workbuddy/binaries/node/workspace/package.json');
const { Client } = require('ssh2');

const ROOT = path.resolve(process.cwd());
const APP = process.env.CLOUD_APP || '/opt/zhigong';
const HOST = process.env.CLOUD_HOST || '106.55.93.200';
const USER = process.env.CLOUD_USER || 'ubuntu';
const PASS = process.env.CLOUD_PASS || '';
const KEY = process.env.CLOUD_KEY || '';
const SERVICE = process.env.CLOUD_SERVICE || 'zhigong';

const args = process.argv.slice(2);
const NO_BUILD = args.includes('--no-build');
const NO_WEB = args.includes('--no-web');
const CHECK_ONLY = args.includes('--check');
const STAMP = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);

const walk = (dir, base, acc = []) => {
  for (const e of fs.readdirSync(path.join(base, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) walk(rel, base, acc);
    else acc.push(rel);
  }
  return acc;
};

function collectManifest() {
  const m = [];
  for (const f of ['package.json', 'server/package.json']) {
    if (fs.existsSync(path.join(ROOT, f))) m.push(f);
  }
  for (const dir of ['server/src', 'shared']) {
    const abs = path.join(ROOT, dir);
    if (fs.existsSync(abs)) for (const f of walk(dir, ROOT)) m.push(f);
  }
  if (!NO_WEB) {
    for (const f of walk('web/dist', ROOT)) m.push(f);
  }
  return m;
}

const conn = new Client();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const sh = (cmd) =>
  new Promise((resolve) => {
    conn.exec(cmd, (err, stream) => {
      if (err) return resolve(`[exec error] ${err.message}`);
      let out = '', errs = '';
      stream.on('close', () => resolve((out + (errs ? `\n[stderr] ${errs}` : '')).trim()))
        .on('data', (d) => (out += d));
      stream.stderr.on('data', (d) => (errs += d));
    });
  });

const sftpPut = (localAbs, remoteAbs) =>
  new Promise((resolve, reject) => {
    conn.sftp((err, sftp) => {
      if (err) return reject(err);
      const ws = sftp.createWriteStream(remoteAbs, { flags: 'w', mode: 0o644 });
      ws.on('close', () => { sftp.end(); resolve(); });
      ws.on('error', reject);
      fs.createReadStream(localAbs).pipe(ws);
    });
  });

async function main() {
  const manifest = collectManifest();

  if (CHECK_ONLY) {
    await check(manifest);
    return;
  }

  console.log(`== 同步清单 ${manifest.length} 个文件（AppDir=${APP}）==`);
  await walked(async () => {
    console.log('\n[1/6] 备份云端当前版本');
    console.log(await sh(`mkdir -p ${APP}/backups && tar -czf ${APP}/backups/update-${STAMP}.tar.gz -C ${APP} server/src shared web/dist package.json server/package.json 2>/dev/null; ls -la ${APP}/backups/update-${STAMP}.tar.gz | awk '{print "  备份："$5" 字节  "$9}'`));

    console.log('\n[2/6] 准备云端目录（含易缺失的 server/src/scripts）');
    const dirs = [...new Set(manifest.map((f) => path.posix.dirname(f)))];
    console.log(await sh(`cd ${APP} && mkdir -p ${dirs.map((d) => `"${d}"`).join(' ')} && echo "  已就绪 ${dirs.length} 个目录"`));

    console.log('\n[3/6] 上传（先写 .tmp）');
    let ok = 0, skip = 0;
    for (const rel of manifest) {
      const localAbs = path.join(ROOT, rel).replace(/\\/g, '/');
      if (!fs.existsSync(localAbs)) { skip++; continue; }
      await sftpPut(localAbs, `${APP}/${rel}.tmp`);
      ok++;
    }
    console.log(`  上传成功 ${ok} 个，跳过 ${skip} 个`);

    console.log('\n[4/6] 逐个替换（互不影响）');
    let mvOk = 0, mvFail = 0;
    for (const rel of manifest) {
      const r = await sh(`if [ -f "${APP}/${rel}.tmp" ]; then mkdir -p "$(dirname "${APP}/${rel}")"; mv -f "${APP}/${rel}.tmp" "${APP}/${rel}" && echo OK; else echo MISS; fi`);
      if (r.includes('OK')) mvOk++;
      else if (r.includes('MISS')) mvFail++;
      else { mvFail++; console.log(`  ✗ ${rel}: ${r}`); }
    }
    console.log(`  替换 ${mvOk} 个，未替换 ${mvFail} 个`);

    console.log('\n[5/6] 清理已失效的前端 assets（新文件就位后才清）');
    const localAssets = fs.existsSync(path.join(ROOT, 'web/dist/assets'))
      ? fs.readdirSync(path.join(ROOT, 'web/dist/assets'))
      : [];
    if (localAssets.length) {
      const keep = localAssets.map((n) => `-e '${n}'`).join(' ');
      console.log(await sh(`cd ${APP}/web/dist/assets 2>/dev/null && ls | grep -v ${keep} | xargs -r rm -f; ls ${APP}/web/dist/assets`));
    }

    console.log('\n[6/6] 重启服务并体检');
    await sh(`sudo systemctl restart ${SERVICE}`);
    await sleep(9000);
    const healthy = await healthCheck();
    if (!healthy) {
      console.log('\n!! 体检未通过，执行回滚');
      console.log(await sh(`sudo systemctl stop ${SERVICE} || true`));
      console.log(await sh(`cd ${APP} && tar -xzf ${APP}/backups/update-${STAMP}.tar.gz -C ${APP} && echo "  已回滚到本次备份"`));
      console.log(await sh(`sudo systemctl start ${SERVICE}`));
      await sleep(8000);
      const back = await healthCheck();
      console.log(back ? '  回滚成功，服务恢复正常' : '  ⚠ 回滚后仍未通过体检，请手动处理！');
      return;
    }
    console.log('\n全部完成 ✓');
    console.log(`外网访问：http://${HOST}`);
    console.log(`本次备份保留在云端 ${APP}/backups/update-${STAMP}.tar.gz`);
  });
}

async function healthCheck() {
  const idxHtml = await sh(`curl -s http://127.0.0.1:${3001}/ `);
  const m = idxHtml.match(/<title>([^<]*)<\/title>/);
  const refs = [...idxHtml.matchAll(/(?:src|href)="\.\/(assets\/[A-Za-z0-9._-]+)"/g)].map((x) => x[1]);
  let allOk = true;
  console.log(`  服务状态：${await sh(`systemctl is-active ${SERVICE}`)}`);
  console.log(`  首页标题：${m ? m[1] : '(未取到)'}`);
  for (const r of [...new Set(refs)]) {
    const code = await sh(`curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3001/${r}`);
    const good = code.trim() === '200';
    if (!good) allOk = false;
    console.log(`  ${good ? '✓' : '✗'} ${r} -> ${code.trim()}`);
  }
  return allOk;
}

async function check(manifest) {
  console.log('== 只验证不改动 ==');
  await healthCheck();
  console.log('\n本地/云端文件 md5 比对：');
  const remote = await sh(`cd ${APP} && md5sum ${manifest.slice(0, 40).map((f) => `"${f}"`).join(' ')} 2>/dev/null`);
  const map = Object.fromEntries(
    remote.split('\n').filter((l) => /^[0-9a-f]{32}/.test(l))
      .map((l) => { const [h, p] = l.trim().split(/\s+/); return [p.replace(`${APP}/`, ''), h]; }),
  );
  let same = 0, diff = 0;
  for (const rel of manifest) {
    const r = map[rel];
    if (!r) continue;
    const l = cryptoMd5(path.join(ROOT, rel));
    if (l === r) same++;
    else { diff++; console.log(`  ✗ ${rel}`); }
  }
  console.log(`  一致 ${same} 个，不一致 ${diff} 个`);
}

function cryptoMd5(f) {
  const crypto = require('node:crypto');
  return crypto.createHash('md5').update(fs.readFileSync(f)).digest('hex');
}

async function walked(fn) {
  try { await fn(); } finally { conn.end(); }
}

conn.on('ready', () => { main().catch((e) => { console.error('异常：', e.message); conn.end(); process.exit(1); }); });
conn.on('error', (e) => { console.error('连接失败：', e.message); process.exit(1); });

const auth = KEY
  ? { host: HOST, port: 22, username: USER, privateKey: fs.readFileSync(KEY), readyTimeout: 20000 }
  : { host: HOST, port: 22, username: USER, password: PASS, readyTimeout: 20000 };
conn.connect(auth);
