/**
 * V1.4.6 新增能力冒烟（只读）。
 * 覆盖需求 20/24/25/26/27/28/29/30 的新接口，只查询不写业务数据。
 */
const BASE = process.env.API_BASE ?? 'http://127.0.0.1:3001/api';
const USER = 'admin';
const PASS = 'admin' + '12345';

let token = '';
let pass = 0;
let fail = 0;

function check(name, cond, extra = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name} ${extra}`);
  }
}

async function api(path, params, method = 'GET', body) {
  const qs = params
    ? '?' + Object.entries(params).filter(([, v]) => v !== '' && v != null)
        .map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')
    : '';
  const res = await fetch(`${BASE}${path}${qs}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({ ok: false, message: `HTTP ${res.status}` }));
  if (!res.ok || json.ok === false) throw new Error(`${path} → ${json.message ?? res.status}`);
  return json.data;
}

async function main() {
  console.log('登录…');
  const login = await api('/auth/login', undefined, 'POST', { username: USER, password: PASS });
  token = login.token;
  console.log(`  登录成功：${login.user.displayName}（${login.user.role}）\n`);

  console.log('需求 29：单号前缀设定');
  const settings = await api('/system/settings');
  const codeItems = settings.filter((s) => s.group === '单据编号');
  check('单据编号配置项存在（15 项 = 序号位数 + 14 种单据）', codeItems.length === 15, `实际 ${codeItems.length}`);
  check('采购订单前缀项存在且有默认值', codeItems.some((s) => s.key === 'code.prefix.purchaseOrder' && s.default === 'PO'));
  const seqWidth = codeItems.find((s) => s.key === 'code.seqWidth');
  check('序号位数项存在', !!seqWidth);
  const po = codeItems.find((s) => s.key === 'code.prefix.purchaseOrder');
  check('返回下一张单号预览', !!po?.preview && /^PO\d{8}-\d{4,}$/.test(po.preview), po?.preview);

  console.log('\n需求 30：备份所有模块数据');
  const tables = await api('/system/backup/tables');
  check('统计到数据表', tables.tableCount > 20, `表数 ${tables.tableCount}`);
  check('统计到记录数', typeof tables.rowCount === 'number', `行数 ${tables.rowCount}`);
  const backup = await api('/system/backup/export');
  check('全量导出返回分表数据', (backup.tables ?? []).length === tables.tableCount);
  check('每张表都带列名', backup.tables.every((t) => Array.isArray(t.columns)));
  const dbRes = await fetch(`${BASE}/system/backup/db`, { headers: { Authorization: `Bearer ${token}` } });
  check('整库备份可下载', dbRes.ok && (dbRes.headers.get('content-disposition') ?? '').includes('.db'));

  console.log('\n需求 20：期初库存列表 / 筛选 / 导出');
  const initial = await api('/inventory/initial', { itemType: 'material', pageSize: 50000 });
  check('物料期初列表可查', Array.isArray(initial.list));
  check('返回期初数量字段', initial.list.length === 0 || initial.list[0].initial_qty !== undefined);
  const initialProd = await api('/inventory/initial', { itemType: 'product', pageSize: 50000 });
  check('成品期初列表可查', Array.isArray(initialProd.list));
  const initialKw = await api('/inventory/initial', { itemType: 'material', keyword: '不存在的物料XYZ', pageSize: 50000 });
  check('期初keyword筛选生效', initialKw.list.length === 0);

  console.log('\n需求 24：库存盘点筛选');
  const checks = await api('/warehouse/checks', { pageSize: 50000 });
  check('盘点列表可查', Array.isArray(checks.list));
  const checksStatus = await api('/warehouse/checks', { status: '已审核', pageSize: 50000 });
  check('状态筛选生效', checksStatus.list.every((r) => r.status === '已审核'));
  const checksDate = await api('/warehouse/checks', { dateFrom: '2099-01-01', pageSize: 50000 });
  check('日期筛选生效', checksDate.list.length === 0);

  console.log('\n需求 25：物料销售筛选 + 打印模板');
  const ms = await api('/warehouse/material-sales', { pageSize: 50000 });
  check('物料销售列表可查', Array.isArray(ms.list));
  const msDate = await api('/warehouse/material-sales', { dateFrom: '2099-01-01', pageSize: 50000 });
  check('日期筛选生效', msDate.list.length === 0);
  const tpls = await api('/system/print/templates');
  check('打印模板含物料销售单', tpls.some((t) => t.docType === 'material_sale'));

  console.log('\n需求 26：不良品出库筛选');
  const df = await api('/warehouse/defectives', { pageSize: 50000 });
  check('不良品列表可查', Array.isArray(df.list));
  const dfDate = await api('/warehouse/defectives', { dateFrom: '2099-01-01', pageSize: 50000 });
  check('日期筛选生效', dfDate.list.length === 0);
  const dfKw = await api('/warehouse/defectives', { materialKeyword: '不存在的物料XYZ', pageSize: 50000 });
  check('物料包含字筛选生效', dfKw.list.length === 0);

  console.log('\n需求 27/28：结算中心');
  const payables = await api('/finance/payables');
  const debt = payables.filter((p) => Number(p.payableAmount ?? 0) > 0.005);
  console.log(`  供应商 ${payables.length} 家，其中有欠款 ${debt.length} 家`);
  check('应付汇总可查', Array.isArray(payables));
  if (debt.length > 0) {
    const docs = await api(`/finance/payables/${debt[0].supplierId}/docs`);
    check('供应商待结算单据明细可查（需求 28 展开表格）', Array.isArray(docs.docs));
  }
  const settles = await api('/finance/settlements', { pageSize: 5 });
  check('付款单记录可查', Array.isArray(settles.list));
  if (settles.list.length > 0) {
    const d = await api(`/finance/settlements/${settles.list[0].id}`);
    check('付款单核销明细可查（需求 28）', Array.isArray(d.items));
  }

  console.log(`\n结果：通过 ${pass}，失败 ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('冒烟失败：', e.message);
  process.exit(1);
});
