/**
 * 领料上限校验 + 损耗 + 入库回归冒烟（干净库 3095）。
 * 验证三个异常已修复：
 *   ① 工单可无限领料 → 加「累计领料 ≤ 计划量」上限校验，超量被拦
 *   ② 领料超计划量未拦截、损耗虚高 → 源头拦截后损耗口径正确
 *   ③ 后续入库报错 → 领料不超计划后，入库可正常执行
 */
import { execSync } from 'node:child_process';

const BASE = process.env.API_BASE ?? 'http://127.0.0.1:3095/api';
let token = '';
let pass = 0;
let fail = 0;

function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
}

async function get(p) {
  const r = await fetch(`${BASE}${p}`, { headers: { Authorization: `Bearer ${token}` } });
  const j = await r.json().catch(() => ({ ok: false, message: `HTTP ${r.status}` }));
  if (!r.ok || j.ok === false) throw new Error(`${p} → ${j.message} ${JSON.stringify(j.detail ?? '')}`);
  return j.data;
}
async function post(p, b) {
  const r = await fetch(`${BASE}${p}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(b),
  });
  const j = await r.json().catch(() => ({ ok: false, message: `HTTP ${r.status}` }));
  if (!r.ok || j.ok === false) { const e = new Error(`${p} → ${j.message} ${JSON.stringify(j.detail ?? '')}`); e.code = j.code; throw e; }
  return j.data;
}

async function main() {
  const login = await post('/auth/login', { username: 'admin', password: 'admin12345' });
  token = login.token;
  console.log('登录成功\n');

  // 找有 BOM 的成品 + 它的工单（用 options 接口，返回纯数组）
  const products = await get('/archive/products/options');
  const mats = (await get('/archive/materials?pageSize=500')).list;
  let target = null;
  for (const p of products) {
    const detail = await get(`/archive/products/${p.id}`);
    if ((detail.bom ?? []).length) { target = p; break; }
  }
  if (!target) throw new Error('无有 BOM 的成品');  console.log('目标成品:', target.name, '（id=' + target.id + '）\n');

  // 建工单：计划 100
  const wo = await post('/production/work-orders', {
    woNo: `WO-SMOKE-${Date.now() % 100000}`,
    productId: target.id,
    planQty: 100,
    planStart: '2026-10-12',
    planEnd: '2026-10-12',
    remark: 'smoke',
  });
  const woId = wo.id;
  console.log(`工单 ${wo.woNo} 已建（计划 100），id=${woId}\n`);

  // ===== ① 领料上限校验 =====
  console.log('--- ① 领料上限校验 ---');
  // 先正常领 100（= 计划量）
  await post('/production/issues', { woId, issueDate: '2026-10-12', produceQty: 100, remark: '' });
  let ceil = await get(`/production/issues/ceiling/${woId}`);
  check('领满 100 后可领上限 = 0', ceil.ceiling === 0, `got ${JSON.stringify(ceil)}`);

  // 再领 50（超量）→ 应被拦
  let blocked = false;
  try {
    await post('/production/issues', { woId, issueDate: '2026-10-12', produceQty: 50, remark: '' });
    blocked = false;
  } catch (e) {
    blocked = true;
  }
  check('超量领 50 被拦截', blocked, '未拦截！');

  // 小量 1 也超（已领满）→ 同样拦
  let blockedSmall = false;
  try {
    await post('/production/issues', { woId, issueDate: '2026-10-12', produceQty: 1, remark: '' });
    blockedSmall = false;
  } catch (e) {
    blockedSmall = true;
  }
  check('已领满后任意再领（含 1）被拦截', blockedSmall, '未拦截！');

  // ===== ② 损耗数值正确 =====
  console.log('\n--- ② 损耗数值正确 ---');
  // 先入库 100 完工
  await post('/production/receipts', {
    receiptType: '生产入库（已领料）',
    woId,
    issueId: (await get(`/production/issues?woId=${woId}&pageSize=10`)).list[0]?.id,
    receiptDate: '2026-10-12',
    items: [{ productId: target.id, qty: 100 }],
  });
  let wo2 = (await get(`/production/work-orders/${woId}`));
  check('领 100 入 100，损耗 = 0', Number(wo2.loss_qty) === 0, `got ${wo2.loss_qty}`);
  check('状态 = 已完工', wo2.status === '已完工', `got ${wo2.status}`);

  // ===== ③ 入库恢复正常 =====
  console.log('\n--- ③ 入库恢复正常 ---');
  // 再来一单：计划 100，领 80（不超），入库 80 正常
  const wo2d = await post('/production/work-orders', {
    woNo: `WO-SMOKE2-${Date.now() % 100000}`,
    productId: target.id,
    planQty: 100,
    planStart: '2026-10-12',
    planEnd: '2026-10-12',
  });
  const issue80 = await post('/production/issues', { woId: wo2d.id, issueDate: '2026-10-12', produceQty: 80 });
  let recvOk = true;
  try {
    await post('/production/receipts', {
      receiptType: '生产入库（已领料）',
      woId: wo2d.id,
      issueId: issue80.id,
      receiptDate: '2026-10-12',
      items: [{ productId: target.id, qty: 80 }],
    });
  } catch (e) {
    recvOk = false;
    console.log('    入库报错:', e.message);
  }
  check('领 80（≤计划）入库 80 正常通过', recvOk, '入库仍报错！');

  const wo3 = await get(`/production/work-orders/${wo2d.id}`);
  check('领 80 入 80，损耗 = 0、未完工（received 80 < plan 100）',
    Number(wo3.loss_qty) === 0 && wo3.status === '生产中',
    `got loss=${wo3.loss_qty} status=${wo3.status}`);

  // 入库超量：在领 80 基础上入 100 → 应被防超产拦截（received 80 + 100 > issued 80）
  let overBlocked = false;
  try {
    await post('/production/receipts', {
      receiptType: '生产入库（已领料）',
      woId: wo2d.id,
      issueId: issue80.id,
      receiptDate: '2026-10-12',
      items: [{ productId: target.id, qty: 100 }],
    });
  } catch (e) {
    overBlocked = true;
  }
  check('入库超量（入 100 > 已领 80）被防超产拦截', overBlocked, '未拦截！');

  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('冒烟异常:', e.message);
  process.exit(1);
});
