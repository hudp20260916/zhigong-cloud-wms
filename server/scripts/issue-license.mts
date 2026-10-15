/**
 * 离线签发授权激活码。
 *
 * 用法（在项目根目录）：
 *   npx tsx --tsconfig server/tsconfig.json server/scripts/issue-license.mts \
 *     --licensee "佛山市某某家电有限公司" --plan standard --seats 10 \
 *     --expire 2027-10-15 --fingerprint <指纹1>,<指纹2>,<指纹3>
 *
 *   # 本机自签自测（指纹取当前机器，适合开发验证）
 *   npx tsx --tsconfig server/tsconfig.json server/scripts/issue-license.mts \
 *     --licensee "测试" --plan full --seats 0 --expire 2027-12-31 --auto
 *   （seats 0 = 不限）
 *
 * 私钥在 deploy/keys/license-private.pem（已 gitignore）；客户机器的指纹
 * 从「系统管理 → 系统参数 → 授权信息」或 GET /api/auth/license 拿。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** 无值开关（如 --auto）：不能用 arg()，否则它落在末尾时取不到值会被判为未传 */
function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

const licensee = arg('licensee');
const plan = arg('plan') ?? 'standard';
const seats = Number(arg('seats') ?? 0) || 0;
const expire = arg('expire');
const fpArg = arg('fingerprint');
const auto = hasFlag('auto');

if (!licensee || !expire) {
  console.error('缺少参数：--licensee 与 --expire 为必填；指纹用 --fingerprint h1,h2,h3 或 --auto');
  process.exit(1);
}

// ---- 指纹：--auto 取本机；否则解析逗号分隔的三分量 ----
let fp: string[];
if (auto) {
  // 与 core/license.ts 相同的算法，独立实现避免把服务端代码整个拉进来
  const os = await import('node:os');
  const h = (s: string) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 32);
  let mac = 'no-mac';
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni && !ni.internal && ni.mac && ni.mac !== '00:00:00:00:00:00') mac = ni.mac;
    }
  }
  fp = [
    h(`hostname|${os.hostname()}`),
    h(`mac|${mac}`),
    h(`platform|${os.platform()}-${os.arch()}-${os.cpus()[0]?.model ?? 'cpu'}`),
  ];
} else {
  fp = String(fpArg ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (fp.length !== 3) {
    console.error('指纹必须是 3 个分量（从 GET /api/auth/license 的 fingerprint 字段复制）');
    process.exit(1);
  }
}

// ---- 签名 ----
const keyPath = path.resolve(process.cwd(), 'deploy/keys/license-private.pem');
if (!fs.existsSync(keyPath)) {
  console.error(`找不到私钥 ${keyPath}（该文件不入仓库，只在签发机上存在）`);
  process.exit(1);
}
const priv = fs.readFileSync(keyPath, 'utf8');

const payload = {
  no: `L${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`,
  licensee,
  plan,
  seats: seats > 0 ? seats : null,
  expire,
  fp,
};
const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
const sig = crypto.sign('sha256', Buffer.from(body), priv).toString('base64url');

console.log('=== 授权信息 ===');
console.log(JSON.stringify(payload, null, 2));
console.log('\n=== 激活码（整行复制给客户） ===');
console.log(`${body}.${sig}`);
