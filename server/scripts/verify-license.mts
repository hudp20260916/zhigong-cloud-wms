/**
 * 授权内核验真（临时库直测，不走 HTTP）。
 *
 * 覆盖：试用期初始化 / 激活码签名校验 / 机器指纹匹配（三分量≥2）/ 篡改拦截 /
 *       宽限期与过期状态机 / 只读判定 / seats 账号数上限。
 *
 * 用法：npx tsx --tsconfig server/tsconfig.json server/scripts/verify-license.mts
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';

const DB_FILE = path.resolve(process.cwd(), 'server/data/verify-license.db');
for (const suffix of ['', '-wal', '-shm']) fs.rmSync(DB_FILE + suffix, { force: true });
process.env.DB_FILE = DB_FILE;

// 自签密钥对：公钥注入被测模块，私钥留在脚本里签激活码
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
process.env.LICENSE_PUBLIC_KEY_PEM = publicKey.export({ type: 'spki', format: 'pem' }).toString();

let pass = 0;
let fail = 0;

function check(name: string, cond: boolean, extra = '') {
  if (cond) {
    pass += 1;
    console.log(`✅ PASS: ${name}${extra ? `（${extra}）` : ''}`);
  } else {
    fail += 1;
    console.log(`❌ FAIL: ${name}${extra ? `（${extra}）` : ''}`);
  }
}

function isoDay(offsetDays: number): string {
  return new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

function issue(payload: Record<string, unknown>, priv = privateKey): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.sign('sha256', Buffer.from(body), priv).toString('base64url');
  return `${body}.${sig}`;
}

const { db, migrate } = await import('../src/db/index.js');
const license = await import('../src/core/license.js');

migrate();
license.ensureLicenseRow();

// ---- 1. 试用期 ----
let st = license.licenseState();
check('首次启动进入试用期', st.status === 'trial', st.message);
check('试用剩余约 30 天', st.daysLeft !== null && st.daysLeft >= 29 && st.daysLeft <= 30, `${st.daysLeft}`);
check('试用期满额可写', license.writeAllowed() === true);
check('机器指纹有 3 个分量', st.fingerprint.length === 3);

// ---- 2. 机器不匹配的激活码 ----
const wrongMachine = issue({
  no: 'L-TEST-1',
  licensee: '别家厂',
  plan: 'full',
  seats: null,
  expire: isoDay(365),
  fp: ['0'.repeat(32), '1'.repeat(32), '2'.repeat(32)],
});
let threw = '';
try {
  license.activate(wrongMachine);
} catch (e: any) {
  threw = e.message;
}
check('异机激活码被拒', threw.includes('机器不匹配'), threw);

// ---- 3. 篡改签名 ----
const goodPayload = {
  no: 'L-TEST-2',
  licensee: '本机测试厂',
  plan: 'full' as const,
  seats: null,
  expire: isoDay(365),
  fp: license.fingerprintComponents(),
};
const good = issue(goodPayload);
const tampered = `${good.split('.')[0]}.${good.split('.')[1].slice(0, -4)}AAAA`;
threw = '';
try {
  license.parseLicenseKey(tampered);
} catch (e: any) {
  threw = e.message;
}
check('篡改签名被识别', threw.includes('签名'), threw);

// ---- 4. 正常激活 ----
st = license.activate(good);
check('激活成功进入已授权', st.status === 'active', st.message);
check('激活信息落库', st.licensee === '本机测试厂' && st.plan === 'full' && st.expireAt === isoDay(365));

// ---- 5. seats 上限：临时插入 2 个 active 账号（本脚本不跑种子） ----
db.prepare(
  `INSERT INTO users (username, password_hash, display_name, role, status, session_version, user_no, created_at, updated_at)
   VALUES ('seat1','x','占位1','viewer','active',1,'U9001',?,?),('seat2','x','占位2','viewer','active',1,'U9002',?,?)`,
).run(new Date().toISOString(), new Date().toISOString(), new Date().toISOString(), new Date().toISOString());
const seatFull = license.seatsAvailable();
check('未配置 seats 不限制', seatFull.ok === true);
st = license.activate(issue({ ...goodPayload, no: 'L-TEST-3', seats: 2 }));
const seatBlocked = license.seatsAvailable();
check('seats=2 时新增被拦（已有 2 个启用账号）', seatBlocked.ok === false, seatBlocked.message ?? '');
st = license.activate(issue({ ...goodPayload, no: 'L-TEST-4', seats: 3 }));
check('seats=3 时放行', license.seatsAvailable().ok === true);

// ---- 6. 宽限期（过期 3 天，grace 7 天） ----
st = license.activate(issue({ ...goodPayload, no: 'L-TEST-5', expire: isoDay(-3) }));
check('过期 3 天进入宽限期', st.status === 'grace', st.message);
check('宽限期内仍可写', license.writeAllowed() === true);

// ---- 7. 彻底过期（过期 30 天）→ 只读 ----
st = license.activate(issue({ ...goodPayload, no: 'L-TEST-6', expire: isoDay(-30) }));
check('过期超宽限转为只读', st.status === 'expired', st.message);
check('过期后禁止写操作', license.writeAllowed() === false);

// ---- 8. 重新激活自救 ----
st = license.activate(issue({ ...goodPayload, no: 'L-TEST-7', expire: isoDay(365) }));
check('重新激活后恢复可写', st.status === 'active' && license.writeAllowed() === true);

db.close();
for (const suffix of ['', '-wal', '-shm']) fs.rmSync(DB_FILE + suffix, { force: true });

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
if (fail > 0) process.exit(1);
