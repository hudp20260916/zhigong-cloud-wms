/**
 * 采购订单三项改造的验收脚本：
 *  1. 直接采购物料可以正常新增保存（原 400 缺陷）
 *  2. 按主产品采购流程不受影响（回归）
 *  3. 五个字段的模糊搜索都能命中，且原有筛选条件仍生效
 *  4. 列表不再返回父订单号，且列顺序/字段符合新表头
 *  5. 摘要格式新旧一致
 *  6. 大数据量下的查询耗时（可选，见文件末尾 BULK=1）
 *
 * 用法：node server/scripts/smoke-purchase-order-fix.mjs
 */
const BASE = process.env.API_BASE ?? 'http://127.0.0.1:3001/api';
const BULK = process.env.BULK === '1';

let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}${extra ? ' — ' + extra : ''}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`);
  }
}

async function api(method, path, body, token) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, ...json };
}

const login = await api('POST', '/auth/login', { username: 'admin', password: 'admin12345' });
const T = login.data.token;
const H = T;
const today = new Date().toISOString().slice(0, 10);

const mats = (await api('GET', '/archive/materials?pageSize=5', undefined, H)).data.list;
const m1 = mats[0];
const m2 = mats[1];

console.log('\n[1] 直接采购物料：新增保存');
const direct = await api(
  'POST',
  '/purchase/orders',
  {
    mode: 'direct',
    items: [{ materialId: m1.id, qty: 12, price: 3.5 }],
    productId: null,
    planQty: null,
    bomVersion: null, // ← 原来就是这一项触发 400
    orderDate: today,
    expectedDate: '',
    remark: '直接采购物料-验收',
  },
  H,
);
check('返回 200', direct.status === 200 && direct.ok, direct.ok ? `单号 ${direct.data?.orderNo}` : direct.message);
check('生成了订单号', !!direct.data?.orderNo);

console.log('\n[2] 直接采购物料：bomVersion 传 undefined 也行');
const direct2 = await api(
  'POST',
  '/purchase/orders',
  {
    mode: 'direct',
    items: [{ materialId: m2.id, qty: 3, price: 1 }],
    orderDate: today,
    expectedDate: '',
    remark: '直接采购-无 bomVersion 字段',
  },
  H,
);
check('返回 200', direct2.status === 200 && direct2.ok, direct2.ok ? direct2.data?.orderNo : direct2.message);

console.log('\n[3] 回归：按主产品采购（BOM）');
const prods = (await api('GET', '/archive/products?pageSize=5', undefined, H)).data.list;
if (prods.length) {
  const detail = (await api('GET', `/archive/products/${prods[0].id}`, undefined, H)).data;
  const bom = detail.bom ?? [];
  if (bom.length) {
    const bomOrder = await api(
      'POST',
      '/purchase/orders',
      {
        mode: 'bom',
        productId: prods[0].id,
        planQty: 5,
        bomVersion: 'V1.0',
        items: bom.slice(0, 2).map((b) => ({ materialId: b.materialId, qty: Number(b.qtyPerUnit) * 5, price: 1 })),
        orderDate: today,
        expectedDate: '',
        remark: 'BOM 回归',
      },
      H,
    );
    check('BOM 模式仍可新增', bomOrder.status === 200 && bomOrder.ok, bomOrder.ok ? bomOrder.data?.orderNo : bomOrder.message);
  } else {
    console.log('  （该产品无 BOM，跳过）');
  }
}

console.log('\n[4] 五字段模糊搜索');
const list0 = (await api('GET', '/purchase/orders?pageSize=5', undefined, H)).data.list;
const sample = list0[0];
const cases = [
  ['订单单号（片段）', sample.order_no.slice(-6)],
  ['采购摘要（片段）', (sample.summary || '').slice(0, 2)],
  ['供应商', (sample.supplier_name || '').slice(0, 2)],
];
for (const [label, kw] of cases) {
  if (!kw) {
    console.log(`  （${label} 无样例值，跳过）`);
    continue;
  }
  const r = await api('GET', `/purchase/orders?keyword=${encodeURIComponent(kw)}&pageSize=20`, undefined, H);
  check(`${label} 命中`, r.ok && r.data.total > 0, `"${kw}" -> ${r.data?.total ?? 0} 条`);
}
// 主产品 / 物料：用一个已知存在的名称
const matName = m1.name.slice(0, 2);
const rMat = await api('GET', `/purchase/orders?keyword=${encodeURIComponent(matName)}&pageSize=20`, undefined, H);
check('物料（片段）命中', rMat.ok && rMat.data.total > 0, `"${matName}" -> ${rMat.data?.total ?? 0} 条`);

const prodName = ((await api('GET', '/purchase/orders?pageSize=50', undefined, H)).data.list.find((r) => r.product_name) || {}).product_name;
if (prodName) {
  const rProd = await api('GET', `/purchase/orders?keyword=${encodeURIComponent(prodName.slice(0, 2))}&pageSize=20`, undefined, H);
  check('主产品（片段）命中', rProd.ok && rProd.data.total > 0, `"${prodName.slice(0, 2)}" -> ${rProd.data?.total ?? 0} 条`);
}

console.log('\n[5] 原有筛选条件仍生效（状态）');
const withStatus = await api('GET', '/purchase/orders?status=进行中&pageSize=20', undefined, H);
check(
  'status=进行中 全部命中该状态',
  withStatus.ok && withStatus.data.list.every((r) => r.status === '进行中'),
  `${withStatus.data?.total ?? 0} 条`,
);
const kwAndStatus = await api(
  'GET',
  `/purchase/orders?status=进行中&keyword=${encodeURIComponent(sample.order_no.slice(-6))}&pageSize=20`,
  undefined,
  H,
);
check('关键词 + 状态可叠加', kwAndStatus.ok && kwAndStatus.data.list.every((r) => r.status === '进行中'));

console.log('\n[6] 列表字段：不含父订单号，含主产品名称');
const fresh = (await api('GET', '/purchase/orders?pageSize=10', undefined, H)).data.list;
check('不再返回 parent_order_no', fresh.every((r) => !('parent_order_no' in r)));
check('包含 product_name 字段', fresh.every((r) => 'product_name' in r));
check('包含 summary 字段', fresh.every((r) => 'summary' in r));

console.log('\n[7] 摘要格式一致性');
const multi = fresh.filter((r) => r.summary);
const bad = multi.filter((r) => {
  const s = r.summary;
  // 合法格式：「A、B」或「A、B等N项」
  return !/^(.+、){0,1}[^、]+(等\d+项)?$/.test(s) || (s.includes('等') && !/等\d+项$/.test(s));
});
check('摘要均为统一格式', bad.length === 0, bad.length ? `异常：${bad.map((b) => b.summary).join(' | ')}` : `抽查 ${multi.length} 条`);

console.log('\n[8] COUNT 分支回归（曾因参数个数错位导致 500）');
{
  // 命中条数多于一页时才会走「全 COUNT」分支。
  // 旧实现把 @kw 替换成 6 个 ? 却只给 1 个参数值 → 500 Too few parameter values。
  // 这里故意用很小的 pageSize 逼出该分支：只要当页被填满，就会触发 COUNT。
  const wide = await api('GET', '/purchase/orders?keyword=2026&pageSize=2', undefined, H);
  check('关键词命中多于一页时可正常返回总数', wide.status === 200 && Number(wide.data?.total) > 2,
    `status=${wide.status} total=${wide.data?.total}`);

  const combo = await api('GET', '/purchase/orders?keyword=2026&status=进行中&pageSize=2', undefined, H);
  check('关键词 + 状态叠加时 COUNT 参数不错位', combo.status === 200,
    `status=${combo.status} total=${combo.data?.total}  ${combo.message ?? ''}`);
}

if (BULK) {
  console.log('\n[9] 大数据量性能（需先灌数据）');
  for (const kw of ['PO', '发热', '']) {
    const t0 = Date.now();
    const r = await api('GET', `/purchase/orders?keyword=${encodeURIComponent(kw)}&pageSize=20`, undefined, H);
    console.log(`  keyword="${kw}" -> ${r.data?.total ?? 0} 条，耗时 ${Date.now() - t0}ms`);
  }
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
