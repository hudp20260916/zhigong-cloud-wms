/**
 * 采购订单「按主产品 BOM 采购」物料需求测算的验收脚本。
 *
 * 覆盖：
 *  [1] 多级 BOM 递归展开（子件本身是成品且有 BOM → 继续下钻到最底层原材料）
 *  [2] 同物料在多层级 / 多父件下重复出现 → 合并汇总
 *  [3] 需求量 = 单位用量 × 计划产量
 *  [4] 可用库存 = max(0, 现有库存 − 已占用量)；缺料 = max(0, 需求 − 可用)，充足时为 0 不为负
 *  [5] 取整规则：离散单位（个/件/…）向上取整，连续单位（米/kg/…）保留 2 位小数
 *  [6] 计划产量为空 / 0 / 负数 / 非数字 → 只返回结构与单位用量
 *  [7] BOM 缺失 → bomMissing=true，不报错、不 500
 *  [8] 虚拟件穿透（用种子里的「发热组件」）
 *  [9] 参数校验：缺 productId → 400；不存在的 productId → 404
 *  [10] 已占用量：未完工工单「计划 − 已领」部分；库存被占超 → 可用库存取 0 不为负
 *  [11] 采购在途只展示、不进公式
 *  [12] BOM 变更后重新测算（缓存清理，单位用量同步更新）
 *
 * 数据结构（便于核对期望值）：
 *   原材料 A（个，离散）  B（米，连续）  C（米，连续，库存管够）
 *   半成品 S = 2×A + 1×B + 1×C，且 S 的物料编码 == 成品编码（可被下钻）
 *   虚拟件 V = 种子「发热组件」= 1×M1008 + 1×M1009
 *   顶层 P = 3×S + 5×A + 1×V
 *   ⇒ 单位用量：A = 3×2 + 5 = 11；B = 3；C = 3；M1008 = 1；M1009 = 1
 *
 * 用法（必须干净库）：
 *   rm -f server/data/rp.db*; DB_FILE=server/data/rp.db PORT=3095 npx tsx server/src/index.ts &
 *   API_BASE=http://127.0.0.1:3095/api node server/scripts/smoke-bom-preview.mjs
 */
const BASE = process.env.API_BASE ?? 'http://127.0.0.1:3095/api';

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
if (!login.data?.token) {
  console.error('登录失败，先确认服务已起在', BASE, JSON.stringify(login));
  process.exit(1);
}
const H = login.data.token;
const today = new Date().toISOString().slice(0, 10);
const tag = `T${Date.now().toString().slice(-6)}`;

/** 设定期初库存（「设定」语义：直接把库存设成 qty） */
async function setStock(itemId, qty) {
  return api(
    'POST',
    '/inventory/initial',
    { items: [{ itemType: 'material', itemId, qty, price: 1 }] },
    H,
  );
}

/* ---------- 造数据 ---------- */
const A = (await api('POST', '/archive/materials', { code: `MA${tag}`, name: `验收-原料A-${tag}`, unit: '个', safetyStock: 0 }, H)).data;
const B = (await api('POST', '/archive/materials', { code: `MB${tag}`, name: `验收-原料B-${tag}`, unit: '米', safetyStock: 0 }, H)).data;
const C = (await api('POST', '/archive/materials', { code: `MC${tag}`, name: `验收-原料C-${tag}`, unit: '米', safetyStock: 0 }, H)).data;
// 半成品 S：物料与成品编码相同（MS{tag}），这是能被下钻的前提
const SM = (await api('POST', '/archive/materials', { code: `MS${tag}`, name: `验收-半成品S-${tag}`, unit: '件', safetyStock: 0 }, H)).data;
const SP = (
  await api(
    'POST',
    '/archive/products',
    {
      code: `MS${tag}`,
      name: `验收-半成品S-${tag}`,
      unit: '件',
      bomVersion: 'V1.0',
      bom: [
        { materialId: A.id, qty: 2 },
        { materialId: B.id, qty: 1 },
        { materialId: C.id, qty: 1 },
      ],
    },
    H,
  )
).data;

// 虚拟件直接用种子里的「发热组件」（系统没有虚拟件维护接口）
const allMats = (await api('GET', '/archive/materials/options', undefined, H)).data ?? [];
const V = allMats.find((m) => Number(m.is_virtual) === 1);

const P = (
  await api(
    'POST',
    '/archive/products',
    {
      code: `MP${tag}`,
      name: `验收-成品P-${tag}`,
      unit: '台',
      bomVersion: 'V2.0',
      bom: [
        { materialId: SM.id, qty: 3 },
        { materialId: A.id, qty: 5 },
        ...(V?.id ? [{ materialId: V.id, qty: 1 }] : []),
      ],
    },
    H,
  )
).data;

check('测试数据已创建', !!(A?.id && B?.id && C?.id && SM?.id && SP?.id && P?.id));
check('找到种子虚拟件用于穿透验证', !!V?.id, V ? `${V.code} ${V.name}` : '库里没有虚拟件，穿透用例会跳过');

// 库存：A=50（不够）、B=5（不够）、C=1000（充足）
await setStock(A.id, 50);
await setStock(B.id, 5);
await setStock(C.id, 1000);

const codeA = `MA${tag}`;
const codeB = `MB${tag}`;
const codeC = `MC${tag}`;
const codeS = `MS${tag}`;
const codeV = V?.code;

function indexOf(items) {
  return Object.fromEntries((items ?? []).map((i) => [i.materialCode, i]));
}

/* ---------- [1][2][3] 多级展开 + 合并汇总 + 需求量 ---------- */
console.log('\n[1-3] 多级 BOM 递归展开 / 重复物料合并汇总 / 需求量');
const r1 = await api('GET', `/purchase/orders/bom-preview?productId=${P.id}&planQty=10`, undefined, H);
check('接口 200', r1.status === 200 && r1.ok, r1.message ?? '');
const i1 = indexOf(r1.data?.items);
// P = 3×S + 5×A + 1×V；S = 2×A + 1×B + 1×C；V = 1×M1008 + 1×M1009
check('A 单位用量 = 11（3×S 展开 6 + 顶层直接 5）', Number(i1[codeA]?.qtyPerUnit) === 11, `实际 ${i1[codeA]?.qtyPerUnit}`);
check('B 单位用量 = 3（只来自 3×S）', Number(i1[codeB]?.qtyPerUnit) === 3, `实际 ${i1[codeB]?.qtyPerUnit}`);
check('C 单位用量 = 3（只来自 3×S）', Number(i1[codeC]?.qtyPerUnit) === 3, `实际 ${i1[codeC]?.qtyPerUnit}`);
check('半成品 S 已下钻，不作为采购行出现', i1[codeS] === undefined);
if (V) check('虚拟件 V 已穿透，不作为采购行出现', i1[codeV] === undefined);
check('只返回最底层原材料（不含半成品 / 虚拟件）', !i1[codeS] && (!V || !i1[codeV]));
check('deepExpanded = true', r1.data?.deepExpanded === true);
check('需求量 = 单位用量 × 10 → A=110', Number(i1[codeA]?.requireQty) === 110, `实际 ${i1[codeA]?.requireQty}`);
check('需求量 = 单位用量 × 10 → B=30', Number(i1[codeB]?.requireQty) === 30, `实际 ${i1[codeB]?.requireQty}`);
if (V) {
  const m1008 = (r1.data?.items ?? []).find((i) => i.materialCode === 'M1008');
  check('虚拟件子件 M1008 单位用量 = 1（1×V）', Number(m1008?.qtyPerUnit) === 1, `实际 ${m1008?.qtyPerUnit}`);
}

/* ---------- [4] 库存不足 / 充足 ---------- */
console.log('\n[4] 可用库存与缺料数量（不足 / 充足 / 为负取 0）');
const a1 = i1[codeA];
const b1 = i1[codeB];
const c1 = i1[codeC];
check('A 现有库存 = 50', Number(a1?.stock) === 50, `实际 ${a1?.stock}`);
check('A 已占用 = 0（此时没有未完工工单）', Number(a1?.occupiedQty) === 0, `实际 ${a1?.occupiedQty}`);
check('A 可用库存 = 50', Number(a1?.availableQty) === 50, `实际 ${a1?.availableQty}`);
check('A 缺料 = 110 − 50 = 60', Number(a1?.shortageQty) === 60, `实际 ${a1?.shortageQty}`);
check('A enough=false', a1?.enough === false);
check('B 缺料 = 30 − 5 = 25', Number(b1?.shortageQty) === 25, `实际 ${b1?.shortageQty}`);
check('C 库存充足 → 缺料 = 0（不得为负）', Number(c1?.shortageQty) === 0, `实际 ${c1?.shortageQty}`);
check('C enough=true', c1?.enough === true);
check('C 建议采购数量 = 0', Number(c1?.purchaseQty) === 0, `实际 ${c1?.purchaseQty}`);
check('shortageCount 与缺料行数一致', r1.data?.shortageCount === (r1.data?.items ?? []).filter((x) => !x.enough).length);

/* ---------- [5] 取整规则 ---------- */
console.log('\n[5] 单位换算与取整舍入');
// planQty = 9.55：A 需求 11×9.55 = 105.05 → 缺料 55.05 → 「个」向上取整 56
//                B 需求 3×9.55 = 28.65 → 缺料 23.65 → 「米」保留 2 位 = 23.65
const r5 = await api('GET', `/purchase/orders/bom-preview?productId=${P.id}&planQty=9.55`, undefined, H);
const i5 = indexOf(r5.data?.items);
check('需求量保留 2 位小数：A = 105.05', Number(i5[codeA]?.requireQty) === 105.05, `实际 ${i5[codeA]?.requireQty}`);
check('离散单位「个」：缺料 55.05 → 采购 56（向上取整）', Number(i5[codeA]?.purchaseQty) === 56, `缺料 ${i5[codeA]?.shortageQty} → 采购 ${i5[codeA]?.purchaseQty}`);
check('连续单位「米」：缺料 23.65 → 采购 23.65（2 位小数）', Number(i5[codeB]?.purchaseQty) === 23.65, `缺料 ${i5[codeB]?.shortageQty} → 采购 ${i5[codeB]?.purchaseQty}`);
check('连续单位且库存充足：C 采购 = 0', Number(i5[codeC]?.purchaseQty) === 0, `实际 ${i5[codeC]?.purchaseQty}`);

/* ---------- [6] 计划产量为空 / 0 / 负数 / 非数字 ---------- */
console.log('\n[6] 计划产量为空 / 0 / 负数 / 非数字');
for (const [label, q] of [['省略', undefined], ['0', 0], ['-5', -5], ['abc', 'abc']]) {
  const qs = q === undefined ? '' : `&planQty=${q}`;
  const r = await api('GET', `/purchase/orders/bom-preview?productId=${P.id}${qs}`, undefined, H);
  const rows = r.data?.items ?? [];
  const aRow = rows.find((x) => x.materialCode === codeA);
  check(
    `planQty=${label} → 200、BOM 照常展开、单位用量仍在、需求与采购均为 0`,
    r.status === 200 && r.ok && rows.length >= 3 && Number(aRow?.qtyPerUnit) === 11 && Number(aRow?.requireQty) === 0 && Number(aRow?.purchaseQty) === 0,
    r.ok ? `unit=${aRow?.qtyPerUnit} need=${aRow?.requireQty} buy=${aRow?.purchaseQty}` : r.message,
  );
}

/* ---------- [7] BOM 缺失 ---------- */
console.log('\n[7] BOM 缺失');
const noBom = (await api('POST', '/archive/products', { code: `MN${tag}`, name: `验收-无BOM成品-${tag}`, unit: '台', confirmNoBom: true, bom: [] }, H)).data;
const r7 = await api('GET', `/purchase/orders/bom-preview?productId=${noBom.id}&planQty=10`, undefined, H);
check('无 BOM 成品 → 200 不报错', r7.status === 200 && r7.ok, r7.message ?? '');
check('无 BOM 成品 → bomMissing = true', r7.data?.bomMissing === true);
check('无 BOM 成品 → 明细行为空', (r7.data?.items ?? []).length === 0);
check('无 BOM 成品 → 无 bomError（缺失不算异常）', !r7.data?.bomError);

/* ---------- [8] 参数校验 ---------- */
console.log('\n[8] 参数校验');
const noPid = await api('GET', `/purchase/orders/bom-preview?planQty=10`, undefined, H);
check('缺少 productId → 400「请先选择主产品」', noPid.status === 400, `${noPid.status} ${noPid.message ?? ''}`);
const badPid = await api('GET', `/purchase/orders/bom-preview?productId=999999&planQty=10`, undefined, H);
check('productId 不存在 → 404', badPid.status === 404, `${badPid.status} ${badPid.message ?? ''}`);
const noPerm = await api('GET', `/purchase/orders/bom-preview?productId=${P.id}&planQty=10`);
check('未登录 → 401', noPerm.status === 401, `${noPerm.status}`);

/* ---------- [9] 已占用量 ---------- */
console.log('\n[9] 已占用量：未完工工单「计划 − 已领」部分');
const wo = await api('POST', '/production/work-orders', { productId: P.id, planQty: 10, startDate: today, remark: '验收-占用' }, H);
check('工单已创建', wo.status === 200 && wo.ok, wo.message ?? '');
const r9 = await api('GET', `/purchase/orders/bom-preview?productId=${P.id}&planQty=10`, undefined, H);
const i9 = indexOf(r9.data?.items);
check('A 已占用 = 11 × 10 = 110', Number(i9[codeA]?.occupiedQty) === 110, `实际 ${i9[codeA]?.occupiedQty}`);
check('A 可用库存 = max(0, 50 − 110) = 0（不为负）', Number(i9[codeA]?.availableQty) === 0, `实际 ${i9[codeA]?.availableQty}`);
check('A 缺料 = 110 − 0 = 110', Number(i9[codeA]?.shortageQty) === 110, `实际 ${i9[codeA]?.shortageQty}`);
check('C 已占用 = 3 × 10 = 30', Number(i9[codeC]?.occupiedQty) === 30, `实际 ${i9[codeC]?.occupiedQty}`);
check('C 可用 = 1000 − 30 = 970，仍充足', Number(i9[codeC]?.availableQty) === 970, `实际 ${i9[codeC]?.availableQty}`);

/* ---------- [10] 采购在途只展示 ---------- */
console.log('\n[10] 采购在途：只展示，不进公式');
const ord = await api(
  'POST',
  '/purchase/orders',
  { mode: 'direct', items: [{ materialId: A.id, qty: 100, price: 1 }], orderDate: today, remark: '验收-在途' },
  H,
);
check('采购订单已创建', ord.status === 200 && ord.ok, ord.message ?? '');
const r10 = await api('GET', `/purchase/orders/bom-preview?productId=${P.id}&planQty=10`, undefined, H);
const i10 = indexOf(r10.data?.items);
check('A 采购在途 = 100', Number(i10[codeA]?.inTransitQty) === 100, `实际 ${i10[codeA]?.inTransitQty}`);
check('在途不进公式：缺料仍 110（未因在途减少）', Number(i10[codeA]?.shortageQty) === 110, `实际 ${i10[codeA]?.shortageQty}`);
check('在途不进公式：可用库存仍 0', Number(i10[codeA]?.availableQty) === 0, `实际 ${i10[codeA]?.availableQty}`);

/* ---------- [11] BOM 变更后重新测算 ---------- */
console.log('\n[11] BOM 变更后重新测算（缓存清理）');
await api(
  'PUT',
  `/archive/products/${SP.id}`,
  {
    code: `MS${tag}`,
    name: `验收-半成品S-${tag}`,
    unit: '件',
    bomVersion: 'V1.1',
    bom: [
      { materialId: A.id, qty: 4 },
      { materialId: B.id, qty: 1 },
      { materialId: C.id, qty: 1 },
    ],
  },
  H,
);
const r11 = await api('GET', `/purchase/orders/bom-preview?productId=${P.id}&planQty=10`, undefined, H);
const i11 = indexOf(r11.data?.items);
// S 改成 4×A 后：A = 3×4 + 5 = 17
check('S 的 A 用量 2→4 后，顶层 A 单位用量 11→17', Number(i11[codeA]?.qtyPerUnit) === 17, `实际 ${i11[codeA]?.qtyPerUnit}`);
check('需求量同步更新为 170', Number(i11[codeA]?.requireQty) === 170, `实际 ${i11[codeA]?.requireQty}`);
check('已占用同步更新为 170', Number(i11[codeA]?.occupiedQty) === 170, `实际 ${i11[codeA]?.occupiedQty}`);

console.log(`\n结果：通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
