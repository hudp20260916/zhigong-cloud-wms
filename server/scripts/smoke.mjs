/** 采购闭环端到端冒烟：拆单 → 入库 → 撤销回滚，校验库存与台账一致性 */
const BASE = 'http://127.0.0.1:3001/api';

async function call(method, path, body, token) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (!res.ok || json.ok === false) {
    throw new Error(`${method} ${path} -> ${res.status} ${json.message ?? JSON.stringify(json)}`);
  }
  return json.data;
}

function assert(cond, msg) {
  if (!cond) throw new Error(`断言失败：${msg}`);
  console.log(`  ✓ ${msg}`);
}

const login = await call('POST', '/auth/login', { username: 'admin', password: 'admin12345' });
const token = login.token;

console.log('\n[1] 读取物料档案');
const materials = await call('GET', '/archive/materials/options', null, token);
const byName = Object.fromEntries(materials.map((m) => [m.name, m]));
const wire = byName['电源线'];
const motor = byName['直流电机'];
const screw = byName['螺丝包'];
console.log(`  电源线 id=${wire.id} 库存=${wire.current_stock} 默认供应商=${wire.default_supplier_id}`);
console.log(`  螺丝包 id=${screw.id} 库存=${screw.current_stock} 默认供应商=${screw.default_supplier_id}`);

console.log('\n[2] 直接采购两种不同供应商的物料（应自动拆单）');
const created = await call('POST', '/purchase/orders', {
  mode: 'direct',
  items: [
    { materialId: wire.id, qty: 100, price: 3.5 },
    { materialId: screw.id, qty: 200, price: 1.2 },
  ],
  orderDate: '2026-10-09',
  expectedDate: '2026-10-15',
  remark: '冒烟测试',
}, token);
console.log(`  父单号=${created.orderNo} 生成单据数=${created.orders.length} 摘要=${created.summary}`);
assert(created.orders.length === 3, '生成一个父单 + 两个按供应商拆分的子单');

const childOrder = created.orders.find((o) => o.supplierId === wire.default_supplier_id);
assert(!!childOrder, '存在电源线对应供应商的子单');

console.log('\n[3] 去入库预填');
const pending = await call('GET', `/purchase/orders/${childOrder.id}/pending`, null, token);
assert(pending.items.length === 1 && pending.items[0].pendingQty === 100, '预填待入库明细与数量正确');

console.log('\n[4] 采购入库');
const before = (await call('GET', '/archive/materials/options', null, token)).find((m) => m.id === wire.id);
await call('POST', '/purchase/receipts', {
  orderId: childOrder.id,
  receiptDate: '2026-10-09',
  items: [{ materialId: wire.id, qty: 100, price: 3.5 }],
}, token);
let after = (await call('GET', '/archive/materials/options', null, token)).find((m) => m.id === wire.id);
assert(after.current_stock === before.current_stock + 100, `库存 +100（${before.current_stock} -> ${after.current_stock}）`);
console.log(`  移动加权成本 ${before.avg_cost} -> ${after.avg_cost}`);

console.log('\n[5] 入库单前端不可见单号');
const receipts = await call('GET', '/purchase/receipts?pageSize=5', null, token);
assert(receipts.list.length > 0, '入库列表有数据');
assert(
  receipts.list.every((r) => !('receipt_no' in r) && !('receiptNo' in r)),
  '入库列表不含 receipt_no 字段',
);
assert(!!receipts.list[0].purchaseContent, `采购内容列存在：${receipts.list[0].purchaseContent}`);

console.log('\n[6] 撤销入库，库存应回滚');
const receiptId = receipts.list[0].id;
await call('POST', `/purchase/receipts/${receiptId}/undo`, null, token);
after = (await call('GET', '/archive/materials/options', null, token)).find((m) => m.id === wire.id);
assert(after.current_stock === before.current_stock, `库存回滚到 ${before.current_stock}`);

console.log('\n[7] 出入库详情净额统计');
const detail = await call('GET', `/inventory/detail?itemType=material&itemId=${wire.id}`, null, token);
console.log(`  期初=${detail.summary.initialQty} 入库合计=${detail.summary.inQty} 出库合计=${detail.summary.outQty} 结存=${detail.summary.balanceQty}`);
assert(detail.summary.inQty === 0, '撤销后入库合计不计入净额（撤销记录已排除）');
assert(detail.summary.balanceQty === before.current_stock, '台账结存与现存量一致');

console.log('\n[8] BOM 虚拟件穿透（发热组件 -> 发热盘 + 温控器）');
const products = await call('GET', '/archive/products/options', null, token);
const kettle = products.find((p) => p.name.includes('电热水壶'));
const kettleDetail = await call('GET', `/archive/products/${kettle.id}`, null, token);
console.log(`  ${kettleDetail.name} BOM 行数=${kettleDetail.bom.length}，含虚拟件=${kettleDetail.bom.some((b) => b.isVirtual)}`);
assert(kettleDetail.bom.some((b) => b.isVirtual), 'BOM 中包含虚拟件');

console.log('\n[9] 成品复制预填源数据');
assert(kettleDetail.bom.length > 0, '复制时可带出完整 BOM 明细');

console.log('\n[10] 管理员改密码后旧 token 失效');
await call('POST', '/system/users/2/password', { newPassword: 'purchaser888', confirmPassword: 'purchaser888' }, token);
const pLogin = await call('POST', '/auth/login', { username: 'purchaser', password: 'purchaser888' });
assert(!!pLogin.token, '新密码可登录');

console.log('\n全部冒烟用例通过 ✅');
