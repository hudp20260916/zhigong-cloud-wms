/**
 * 授权链路端到端冒烟（必须干净库 + 独立端口）。
 *
 *   rm -f server/data/lic.db*
 *   DB_FILE=server/data/lic.db PORT=3099 npx tsx server/src/index.ts &
 *   node server/scripts/smoke-license.mjs
 *
 * 覆盖：免登录读状态 / 激活接口权限与密码无关（纯权限点）/ 异机码被拒 /
 *       seats 拦新增账号 / 过期只读（写 403、查询放行）/ 重新激活自救。
 */
const BASE = process.env.BASE ?? 'http://127.0.0.1:3099/api';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? 'admin12345'; // 与 seed.ts 的 DEFAULT_PASSWORD 保持一致
const crypto = await import('node:crypto');
const fs = await import('node:fs');

let pass = 0;
let fail = 0;

function check(name, cond, extra = '') {
  if (cond) {
    pass += 1;
    console.log(`✅ PASS: ${name}${extra ? `（${extra}）` : ''}`);
  } else {
    fail += 1;
    console.log(`❌ FAIL: ${name}${extra ? `（${extra}）` : ''}`);
  }
}

async function call(method, path, body, token) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

function isoDay(offset) {
  return new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
}

function issue(payload) {
  const priv = fs.readFileSync('deploy/keys/license-private.pem', 'utf8');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.sign('sha256', Buffer.from(body), priv).toString('base64url');
  return `${body}.${sig}`;
}

async function main() {
  // 0. 免登录状态接口
  const anon = await call('GET', '/auth/license');
  check('未登录可读授权状态', anon.json?.ok === true, anon.json?.data?.status);
  check('首次启动是试用期', anon.json.data.status === 'trial');
  const fp = anon.json.data.fingerprint;
  check('状态接口带机器指纹', Array.isArray(fp) && fp.length === 3);

  const login = await call('POST', '/auth/login', { username: 'admin', password: ADMIN_PASSWORD });
  const token = login.json.data.token;

  // 1. 激活接口权限：无 token 被拒
  const noTok = await call('POST', '/auth/license/activate', { licenseKey: 'x.y' });
  check('激活需要登录', noTok.status === 401, `HTTP ${noTok.status}`);

  // 2. 异机激活码被拒（指纹乱填）
  const wrong = await call('POST', '/auth/license/activate', {
    licenseKey: issue({ no: 'L-E2E-0', licensee: '异机', plan: 'full', seats: null, expire: isoDay(365), fp: ['a'.repeat(32), 'b'.repeat(32), 'c'.repeat(32)] }),
  }, token);
  check('异机激活码被拒', wrong.json?.ok === false, wrong.json?.message ?? '');

  // 3. 正常激活（seats=9：7 内置 + 2 个测试账号）
  const ok1 = await call('POST', '/auth/license/activate', {
    licenseKey: issue({ no: 'L-E2E-1', licensee: '端到端测试厂', plan: 'standard', seats: 9, expire: isoDay(365), fp }),
  }, token);
  check('本机激活码激活成功', ok1.json?.data?.status === 'active', ok1.json?.message ?? '');
  check('激活信息返回', ok1.json?.data?.licensee === '端到端测试厂' && ok1.json?.data?.seats === 9);

  // 4. seats：建 2 个测试账号后到 9 个，第 3 个被拦
  for (const name of ['e2e01', 'e2e02']) {
    await call('POST', '/system/users', { username: name, displayName: name, role: 'viewer', status: 'active', password: 'e2e12345' }, token);
  }
  const over = await call('POST', '/system/users', { username: 'e2e03', displayName: 'e2e03', role: 'viewer', status: 'active', password: 'e2e12345' }, token);
  check('seats 超限拦截新增账号', over.json?.ok === false, over.json?.message ?? '');

  // 5. 过期 30 天 → 只读：登录仍可，写 403，查询放行
  await call('POST', '/auth/license/activate', {
    licenseKey: issue({ no: 'L-E2E-2', licensee: '端到端测试厂', plan: 'standard', seats: null, expire: isoDay(-30), fp }),
  }, token);
  const st = await call('GET', '/auth/license');
  check('状态转为已过期', st.json.data.status === 'expired');

  const writeTry = await call('POST', '/system/users', { username: 'e2e04', displayName: 'e2e04', role: 'viewer', status: 'active' }, token);
  check('只读模式下写操作 403', writeTry.status === 403, writeTry.json?.message ?? '');
  const readTry = await call('GET', '/system/users', undefined, token);
  check('只读模式下查询正常', readTry.json?.ok === true);
  check('只读模式下登录正常', (await call('POST', '/auth/login', { username: 'admin', password: ADMIN_PASSWORD })).json?.ok === true);

  // 6. 重新激活自救
  const revive = await call('POST', '/auth/license/activate', {
    licenseKey: issue({ no: 'L-E2E-3', licensee: '端到端测试厂', plan: 'standard', seats: null, expire: isoDay(365), fp }),
  }, token);
  check('重新激活自救成功', revive.json?.data?.status === 'active');
  const writeAgain = await call('POST', '/system/users', { username: 'e2e04', displayName: 'e2e04', role: 'viewer', status: 'active', password: 'e2e12345' }, token);
  check('恢复后可写', writeAgain.json?.ok === true, writeAgain.json?.message ?? '');

  // 7. 激活留痕
  const logs = (await call('GET', '/system/logs?page=1&pageSize=20', undefined, token)).json.data;
  check('激活动作有日志', (logs.list ?? []).some((l) => l.action === '激活授权'));

  console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
