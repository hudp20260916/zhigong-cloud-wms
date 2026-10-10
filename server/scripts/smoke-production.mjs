/** P3 生产闭环冒烟：工单 → 领料/直扣 → 成品入库 → 防超产 / 局部缺料拦截 */
const BASE = 'http://127.0.0.1:3001/api';

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
const kettle = products.find((p) => p.name.includes('电热水壶'));
const dryer = products.find((p) => p.name.includes('电吹风'));
const mats = async () => Object.fromEntries((await call('GET', '/archive/materials/options', null, token)).map((m) => [m.name, m]));
const prodStock = async (id) => (await call('GET', '/inventory/products?pageSize=200', null, token)).list.find((p) => p.id === id).current_stock;

console.log('\n[1] 分支 A：工单未领料 → 去入库 → 成品入库（直接扣料）');
const woA = await call('POST', '/production/work-orders', {
  productId: dryer.id, planQty: 20, bomVersion: 'V1.0', planStart: '2026-10-09', planEnd: '2026-10-12',
}, token);
const woAList = (await call('GET', '/production/work-orders?pageSize=50', null, token)).list.find((w) => w.id === woA.id);
assert(woAList.canReceive === true, '未领料工单显示「去入库」入口');

const preA = await mats();
const preStockA = await prodStock(dryer.id);
const draftA = await call('GET', `/production/work-orders/${woA.id}/for-receipt`, null, token);
assert(draftA.receiptType === '成品入库（直接扣料）', '默认入库类型为「成品入库（直接扣料）」');
assert(draftA.suggestQty === 20, '自动带出计划产量');

await call('POST', '/production/receipts', {
  receiptType: '成品入库（直接扣料）', woId: woA.id, receiptDate: '2026-10-09',
  items: [{ productId: dryer.id, qty: 20 }],
}, token);
const postA = await mats();
assert(postA['直流电机'].current_stock === preA['直流电机'].current_stock - 20, `按 BOM 扣减子物料（电机 ${preA['直流电机'].current_stock} → ${postA['直流电机'].current_stock}）`);
assert(postA['外箱'].current_stock === preA['外箱'].current_stock - 2, `按装箱规格 10台/箱 扣外箱 2 个`);
assert((await prodStock(dryer.id)) === preStockA + 20, '成品库存 +20');

const woA2 = (await call('GET', '/production/work-orders?pageSize=50', null, token)).list.find((w) => w.id === woA.id);
assert(woA2.canReceive === false, '已全部入库的工单自动隐藏「去入库」');
assert(woA2.status === '已完工', `工单状态流转为 ${woA2.status}`);

console.log('\n[2] 分支 B：工单 → 领料（BOM + 虚拟件穿透） → 已领料入库');
const woB = await call('POST', '/production/work-orders', {
  productId: kettle.id, planQty: 30, bomVersion: 'V1.0',
}, token);
const preB = await mats();
const preStockB = await prodStock(kettle.id);
await call('POST', '/production/issues', {
  woId: woB.id, issueDate: '2026-10-09', produceQty: 30,
}, token);
const midB = await mats();
assert(midB['发热盘'].current_stock === preB['发热盘'].current_stock - 30, '虚拟件穿透：发热盘被扣减 30');
assert(midB['温控器'].current_stock === preB['温控器'].current_stock - 30, '虚拟件穿透：温控器被扣减 30');
assert(midB['发热组件'].current_stock === 0, '虚拟件本身不占库存、不被扣减');

const woB1 = (await call('GET', '/production/work-orders?pageSize=50', null, token)).list.find((w) => w.id === woB.id);
assert(woB1.issued_qty === 30, '工单累计领料合计 = 30');
assert(woB1.canReceive === false, '已领料工单在生产工单列表隐藏「去入库」（防重复扣料）');

const issues = (await call('GET', '/production/issues?pageSize=50', null, token)).list.filter((i) => i.wo_id === woB.id);
assert(issues.length === 1 && issues[0].canReceive === true, '领料列表显示「去入库」入口');
assert(issues[0].productName === '多功能电热水壶', '领料列表带出「主产品名称」列');

const draftB = await call('GET', `/production/issues/${issues[0].id}/for-receipt`, null, token);
assert(draftB.receiptType === '生产入库（已领料）', '入库类型锁定为「生产入库（已领料）」');
assert(draftB.lockQty === 30, '入库数量自动锁定 = min(领料数量, 可入库余量)');

const matsBeforeReceipt = await mats();
await call('POST', '/production/receipts', {
  receiptType: '生产入库（已领料）', woId: woB.id, issueId: issues[0].id,
  receiptDate: '2026-10-09', items: [{ productId: kettle.id, qty: draftB.lockQty }],
}, token);
const matsAfterReceipt = await mats();
assert(matsAfterReceipt['发热盘'].current_stock === matsBeforeReceipt['发热盘'].current_stock, '已领料类型不重复扣减子物料');
assert(matsAfterReceipt['外箱'].current_stock === matsBeforeReceipt['外箱'].current_stock - 5, '按 6台/箱 扣外箱 5 个');
assert((await prodStock(kettle.id)) === preStockB + 30, '成品库存 +30');

console.log('\n[3] 防超产：余量为 0 时拒绝再次入库');
let blocked = false;
try {
  await call('GET', `/production/issues/${issues[0].id}/for-receipt`, null, token);
} catch (e) {
  blocked = true;
  console.log(`  ✓ 拦截提示：${e.message}`);
}
assert(blocked, '可入库余量为 0 时禁止继续入库');

console.log('\n[4] 防超产：篡改入库数量被服务端拒绝');
const woC = await call('POST', '/production/work-orders', { productId: dryer.id, planQty: 10 }, token);
await call('POST', '/production/issues', { woId: woC.id, issueDate: '2026-10-09', produceQty: 10 }, token);
const issueC = (await call('GET', '/production/issues?pageSize=50', null, token)).list.find((i) => i.wo_id === woC.id);
let tamperBlocked = false;
try {
  await call('POST', '/production/receipts', {
    receiptType: '生产入库（已领料）', woId: woC.id, issueId: issueC.id,
    receiptDate: '2026-10-09', items: [{ productId: dryer.id, qty: 999 }],
  }, token);
} catch (e) {
  tamperBlocked = true;
  console.log(`  ✓ 拦截提示：${e.message}`);
}
assert(tamperBlocked, '服务端强制校验锁定数量，超量直接拒绝');

console.log('\n[5] 多成品同时入库：局部缺料独立拦截');
let shortageErr = null;
try {
  await call('POST', '/production/receipts', {
    receiptType: '成品入库（直接扣料）', receiptDate: '2026-10-09',
    items: [{ productId: kettle.id, qty: 5 }, { productId: dryer.id, qty: 99999 }],
  }, token);
} catch (e) {
  shortageErr = e;
}
assert(shortageErr?.code === 'SHORTAGE_PARTIAL', '返回 SHORTAGE_PARTIAL 局部缺料错误');
const shortage = shortageErr.detail.shortages[0];
console.log(`  缺料成品：${shortage.productName}，缺料明细 ${shortage.details.map((d) => `${d.materialName}(需${d.need}/存${d.available})`).join('、')}`);
assert(shortage.productName === '小型电吹风', '仅拦截短缺成品，不影响其他成品');

const beforeSkip = await prodStock(kettle.id);
await call('POST', '/production/receipts', {
  receiptType: '成品入库（直接扣料）', receiptDate: '2026-10-09',
  items: [{ productId: kettle.id, qty: 5 }, { productId: dryer.id, qty: 99999 }],
  skipProductIds: [dryer.id],
}, token);
assert((await prodStock(kettle.id)) === beforeSkip + 5, '剔除缺料成品后，库存充足的成品正常入库');

console.log('\n[6] 撤销成品入库，库存与工单已入库量回滚');
const receipts = await call('GET', '/production/receipts?pageSize=50', null, token);
const last = receipts.list.find((r) => r.receipt_type === '成品入库（直接扣料）' && r.status === '有效');
const beforeUndo = await prodStock(kettle.id);
await call('POST', `/production/receipts/${last.id}/undo`, null, token);
assert((await prodStock(kettle.id)) === beforeUndo - 5, '撤销后成品库存回退');

console.log('\n全部生产冒烟用例通过 ✅');
