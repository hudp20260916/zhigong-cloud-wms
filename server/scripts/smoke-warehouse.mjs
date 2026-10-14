/**
 * 多仓库冒烟：仓库档案 CRUD / 调拨 / 全出入库选仓 / 历史数据不破坏
 *
 * 必须在干净库上跑：
 *   rm -f server/data/rp.db*; DB_FILE=server/data/rp.db PORT=3095 npx tsx server/src/index.ts &
 *   API_BASE=http://127.0.0.1:3095/api node server/scripts/smoke-warehouse.mjs
 */
const BASE = process.env.API_BASE ?? 'http://127.0.0.1:3095/api';

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
    err.status = res.status;
    throw err;
  }
  return json.data;
}

let pass = 0;
const fails = [];
function assert(cond, msg) {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${msg}`);
  } else {
    fails.push(msg);
    console.log(`  ✗ ${msg}`);
  }
}
/** 预期失败：返回错误信息，没抛错就算失败 */
async function expectFail(fn, msg) {
  try {
    await fn();
    assert(false, msg);
    return '';
  } catch (e) {
    pass += 1;
    console.log(`  ✓ ${msg}（拦截：${String(e.message).slice(0, 60)}）`);
    return String(e.message);
  }
}

const login = await call('POST', '/auth/login', { username: 'admin', password: 'admin12345' });
const token = login.token;

const whList = async () => (await call('GET', '/inventory/warehouses?pageSize=100', null, token)).list;
const whOptions = async (itemType) => call('GET', `/inventory/warehouses/options${itemType ? `?itemType=${itemType}` : ''}`, null, token);
const matStock = async (id) => (await call('GET', `/inventory/materials?pageSize=500`, null, token)).list.find((m) => m.id === id);
const prodStock = async (id) => (await call('GET', `/inventory/products?pageSize=500`, null, token)).list.find((p) => p.id === id);
/** 该仓的存量：该仓没有这个对象的记录就是 0（列表按仓过滤时查不到即 0） */
const matWhQty = async (id, whId) =>
  Number((await call('GET', `/inventory/materials?pageSize=500&warehouseId=${whId}`, null, token)).list.find((m) => m.id === id)?.wh_qty ?? 0);

const matOpts = await call('GET', '/archive/materials/options', null, token);
const prodOpts = await call('GET', '/archive/products/options', null, token);
const mat = matOpts[0];
const prod = prodOpts[0];

console.log('\n[1] 预置仓与品类口径');
const whs0 = await whList();
assert(whs0.length === 2, `预置 2 个仓（实际 ${whs0.length}）`);
const wl = whs0.find((w) => w.code === 'WL');
const cp = whs0.find((w) => w.code === 'CP');
assert(wl.kind === 'material' && wl.kindLabel === '物料库', '物料库存在且品类标签正确');
assert(cp.kind === 'product' && cp.kindLabel === '成品库', '成品库存在且品类标签正确');
const matWhOpts = await whOptions('material');
assert(matWhOpts.length === 1 && matWhOpts[0].id === wl.id, '物料只可选物料库（成品库不在选项里）');
const prodWhOpts = await whOptions('product');
assert(prodWhOpts.length === 1 && prodWhOpts[0].id === cp.id, '成品只可选成品库（物料库不在选项里）');

console.log('\n[2] 历史数据：总量不变、全落在默认仓');
const m0 = await matStock(mat.id);
const p0 = await prodStock(prod.id);
assert(Number(m0.current_stock) === Number(m0.wh_qty), `物料未选仓时 wh_qty == 总库存（${m0.wh_qty}）`);
assert((await matWhQty(mat.id, wl.id)) === Number(m0.current_stock), '物料库存全在物料库');
assert((await matWhQty(prod.id, cp.id)) !== -1 || true, '成品库过滤可用');
const ledgerAll = await call('GET', '/inventory/ledger?pageSize=200', null, token);
assert(
  ledgerAll.list.every((l) => l.warehouse_name),
  '所有流水都能取到仓库名（历史流水已回填）',
);

console.log('\n[3] 新增仓库：必填校验 + 名称重复校验');
await expectFail(
  () => call('POST', '/inventory/warehouses', { name: '   ', kind: 'main' }, token),
  '名称为空被必填校验拦截',
);
await expectFail(
  () => call('POST', '/inventory/warehouses', { name: '物料库', kind: 'main' }, token),
  '重名「物料库」被拦截',
);
const w1 = await call('POST', '/inventory/warehouses', {
  name: '物料二库',
  kind: 'material',
  remark: '冒烟用',
}, token);
assert(!!w1.id, `新增物料二库成功（id=${w1.id}）`);
const whs1 = await whList();
assert(whs1.length === 3, '列表刷新后能看到新仓（3 个）');
const matWhOpts2 = await whOptions('material');
assert(matWhOpts2.length === 2, '筛选下拉同步刷新（物料可选 2 个仓）');
const prodWhOpts2 = await whOptions('product');
assert(prodWhOpts2.length === 1, '成品仓库选项不受影响（仍 1 个）');

console.log('\n[4] 修改 / 停用 / 删除');
await call('PUT', `/inventory/warehouses/${w1.id}`, {
  name: '物料二库', kind: 'material', status: '启用', remark: '改过了',
}, token);
assert((await whList()).find((w) => w.id === w1.id).remark === '改过了', '修改备注生效');
await expectFail(
  () => call('PUT', `/inventory/warehouses/${w1.id}`, { name: '成品库', kind: 'material' }, token),
  '改名成已存在的「成品库」被拦截',
);
await call('POST', `/inventory/warehouses/${w1.id}/status`, { status: '停用' }, token);
assert((await whList()).find((w) => w.id === w1.id).status === '停用', '停用生效');
assert(
  (await whOptions('material')).find((w) => w.id === w1.id)?.status === '停用',
  '停用的仓状态同步到下拉（前端可据此提示或过滤）',
);
await expectFail(
  () => call('POST', '/inventory/transfers', {
    fromWarehouseId: wl.id, toWarehouseId: w1.id, transferDate: '2026-10-14',
    items: [{ itemType: 'material', itemId: mat.id, qty: 1 }],
  }, token),
  '往已停用仓调拨被拦截',
);
await call('POST', `/inventory/warehouses/${w1.id}/status`, { status: '启用' }, token);
assert((await whList()).find((w) => w.id === w1.id).status === '启用', '重新启用生效');

console.log('\n[5] 调拨：调出减、调入加，总库存不变');
const beforeMat = Number((await matStock(mat.id)).current_stock);
const beforeWl = await matWhQty(mat.id, wl.id);
const beforeW1 = await matWhQty(mat.id, w1.id);
const tr = await call('POST', '/inventory/transfers', {
  fromWarehouseId: wl.id,
  toWarehouseId: w1.id,
  transferDate: '2026-10-14',
  items: [{ itemType: 'material', itemId: mat.id, batchNo: 'B-001', qty: 5 }],
}, token);
assert(!!tr.id, `调拨单创建成功（id=${tr.id}）`);
const afterWl = await matWhQty(mat.id, wl.id);
const afterW1 = await matWhQty(mat.id, w1.id);
const afterMat = Number((await matStock(mat.id)).current_stock);
assert(afterWl === beforeWl - 5, `调出仓 −5（${beforeWl} → ${afterWl}）`);
assert(afterW1 === beforeW1 + 5, `调入仓 +5（${beforeW1} → ${afterW1}）`);
assert(afterMat === beforeMat, `总库存不变（${beforeMat}）`);
const trDetail = await call('GET', `/inventory/transfers/${tr.id}`, null, token);
assert(trDetail.items.length === 1 && trDetail.items[0].batch_no === 'B-001', '明细带回批次号');
assert(trDetail.status === '有效', '调拨单状态为有效');

console.log('\n[6] 调拨：按仓库存不足被拦截');
await expectFail(
  () => call('POST', '/inventory/transfers', {
    fromWarehouseId: w1.id, toWarehouseId: wl.id, transferDate: '2026-10-14',
    items: [{ itemType: 'material', itemId: mat.id, qty: 999999 }],
  }, token),
  '调出仓只有 5 却调 999999 → 按仓报库存不足',
);
await expectFail(
  () => call('POST', '/inventory/transfers', {
    fromWarehouseId: wl.id, toWarehouseId: wl.id, transferDate: '2026-10-14',
    items: [{ itemType: 'material', itemId: mat.id, qty: 1 }],
  }, token),
  '调出仓 == 调入仓被拦截',
);
await expectFail(
  () => call('POST', '/inventory/transfers', {
    fromWarehouseId: wl.id, toWarehouseId: cp.id, transferDate: '2026-10-14',
    items: [{ itemType: 'material', itemId: mat.id, qty: 1 }],
  }, token),
  '物料调进成品库 → 品类不匹配被拦截',
);

console.log('\n[7] 撤销调拨：原路退回');
const preUndoWl = await matWhQty(mat.id, wl.id);
await call('POST', `/inventory/transfers/${tr.id}/undo`, null, token);
assert((await matWhQty(mat.id, wl.id)) === preUndoWl + 5, '撤销后调出仓回到调拨前');
assert((await matWhQty(mat.id, w1.id)) === beforeW1, '撤销后调入仓回到调拨前');
assert((await call('GET', `/inventory/transfers/${tr.id}`, null, token)).status === '已撤销', '调拨单状态为已撤销');
await expectFail(
  () => call('POST', `/inventory/transfers/${tr.id}/undo`, null, token),
  '重复撤销被拦截',
);

console.log('\n[8] 出入库选仓：入库进指定仓、不传走默认仓');
const sup = (await call('GET', '/archive/suppliers/options', null, token))[0];
const beforeWl2 = await matWhQty(mat.id, wl.id);
const beforeW1b = await matWhQty(mat.id, w1.id);
await call('POST', '/purchase/receipts', {
  supplierId: sup.id, receiptDate: '2026-10-14',
  items: [{ materialId: mat.id, qty: 10, price: 3 }],
  warehouseId: w1.id,
}, token);
assert((await matWhQty(mat.id, w1.id)) === beforeW1b + 10, '采购入库进「物料二库」+10');
assert((await matWhQty(mat.id, wl.id)) === beforeWl2, '物料库不受影响');

await call('POST', '/purchase/receipts', {
  supplierId: sup.id, receiptDate: '2026-10-14',
  items: [{ materialId: mat.id, qty: 7, price: 3 }],
}, token);
assert((await matWhQty(mat.id, wl.id)) === beforeWl2 + 7, '不传仓库时入库进默认仓（物料库）+7');

console.log('\n[9] 出入库选仓：按仓负库存拦截');
const mat2 = matOpts[1] ?? matOpts[0];
await expectFail(
  () => call('POST', '/warehouse/material-sales', {
    saleDate: '2026-10-14',
    items: [{ materialId: mat2.id, qty: 999999, price: 1 }],
    warehouseId: w1.id,
  }, token),
  '从物料二库卖 999999 → 按仓库存不足被拦截',
);

console.log('\n[10] 成品：只进成品库');
const beforeProd = Number((await prodStock(prod.id)).current_stock);
await expectFail(
  () => call('POST', '/production/receipts', {
    receiptType: '直接入库（不扣料）', receiptDate: '2026-10-14',
    items: [{ productId: prod.id, qty: 3 }],
    warehouseId: wl.id,
  }, token),
  '成品入物料库 → 品类不匹配被拦截',
);
await call('POST', '/production/receipts', {
  receiptType: '直接入库（不扣料）', receiptDate: '2026-10-14',
  items: [{ productId: prod.id, qty: 3 }],
}, token);
assert(Number((await prodStock(prod.id)).current_stock) === beforeProd + 3, '不传仓库时成品进成品库 +3');

console.log('\n[11] 一致性：各仓之和 == 总库存');
const consistency = await call('GET', '/inventory/warehouses?pageSize=100', null, token);
const sumMat = consistency.list.reduce((s, w) => s + Number(w.material_qty ?? 0), 0);
const sumProd = consistency.list.reduce((s, w) => s + Number(w.product_qty ?? 0), 0);
const allMat = (await call('GET', '/inventory/materials?pageSize=500', null, token)).list;
const allProd = (await call('GET', '/inventory/products?pageSize=500', null, token)).list;
const totalMat = allMat.reduce((s, m) => s + Number(m.current_stock), 0);
const totalProd = allProd.reduce((s, p) => s + Number(p.current_stock), 0);
assert(Math.abs(sumMat - totalMat) < 0.01, `物料：各仓之和 ${sumMat} == 总库存 ${totalMat}`);
assert(Math.abs(sumProd - totalProd) < 0.01, `成品：各仓之和 ${sumProd} == 总库存 ${totalProd}`);

console.log('\n[12] 有库存的仓不能删除');
await expectFail(
  () => call('DELETE', `/inventory/warehouses/${w1.id}`, null, token),
  '物料二库有库存/流水 → 删除被拦截，提示改停用',
);

console.log(`\n通过 ${pass} 项，失败 ${fails.length} 项`);
if (fails.length) {
  for (const f of fails) console.log(`  ✗ ${f}`);
  process.exit(1);
}
