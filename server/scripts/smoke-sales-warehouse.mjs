/** P4 销售与仓储作业冒烟 */
const BASE = process.env.API_BASE ?? 'http://127.0.0.1:3001/api';

async function call(method, path, body, token) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.ok === false) {
    const err = new Error(`${method} ${path} -> ${res.status} ${json.message ?? ''}`);
    err.code = json.code;
    err.detail = json.detail;
    throw err;
  }
  return json.data;
}

function assert(cond, msg) {
  if (!cond) throw new Error(`断言失败：${msg}`);
  console.log(`  ✓ ${msg}`);
}

const login = await call('POST', '/auth/login', { username: 'admin', password: 'admin12345' });
const token = login.token;
const products = await call('GET', '/archive/products/options', null, token);
const dryer = products.find((p) => p.name.includes('电吹风'));
const kettle = products.find((p) => p.name.includes('电热水壶'));
const mats = async () => Object.fromEntries((await call('GET', '/archive/materials/options', null, token)).map((m) => [m.name, m]));
const prodStock = async (id) => (await call('GET', '/inventory/products?pageSize=200', null, token)).list.find((p) => p.id === id).current_stock;
const customers = await call('GET', '/archive/customers?pageSize=5', null, token);

console.log('\n[1] 销售开单：库存不足时拦截');
let blocked = false;
try {
  await call('POST', '/sale/orders', {
    customerId: customers.list[0].id, orderDate: '2026-10-09',
    items: [{ productId: dryer.id, qty: 999999, price: 100 }],
  }, token);
} catch (e) { blocked = true; console.log(`  ✓ ${e.message}`); }
assert(blocked, '开单校验库存，库存不足拒绝开单');

console.log('\n[2] 销售开单 → 出库 → 撤销回滚');
const order = await call('POST', '/sale/orders', {
  customerId: customers.list[0].id, orderDate: '2026-10-09',
  items: [{ productId: dryer.id, qty: 10, price: 99 }],
}, token);
const beforeOut = await prodStock(dryer.id);
const delivery = await call('POST', '/sale/deliveries', {
  orderId: order.id, deliveryDate: '2026-10-09',
}, token);
assert((await prodStock(dryer.id)) === beforeOut - 10, `出库扣减成品库存（${beforeOut} → ${beforeOut - 10}）`);
const orderAfter = await call('GET', `/sale/orders/${order.id}`, null, token);
assert(orderAfter.order.status === '已出库', '销售单状态流转为已出库');

await call('POST', `/sale/deliveries/${delivery.id}/undo`, null, token);
assert((await prodStock(dryer.id)) === beforeOut, '撤销出库后库存回补');
const orderBack = await call('GET', `/sale/orders/${order.id}`, null, token);
assert(orderBack.order.status === '待出库', '撤销后恢复待出库状态');

console.log('\n[3] 销售退货增加成品库存');
const beforeReturn = await prodStock(kettle.id);
await call('POST', '/sale/returns', {
  orderId: order.id, customerId: customers.list[0].id, returnDate: '2026-10-09',
  items: [{ productId: kettle.id, qty: 3, price: 120 }],
}, token);
assert((await prodStock(kettle.id)) === beforeReturn + 3, '退货后成品库存 +3');

console.log('\n[4] 物料销售与不良品出库');
const pre = await mats();
await call('POST', '/warehouse/material-sales', {
  customerId: customers.list[0].id, saleDate: '2026-10-09',
  items: [{ materialId: pre['螺丝包'].id, qty: 20, price: 2 }],
}, token);
assert((await mats())['螺丝包'].current_stock === pre['螺丝包'].current_stock - 20, '物料销售扣减物料库存 20');

const pre2 = await mats();
await call('POST', '/warehouse/defectives', {
  outDate: '2026-10-09',
  items: [{ materialId: pre2['螺丝包'].id, qty: 5, reason: '来料不良' }],
}, token);
assert((await mats())['螺丝包'].current_stock === pre2['螺丝包'].current_stock - 5, '不良品出库扣减物料库存 5');

console.log('\n[5] 库存盘点：录入 → 锁定出入库 → 审核生成调整流水');
const beforeCheck = (await mats())['说明书'].current_stock;
const check = await call('POST', '/warehouse/checks', {
  checkDate: '2026-10-09',
  items: [{ itemType: 'material', itemId: (await mats())['说明书'].id, actualQty: beforeCheck + 7 }],
}, token);

let locked = false;
try {
  await call('POST', '/warehouse/defectives', {
    outDate: '2026-10-09',
    items: [{ materialId: (await mats())['说明书'].id, qty: 1, reason: '盘点中尝试出库' }],
  }, token);
} catch (e) { locked = true; console.log(`  ✓ ${e.message}`); }
assert(locked, '盘点中该物料出入库被锁定');

await call('POST', `/warehouse/checks/${check.id}/audit`, null, token);
assert((await mats())['说明书'].current_stock === beforeCheck + 7, `审核后按差异调整库存（${beforeCheck} → ${beforeCheck + 7}）`);

const ledger = await call('GET', '/inventory/ledger?bizType=盘点调整&pageSize=10', null, token);
assert(ledger.list.length > 0, '盘点审核自动生成调整流水');

console.log('\n[6] 模拟出货与排产建议');
const sim = await call('POST', '/warehouse/simulate', {
  items: [{ productId: kettle.id, qty: 200 }, { productId: dryer.id, qty: 5 }],
}, token);
console.log(`  成品：${sim.products.map((p) => `${p.name}(需${p.requireQty}/存${p.stock}/待产${p.needProduce})`).join('、')}`);
console.log(`  物料缺口种类：${sim.summary.shortageKinds} / ${sim.summary.materialKinds}`);
assert(sim.products.find((p) => p.productId === dryer.id).needProduce === 0, '成品库存充足时无需排产');
assert(sim.products.find((p) => p.productId === kettle.id).needProduce > 0, '成品库存不足时计算待产量');
assert(sim.materials.every((m) => m.needQty > 0), '按待产量展开 BOM 计算子物料需求');

const woRes = await call('POST', '/warehouse/simulate/to-work-orders', {
  items: sim.products.filter((p) => p.needProduce > 0).map((p) => ({ productId: p.productId, planQty: p.needProduce })),
}, token);
assert(woRes.count > 0, `一键生成 ${woRes.count} 张生产工单`);

console.log('\n[7] 库存预警看板四级卡片');
const alarm = await call('GET', '/warehouse/alarm?itemType=material', null, token);
console.log(`  ${JSON.stringify(alarm.cards)}`);
assert('安全库存告警' in alarm.cards && '呆滞库存' in alarm.cards, '返回四级预警卡片统计');
assert(Array.isArray(alarm.list), '返回预警明细列表');

console.log('\n全部销售与仓储冒烟用例通过 ✅');
