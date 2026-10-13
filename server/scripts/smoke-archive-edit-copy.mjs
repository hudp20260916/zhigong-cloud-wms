/**
 * 档案页「修改 / 复制」统一行为冒烟（干净库 3095）。
 * 覆盖：成品档案与 BOM、物料档案、供应商档案、客户档案。
 * 关键断言：
 *   ① 修改：带出全部字段（含 BOM 明细 / 子表），改后正确回显并保存
 *   ② 修改：编码不可变更（服务端 UPDATE 不含 code，编码原样保留）
 *   ③ 复制：带出全部字段，编码留空由服务端按规则生成新编码，无重复
 *   ④ 明细不丢失：复制后 BOM 明细行数与源一致
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
  if (!r.ok || j.ok === false) throw new Error(`${p} → ${j.message}`);
  return j.data;
}
async function post(p, b) {
  const r = await fetch(`${BASE}${p}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(b),
  });
  const j = await r.json().catch(() => ({ ok: false, message: `HTTP ${r.status}` }));
  if (!r.ok || j.ok === false) throw new Error(`${p} → ${j.message}`);
  return j.data;
}
async function put(p, b) {
  const r = await fetch(`${BASE}${p}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
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

  const mats = await get('/archive/materials/options');

  // ================= 成品档案与 BOM =================
  console.log('--- 成品档案与 BOM ---');
  const bom = mats.slice(0, 4).map((m) => ({ materialId: m.id, qty: 3 }));
  const p1 = await post('/archive/products', {
    name: '修改复制测试成品', spec: 'SPEC-A', category: '整机', unit: '台',
    packingSpec: '6台/箱', safetyStock: 10, bomVersion: 'V1.0', bom,
  });

  // ① 修改带出全部字段 + BOM
  let d = await get(`/archive/products/${p1.id}`);
  check('修改：详情可带出全部字段', d.code && d.name && d.spec === 'SPEC-A' && d.category === '整机');
  check('修改：BOM 明细 4 行全部带出', (d.bom ?? []).length === 4, `got ${(d.bom ?? []).length}`);

  await put(`/archive/products/${p1.id}`, {
    code: d.code, name: '修改后成品名', spec: 'SPEC-B', category: '配件', unit: '台',
    packingSpec: '12台/箱', safetyStock: 99, bomVersion: 'V2.0', bom,
  });
  d = await get(`/archive/products/${p1.id}`);
  check('修改：名称已保存', d.name === '修改后成品名', `got ${d.name}`);
  check('修改：分类已保存', d.category === '配件', `got ${d.category}`);
  check('修改：装箱规格已保存', d.packing_spec === '12台/箱', `got ${d.packing_spec}`);
  check('修改：安全库存已保存', Number(d.safety_stock) === 99, `got ${d.safety_stock}`);
  check('修改：BOM 明细未丢失（仍 4 行）', (d.bom ?? []).length === 4, `got ${(d.bom ?? []).length}`);

  // ② 编码不可变更：传不同编码也不应改变
  const codeBefore = d.code;
  await put(`/archive/products/${p1.id}`, {
    code: 'HACK-CODE-999', name: d.name, spec: d.spec, category: d.category, unit: '台',
    packingSpec: d.packing_spec, safetyStock: d.safety_stock, bomVersion: d.bom_version, bom,
  });
  d = await get(`/archive/products/${p1.id}`);
  check('修改：编码不可变更（服务端忽略 code）', d.code === codeBefore, `${codeBefore} → ${d.code}`);

  // ③ 复制：编码留空自动生成
  const c1 = await post('/archive/products', {
    code: undefined, name: '修改复制测试成品-副本', spec: 'SPEC-B', category: '配件', unit: '台',
    packingSpec: '12台/箱', safetyStock: 99, bomVersion: 'V2.0', bom,
  });
  const dc = await get(`/archive/products/${c1.id}`);
  check('复制：自动生成新编码', !!dc.code && dc.code !== codeBefore, `got ${dc.code}`);
  check('复制：新编码与源不同', dc.code !== codeBefore);
  check('复制：BOM 明细 4 行未丢失', (dc.bom ?? []).length === 4, `got ${(dc.bom ?? []).length}`);
  check('复制：其余字段带出（分类/装箱/安全库存）',
    dc.category === '配件' && dc.packing_spec === '12台/箱' && Number(dc.safety_stock) === 99);

  // 编码唯一性
  const allCodes = (await get('/archive/products?pageSize=100')).list.map((x) => x.code);
  check('编码唯一（无重复）', new Set(allCodes).size === allCodes.length, JSON.stringify(allCodes));

  // ================= 物料档案 =================
  console.log('\n--- 物料档案 ---');
  const m1 = await post('/archive/materials', {
    name: '修改复制测试物料', spec: 'MSPEC-A', category: '电子件', unit: '个',
    safetyStock: 20, isVirtual: false, remark: '原始备注',
  });
  let md = await get(`/archive/materials/${m1.id}`);
  check('物料：修改带出全部字段', md.name === '修改复制测试物料' && md.category === '电子件' && md.remark === '原始备注');

  await put(`/archive/materials/${m1.id}`, {
    code: md.code, name: '修改后物料名', spec: 'MSPEC-B', category: '结构件', unit: '个',
    safetyStock: 88, isVirtual: false, remark: '改过的备注',
  });
  md = await get(`/archive/materials/${m1.id}`);
  check('物料：修改已保存（名称/分类/规格/库存/备注）',
    md.name === '修改后物料名' && md.category === '结构件' && md.spec === 'MSPEC-B'
    && Number(md.safety_stock) === 88 && md.remark === '改过的备注',
    JSON.stringify({ n: md.name, c: md.category, s: md.spec, q: md.safety_stock, r: md.remark }));

  const mCode = md.code;
  await put(`/archive/materials/${m1.id}`, {
    code: 'HACK-M-999', name: md.name, spec: md.spec, category: md.category, unit: '个',
    safetyStock: md.safety_stock, isVirtual: false, remark: md.remark,
  });
  md = await get(`/archive/materials/${m1.id}`);
  check('物料：编码不可变更', md.code === mCode, `${mCode} → ${md.code}`);

  const mc = await post('/archive/materials', {
    code: undefined, name: '修改复制测试物料-副本', spec: 'MSPEC-B', category: '结构件', unit: '个',
    safetyStock: 88, isVirtual: false, remark: '改过的备注',
  });
  const mdc = await get(`/archive/materials/${mc.id}`);
  check('物料：复制自动生成新编码', !!mdc.code && mdc.code !== mCode, `got ${mdc.code}`);
  check('物料：复制带出全部字段',
    mdc.spec === 'MSPEC-B' && mdc.category === '结构件' && Number(mdc.safety_stock) === 88 && mdc.remark === '改过的备注');

  // ================= 供应商 / 客户 =================
  for (const kind of ['suppliers', 'customers']) {
    const label = kind === 'suppliers' ? '供应商' : '客户';
    console.log(`\n--- ${label}档案 ---`);
    const base = `/archive/${kind}`;
    // 供应商/客户无单条详情接口（列表已 SELECT * 返回全字段），前端用列表行数据回显
    const findOne = async (id) => (await get(`${base}?pageSize=200`)).list.find((x) => x.id === id);

    const s1 = await post(base, { name: `${label}测试主体`, contact: '张三', phone: '13800000000', remark: '原备注' });
    let sd = await findOne(s1.id);
    check(`${label}：修改带出全部字段`, sd.name === `${label}测试主体` && sd.contact === '张三' && sd.phone === '13800000000');

    await put(`${base}/${s1.id}`, {
      code: sd.code, name: `${label}改名后`, contact: '李四', phone: '13911112222', remark: '改过备注',
    });
    sd = await findOne(s1.id);
    check(`${label}：修改已保存`, sd.name === `${label}改名后` && sd.contact === '李四'
      && sd.phone === '13911112222' && sd.remark === '改过备注',
      JSON.stringify({ n: sd.name, c: sd.contact, p: sd.phone, r: sd.remark }));

    const sCode = sd.code;
    await put(`${base}/${s1.id}`, {
      code: 'HACK-S-999', name: sd.name, contact: sd.contact, phone: sd.phone, remark: sd.remark,
    });
    sd = await findOne(s1.id);
    check(`${label}：编码不可变更`, sd.code === sCode, `${sCode} → ${sd.code}`);

    const sc = await post(base, { code: undefined, name: `${label}测试主体-副本`, contact: '张三', phone: '13800000000', remark: '原备注' });
    const sdc = await findOne(sc.id);
    check(`${label}：复制自动生成新编码`, !!sdc.code && sdc.code !== sCode, `got ${sdc.code}`);
    check(`${label}：复制带出全部字段`,
      sdc.contact === '张三' && sdc.phone === '13800000000' && sdc.remark === '原备注');
  }

  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('冒烟异常:', e.message); process.exit(1); });