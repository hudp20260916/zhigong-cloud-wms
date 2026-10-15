/**
 * 远程激活授权（一次性运维脚本）。
 * 用法：
 *   node deploy/activate-cloud.mjs <激活码>
 *   PASSWORD=xxx node deploy/activate-cloud.mjs <激活码>
 */
const BASE = process.env.BASE || 'http://106.55.93.200/api';
const USER = process.env.USERNAME || 'admin';
const PASSWORD = process.env.PASSWORD || '';
const key = process.argv[2];

if (!key || !PASSWORD) {
  console.error('用法：PASSWORD=<管理员密码> node deploy/activate-cloud.mjs <激活码>');
  process.exit(1);
}

const j = async (url, init) => {
  const r = await fetch(url, init);
  const t = await r.text();
  try { return { status: r.status, body: JSON.parse(t) }; } catch { return { status: r.status, body: t }; }
};

const login = await j(`${BASE}/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: USER, password: PASSWORD }),
});
if (!login.body?.ok) {
  console.error('登录失败：', login.status, JSON.stringify(login.body));
  process.exit(1);
}
const token = login.body.data?.token;
console.log('登录成功');

const act = await j(`${BASE}/auth/license/activate`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
  body: JSON.stringify({ licenseKey: key }),
});
console.log('激活返回：', act.status, JSON.stringify(act.body));

const st = await j(`${BASE}/auth/license`);
console.log('当前状态：', JSON.stringify(st.body?.data, null, 2));
