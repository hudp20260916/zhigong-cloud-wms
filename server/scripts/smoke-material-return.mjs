/**
 * 生产退料场景冒烟（干净库 3095）。
 * 场景：工单计划 100 → 领料 100 → 实产 98 停工 → 退 2 台的料 → 只能入库 98。
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

  // 1. 找一个有 BOM 的成品
  const products = (await get('/archive/products?pageSize=200')).list;
  const mats = (await get('/archive/materials?pageSize=500')).list;
  let target = null;
  for (const p of products) {
    const d = await get(`/archive/products/${p.id}`);
    if (d.bom && d.bom.length > 0) { target = { product: p, bom: d.bom }; break; }
  }
  if (!target) { console.log('演示数据无 BOM 成品，跳过'); process.exit(0); }
  console.log(`测试成品：${target.product.code} ${target.product.name}，BOM ${target.bom.length} 项\n`);

  // 2. 建工单：计划 100
  const wo = await post('/production/work-orders', { productId: target.product.id, planQty: 100, bomVersion: 'V1.0' });
  const woId = wo.id;
  let w = await get(`/production/work-orders/${woId}`);
  check('工单创建，计划 100，未开工', Number(w.plan_qty) === 100 && w.status === '未开工', w.status);

  // 3. 领料 100（按 BOM 自动展开）
  const issue = await post('/production/issues', { woId, issueDate: '2026-10-12', produceQty: 100 });
  const issueId = issue.id;
  w = await get(`/production/work-orders/${woId}`);
  check('领料 100 后 issued_qty=100', Number(w.issued_qty) === 100, `issued=${w.issued_qty}`);

  // 记录领料后某物料库存
  const r0 = await get(`/production/returns/returnable/${issueId}`);
  check('可退明细带出（原领料单）', r0.items.length > 0, `items=${r0.items.length}`);
  check('未投产时可退成品上限=100', Number(r0.maxReturnable) === 100, `max=${r0.maxReturnable}`);

  const firstItem = r0.items[0];
  const stockBefore = (await get(`/inventory/materials?keyword=${encodeURIComponent(firstItem.code)}&pageSize=1`)).list[0]?.current_stock;

  // 4. 实产 98 → 退 2 台的料（按原量：每条明细退 issuedQty/100*2）
  const returnItems = r0.items.map((it) => ({
    materialId: it.material_id,
    srcItemId: it.src_item_id,
    qty: Math.round((Number(it.issued_qty) / 100) * 2 * 10000) / 10000,
  })).filter((it) => it.qty > 0);

  const ret = await post('/production/returns', {
    issueId,
    returnDate: '2026-10-12',
    returnQty: 2,
    items: returnItems,
  });
  check('退料单创建成功', !!ret.id);

  // 5. 核减校验：issued_qty 应从 100 → 98
  w = await get(`/production/work-orders/${woId}`);
  check('退料后 issued_qty 核减为 98', Math.abs(Number(w.issued_qty) - 98) < 1e-6, `issued=${w.issued_qty}`);

  // 6. 物料库存回补校验
  const stockAfter = (await get(`/inventory/materials?keyword=${encodeURIComponent(firstItem.code)}&pageSize=1`)).list[0]?.current_stock;
  const expectBack = returnItems.find((x) => x.materialId === firstItem.material_id)?.qty ?? 0;
  check(
    `物料「${firstItem.name}」库存回补 ${expectBack}`,
    Math.abs(Number(stockAfter) - (Number(stockBefore) + expectBack)) < 1e-6,
    `before=${stockBefore} after=${stockAfter}`,
  );

  // 7. 可退上限应变 98
  const r1 = await get(`/production/returns/returnable/${issueId}`);
  check('退料后可退上限收敛为 98', Math.abs(Number(r1.maxReturnable) - 98) < 1e-6, `max=${r1.maxReturnable}`);

  // 8. 尝试超额退料（再退 5 台 > 剩余可退 98？不，98 是上限；试退超过 98）
  try {
    await post('/production/returns', {
      issueId, returnDate: '2026-10-12', returnQty: 99,
      items: [{ materialId: firstItem.material_id, srcItemId: firstItem.src_item_id, qty: 1 }],
    });
    check('超额退料被拦截', false, '未拦截');
  } catch (e) {
    check('超额退料被拦截', /超过可退上限/.test(e.message), e.message);
  }

  // 9. 入库上限：应等于 98（可入库余量）
  const forR = await get(`/production/issues/${issueId}/for-receipt`);
  check('领料单去入库锁定数量=98', Math.abs(Number(forR.lockQty) - 98) < 1e-6, `lockQty=${forR.lockQty}`);

  // 10. 入库 98 成功
  await post('/production/receipts', {
    receiptType: '生产入库（已领料）',
    woId, issueId, receiptDate: '2026-10-12',
    items: [{ productId: target.product.id, qty: 98 }],
  });
  w = await get(`/production/work-orders/${woId}`);
  check('入库 98 后 received_qty=98', Math.abs(Number(w.received_qty) - 98) < 1e-6, `received=${w.received_qty}`);

  // 11. 数据一致性：领料 - 退料 - 入库 = 0（无残留）
  const r2 = await get(`/production/returns/returnable/${issueId}`);
  check('收工后可退上限=0', Math.abs(Number(r2.maxReturnable)) < 1e-6, `max=${r2.maxReturnable}`);

  // 12. 尝试入库 100（超产）应失败
  try {
    await post('/production/receipts', {
      receiptType: '生产入库（已领料）',
      woId, issueId, receiptDate: '2026-10-12',
      items: [{ productId: target.product.id, qty: 2 }],
    });
    check('入库超余量被拦截', false, '未拦截');
  } catch (e) {
    check('入库超余量被拦截', true, e.message);
  }

  console.log(`\n结果：通过 ${pass}，失败 ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('冒烟失败：', e.message); process.exit(1); });
