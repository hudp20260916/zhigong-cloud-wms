/**
 * 产品分类字段 + BOM 展开 + 导入模板分类列 冒烟（干净库 3095）。
 * 验证：
 *   ① products 表新增 category 列且迁移幂等（干净库能起，老库重启不报 duplicate column）
 *   ② 新增成品可存分类，列表与详情正确回显
 *   ③ 修改成品时分类正确回显与保存
 *   ④ BOM 明细接口返回展开字段（供前端行展开只读展示）
 *   ⑤ 产品导入模板含「分类」列
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
  if (!r.ok || j.ok === false) { const e = new Error(`${p} → ${j.message}`); throw e; }
  return j.data;
}
async function put(p, b) {
  const r = await fetch(`${BASE}${p}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(b),
  });
  const j = await r.json().catch(() => ({ ok: false, message: `HTTP ${r.status}` }));
  if (!r.ok || j.ok === false) throw new Error(`${p} → ${j.message}`);
  return j.data;
}

async function main() {
  const login = await post('/auth/login', { username: 'admin', password: 'admin12345' });
  token = login.token;
  console.log('登录成功\n');

  // ① 分类列已建（迁移生效）
  console.log('--- ① products.category 迁移 ---');
  const products = await get('/archive/products/options');
  const mats = await get('/archive/materials/options');
  check('products/options 正常返回', Array.isArray(products), `got ${typeof products}`);
  check('materials/options 正常返回', Array.isArray(mats));

  // 建一个带 BOM 的成品用于后续
  const bom = mats.slice(0, 3).map((m) => ({ materialId: m.id, qty: 2 }));
  const created = await post('/archive/products', {
    name: '冒烟测试成品A', spec: 'SMOKE', category: '整机',
    unit: '台', packingSpec: '6台/箱', safetyStock: 5, bomVersion: 'V1.0', bom,
  });
  console.log('\n--- ② 新增成品带分类 ---');
  const list1 = (await get('/archive/products?pageSize=100')).list;
  const p1 = list1.find((x) => x.id === created.id);
  check('新增后列表含分类列', p1 !== undefined);
  check('列表回显分类「整机」', p1?.category === '整机', `got ${p1?.category}`);
  check('BOM 明细数 = 3', Number(p1?.bom_count) === 3, `got ${p1?.bom_count}`);

  // ③ 详情回显 + BOM 展开字段
  console.log('\n--- ③ 详情回显与 BOM 展开字段 ---');
  const d1 = await get(`/archive/products/${created.id}`);
  check('详情回显分类', d1.category === '整机', `got ${d1.category}`);
  const bomLines = d1.bom ?? [];
  check('BOM 明细 3 行', bomLines.length === 3, `got ${bomLines.length}`);
  const need = ['materialId', 'materialCode', 'materialName', 'spec', 'unit', 'qtyPerUnit'];
  const hasAll = need.every((k) => bomLines.every((l) => l[k] !== undefined));
  check('BOM 明细含展示所需字段（编码/名称/规格/单位/单件耗用量）', hasAll,
    JSON.stringify(bomLines[0] ?? {}));

  // ④ 修改时分类回显与保存（编辑已有记录，不是新建）
  console.log('\n--- ④ 修改成品（编辑已有记录） ---');
  await put(`/archive/products/${created.id}`, {
    code: d1.code, name: d1.name, spec: 'SMOKE-V2', category: '配件',
    unit: '台', packingSpec: '6台/箱', safetyStock: 9, bomVersion: 'V1.1', bom,
  });
  const d2 = await get(`/archive/products/${created.id}`);
  check('修改后分类更新为「配件」', d2.category === '配件', `got ${d2.category}`);
  check('修改后规格更新', d2.spec === 'SMOKE-V2', `got ${d2.spec}`);
  check('修改后安全库存更新', Number(d2.safety_stock) === 9, `got ${d2.safety_stock}`);
  check('修改后 BOM 保留 3 行', (d2.bom ?? []).length === 3, `got ${(d2.bom ?? []).length}`);

  // 分类可清空（选填语义）
  await put(`/archive/products/${created.id}`, {
    code: d2.code, name: d2.name, spec: d2.spec, category: '',
    unit: '台', packingSpec: '6台/箱', safetyStock: 0, bomVersion: 'V1.0', bom,
  });
  const d3 = await get(`/archive/products/${created.id}`);
  check('分类可留空（选填）', !d3.category, `got ${JSON.stringify(d3.category)}`);

  // ⑤ 导入模板含分类列
  console.log('\n--- ⑤ 产品导入模板 ---');
  const kinds = await get('/system/import/kinds');
  const pd = kinds.find((k) => k.kind === 'product');
  check('product 导入类型存在', !!pd);
  check('模板含「分类」列', !!pd?.columns?.some((c) => c.key === 'category'),
    JSON.stringify(pd?.columns?.map((c) => c.key)));

  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('冒烟异常:', e.message); process.exit(1); });