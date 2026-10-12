/**
 * 不良品出库（领料来源）冒烟（干净库 3095）。
 * 场景：
 *  1. 工单计划 100 → 领料 100（issued_qty=100）
 *  2. 领料来源不良品出库：物料 A 退 2 台对应量，produceQty=2 → issued_qty 收敛为 98
 *  3. 手工拣选不良品出库：不影响 issued_qty（仍 98）
 *  4. 撤销领料来源不良品出库 → issued_qty 恢复 100
 *  5. 入库锁定量验证：领料来源出库 2 台后，入库锁定 = 98
 */
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

  // 1. 找有 BOM 的成品
  const products = (await get('/archive/products?pageSize=200')).list;
  let target = null;
  for (const p of products) {
    const d = await get(`/archive/products/${p.id}`);
    if (d.bom && d.bom.length > 0) { target = { product: p, bom: d.bom }; break; }
  }
  if (!target) { console.log('演示数据无 BOM 成品，跳过'); process.exit(0); }
  console.log(`测试成品：${target.product.code} ${target.product.name}\n`);

  // 2. 建工单 + 领料 100
  const wo = await post('/production/work-orders', { productId: target.product.id, planQty: 100, bomVersion: 'V1.0' });
  const woId = wo.id;
  const issue = await post('/production/issues', { woId, issueDate: '2026-10-12', produceQty: 100 });
  const issueId = issue.id;
  let w = await get(`/production/work-orders/${woId}`);
  check('领料 100 后 issued_qty=100', Number(w.issued_qty) === 100, `issued=${w.issued_qty}`);

  // 3. 拉可退明细
  const r0 = await get(`/production/returns/returnable/${issueId}`);
  const firstItem = r0.items[0];
  const matQtyPerUnit = Math.round(Number(firstItem.issued_qty) / 100 * 10000) / 10000;
  const stockBefore = (await get(`/inventory/materials?keyword=${encodeURIComponent(firstItem.code)}&pageSize=1`)).list[0]?.current_stock;

  // 4. 领料来源不良品出库：物料 A 退 2 台对应量（produceQty=2）
  const outQty = Math.round(matQtyPerUnit * 2 * 10000) / 10000;
  const outRes = await post('/warehouse/defectives', {
    outDate: '2026-10-12',
    sourceType: 'issue',
    issueId,
    produceQty: 2,
    items: [{ materialId: firstItem.material_id, qty: outQty, reason: '制程损坏' }],
  });
  check('领料来源不良品出库成功', !!outRes.id);

  // 5. issued_qty 应收敛为 98
  w = await get(`/production/work-orders/${woId}`);
  check('领料来源出库后 issued_qty 收敛为 98', Math.abs(Number(w.issued_qty) - 98) < 1e-6, `issued=${w.issued_qty}`);

  // 6. 物料库存被扣
  const stockMid = (await get(`/inventory/materials?keyword=${encodeURIComponent(firstItem.code)}&pageSize=1`)).list[0]?.current_stock;
  check(
    `物料库存扣减 ${outQty}`,
    Math.abs(Number(stockMid) - (Number(stockBefore) - outQty)) < 1e-6,
    `before=${stockBefore} mid=${stockMid}`,
  );

  // 7. 手工拣选不良品出库：不影响 issued_qty
  const manualRes = await post('/warehouse/defectives', {
    outDate: '2026-10-12',
    sourceType: 'manual',
    produceQty: 0,
    items: [{ materialId: firstItem.material_id, qty: 1, reason: '仓储破损' }],
  });
  check('手工拣选出库成功', !!manualRes.id);
  w = await get(`/production/work-orders/${woId}`);
  check('手工拣选不影响 issued_qty（仍 98）', Math.abs(Number(w.issued_qty) - 98) < 1e-6, `issued=${w.issued_qty}`);

  // 8. 撤销领料来源不良品出库 → issued_qty 恢复 100
  await post(`/warehouse/defectives/${outRes.id}/undo`);
  w = await get(`/production/work-orders/${woId}`);
  check('撤销领料来源出库后 issued_qty 恢复 100', Math.abs(Number(w.issued_qty) - 100) < 1e-6, `issued=${w.issued_qty}`);

  // 9. 入库锁定量：出库 2 台后应为 98
  // 先重新做一遍出库（已撤销了）
  await post('/warehouse/defectives', {
    outDate: '2026-10-12', sourceType: 'issue', issueId, produceQty: 2,
    items: [{ materialId: firstItem.material_id, qty: outQty, reason: '制程损坏' }],
  });
  w = await get(`/production/work-orders/${woId}`);
  check('再次出库后 issued_qty=98', Math.abs(Number(w.issued_qty) - 98) < 1e-6, `issued=${w.issued_qty}`);
  const forR = await get(`/production/issues/${issueId}/for-receipt`);
  check('入库锁定量=98', Math.abs(Number(forR.lockQty) - 98) < 1e-6, `lockQty=${forR.lockQty}`);

  // 10. 超额出库被拦截（produceQty=100 > 剩余可退 100-2=98）
  try {
    await post('/warehouse/defectives', {
      outDate: '2026-10-12', sourceType: 'issue', issueId, produceQty: 100,
      items: [{ materialId: firstItem.material_id, qty: 1, reason: '其他' }],
    });
    check('超额对应成品数量被拦截', false, '未拦截');
  } catch (e) {
    check('超额对应成品数量被拦截', /超过该领料单剩余可退成品量/.test(e.message), e.message);
  }

  // 11. 领料来源出库：物料不属于该领料单时拦截
  try {
    await post('/warehouse/defectives', {
      outDate: '2026-10-12', sourceType: 'issue', issueId, produceQty: 1,
      items: [{ materialId: 999999, qty: 1, reason: '其他' }],
    });
    check('非领料单物料被拦截', false, '未拦截');
  } catch (e) {
    check('非领料单物料被拦截', /不属于来源领料单/.test(e.message), e.message);
  }

  // 12. 列表带出来源领料单信息
  const list = (await get('/warehouse/defectives?pageSize=50')).list;
  const issueDoc = list.find((x) => x.source_type === 'issue' && x.status === '有效');
  check('列表带出来源领料单号', issueDoc?.source_issue_no?.length > 0, `doc=${JSON.stringify(issueDoc?.source_issue_no)}`);

  console.log(`\n结果：通过 ${pass}，失败 ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('冒烟失败：', e.message, e.stack); process.exit(1); });
