/**
 * P5 财务与系统设置 冒烟测试
 *   node server/scripts/smoke-finance.mjs
 * 覆盖：结算中心 / 报表中心 / 打印模板 / Excel 导入 / 系统参数 / 系统初始化（最后一次执行）
 */
// 兼容两种写法：API_BASE 带 /api 后缀，BASE 不带
const API_BASE = process.env.API_BASE;
const BASE = API_BASE ? API_BASE.replace(/\/api$/, '') : (process.env.BASE ?? 'http://localhost:3001');

let token = '';
let failures = 0;

async function call(method, path, body, useToken = true) {
  const headers = { 'Content-Type': 'application/json' };
  if (useToken && token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(json)}`);
    e.status = res.status;
    e.body = json;
    throw e;
  }
  return json.data;
}

function check(name, cond, extra = '') {
  if (cond) console.log(`  ✓ ${name}${extra ? ` — ${extra}` : ''}`);
  else {
    failures++;
    console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`);
  }
}

async function login(username, password) {
  const d = await call('POST', '/api/auth/login', { username, password }, false);
  token = d.token;
  return d.user;
}

async function main() {
  console.log('== P5 冒烟：采购结算 ==');
  await login('admin', 'admin12345');

  // 自建待结算数据，保证脚本可重复执行、不依赖历史库状态
  const suppliers = await call('GET', '/api/archive/suppliers?pageSize=5');
  const materials = await call('GET', '/api/archive/materials?pageSize=50');
  const supplier = suppliers.list[0];
  const material = materials.list.find((m) => !m.is_virtual);
  const today = new Date().toISOString().slice(0, 10);

  const order = await call('POST', '/api/purchase/orders', {
    mode: 'direct',
    supplierId: supplier.id,
    orderDate: today,
    items: [{ materialId: material.id, qty: 200, price: 6 }],
  });
  const receipt = await call('POST', '/api/purchase/receipts', {
    orderId: order.id,
    supplierId: supplier.id,
    receiptDate: today,
    items: [{ materialId: material.id, qty: 200, price: 6 }],
    remark: '冒烟：结算用入库单',
  });
  check('结算用入库单已创建', !!receipt.id, `入库金额 1200`);

  const payables = await call('GET', '/api/finance/payables');
  check('应付汇总返回', Array.isArray(payables) && payables.length > 0, `${payables.length} 家供应商`);
  const target = payables.find((p) => Number(p.payableAmount) > 0);
  check('存在待结算供应商', !!target, target ? `${target.supplierName} 应付 ${target.payableAmount}` : '');
  if (!target) throw new Error('没有待结算数据，请先跑 db:reset + seed');

  const before = Number(target.payableAmount);

  const docs = await call('GET', `/api/finance/payables/${target.supplierId}/docs`);
  check('待结算单据列表', Array.isArray(docs.docs) && docs.docs.length > 0, `${docs.docs.length} 张`);
  check(
    '入库单不返回 receipt_no（需求 4.5）',
    docs.docs.every((d) => !('receipt_no' in d) && !('receiptNo' in d)),
  );

  // 核销试算
  const payAmount = Math.round(before / 2);
  const preview = await call('POST', '/api/finance/settlements/preview', {
    supplierId: target.supplierId,
    amount: payAmount,
  });
  check('试算返回分配结果', Array.isArray(preview.allocations) && preview.allocations.length > 0);
  const allocSum = preview.allocations.reduce((s, a) => s + Math.abs(a.applyAmount), 0);
  check('试算分配不超过付款额', allocSum <= payAmount + 0.01, `分配 ${allocSum} / 付款 ${payAmount}`);

  // 正式付款（自动核销）
  const created = await call('POST', '/api/finance/settlements', {
    supplierId: target.supplierId,
    settleDate: new Date().toISOString().slice(0, 10),
    method: '转账',
    amount: payAmount,
    mode: 'auto',
    remark: '冒烟测试付款',
  });
  check('付款单创建成功', !!created.id);

  const detail = await call('GET', `/api/finance/settlements/${created.id}`);
  check('付款单号已生成', /^ST\d{8}-\d{4}$/.test(detail.settlement.settle_no), detail.settlement.settle_no);
  check('核销明细已落库', detail.items.length > 0, `${detail.items.length} 条`);
  check(
    '核销明细不含 receipt_no',
    detail.items.every((i) => !('receipt_no' in i)),
  );

  const after = (await call('GET', '/api/finance/payables')).find((p) => p.supplierId === target.supplierId);
  check(
    '应付余额已减少',
    Math.abs(Number(after.payableAmount) - (before - payAmount)) < 0.02,
    `${before} -> ${after.payableAmount}`,
  );

  // 撤销
  await call('POST', `/api/finance/settlements/${created.id}/undo`);
  const restored = (await call('GET', '/api/finance/payables')).find((p) => p.supplierId === target.supplierId);
  check('撤销后应付恢复', Math.abs(Number(restored.payableAmount) - before) < 0.02, `-> ${restored.payableAmount}`);

  // 超额核销拦截
  let blocked = false;
  try {
    await call('POST', '/api/finance/settlements', {
      supplierId: target.supplierId,
      settleDate: new Date().toISOString().slice(0, 10),
      method: '转账',
      amount: 1,
      mode: 'manual',
      allocations: [{ docType: 'receipt', docId: docs.docs[0].docId, applyAmount: 999999 }],
    });
  } catch (e) {
    blocked = e.status === 400 || e.status === 409;
  }
  check('超额核销被拦截', blocked);

  console.log('\n== P5 冒烟：报表中心 ==');
  const meta = await call('GET', '/api/reports/meta');
  check('报表清单返回', Array.isArray(meta) && meta.length >= 9, `${meta.length} 个报表`);
  for (const m of meta) {
    const d = await call('GET', `/api/reports/data?kind=${m.kind}`);
    check(`报表 ${m.name} 取数`, Array.isArray(d.rows) && d.columns.length > 0, `${d.rows.length} 行`);
  }

  const io = await call('GET', '/api/reports/data?kind=stock.io');
  const sample = io.rows.find((r) => Number(r.close_qty) !== 0);
  if (sample) {
    const ok2 =
      Math.abs(
        Number(sample.open_qty) + Number(sample.in_qty) - Number(sample.out_qty) - Number(sample.close_qty),
      ) < 0.001;
    check('收发存勾稽：期初+入-出=期末', ok2, `${sample.item_name}: ${sample.open_qty}+${sample.in_qty}-${sample.out_qty}=${sample.close_qty}`);
  }

  console.log('\n== P5 冒烟：打印模板 ==');
  const tpls = await call('GET', '/api/system/print/templates');
  // 10 类：采购订单 / 入库 / 退货、生产工单、领料、成品入库、销售开单 / 出库 / 退货、物料销售
  check('模板清单 10 类', tpls.length === 10, `${tpls.length} 类`);

  const orders = await call('GET', '/api/purchase/orders?pageSize=5');
  const po = orders.list.find((o) => !o.parent_order_no) ?? orders.list[0];
  const html1 = await fetch(`${BASE}/api/system/print/render/purchase_order/${po.id}`, {
    headers: { Authorization: `Bearer ${token}` },
  }).then((r) => r.text());
  check('采购订单渲染出 HTML', html1.includes('<table') && html1.includes(po.order_no));

  // 入库单打印不得出现 receipt_no
  const receipts = await call('GET', '/api/purchase/receipts?pageSize=5');
  const pr = receipts.list[0];
  const html2 = await fetch(`${BASE}/api/system/print/render/purchase_receipt/${pr.id}`, {
    headers: { Authorization: `Bearer ${token}` },
  }).then((r) => r.text());
  check('采购入库单渲染', html2.includes('采购入库单'));
  check('打印件不含“入库单号”字样', !html2.includes('入库单号'));
  check('打印件不含 PR 单号', !/PR\d{8}-\d{4}/.test(html2));

  // 改模板 -> 预览生效
  const tpl = tpls.find((t) => t.docType === 'purchase_order');
  const custom = `<div class="doc"><div class="doc-title">自定义抬头 {{no}}</div>{{#items}}<div>{{name}} x {{qty}}</div>{{/items}}<div>合计 {{totalQty}} / {{amountCn}}</div></div>`;
  await call('PUT', `/api/system/print/templates/purchase_order`, {
    paper: tpl.paper,
    orientation: tpl.orientation,
    content: custom,
  });
  const pv = await call('POST', '/api/system/print/preview', {
    docType: 'purchase_order',
    content: custom,
    id: po.id,
  });
  check('自定义模板实时预览生效', pv.html.includes('自定义抬头') && pv.html.includes(po.order_no));
  check('金额大写渲染', /元/.test(pv.html), pv.html.match(/金额大写：[^<]*/)?.[0] ?? pv.html.match(/[^<>]*元[^<]*/)?.[0] ?? '');
  await call('POST', '/api/system/print/templates/purchase_order/reset');
  const reset = await call('GET', '/api/system/print/templates/purchase_order');
  check('恢复默认模板', reset.isCustom === 0);

  console.log('\n== P5 冒烟：Excel 导入 ==');
  const kinds = await call('GET', '/api/system/import/kinds');
  // 5 种：物料档案 / 供应商档案 / 客户档案 / 产品档案 / 期初库存
  check('导入类型 5 种', kinds.length === 5, kinds.map((k) => k.name).join('、'));

  const stamp = Date.now();
  const sup = await call('POST', '/api/system/import/execute', {
    kind: 'supplier',
    fileName: 'smoke.xlsx',
    rows: [{ code: `STEST${stamp}`, name: `冒烟供应商${stamp}`, contact: '张三', phone: '13800000000' }],
  });
  check('供应商导入成功', sup.success === 1 && sup.failed === 0, JSON.stringify(sup.errors));

  // 重名应失败并整批回滚
  const dup = await call('POST', '/api/system/import/execute', {
    kind: 'supplier',
    fileName: 'smoke.xlsx',
    rows: [
      { code: `SDUP${stamp}`, name: `冒烟供应商${stamp}` },
      { code: `SOK${stamp}`, name: `正常供应商${stamp}` },
    ],
  });
  check('重名整批回滚', dup.success === 0 && dup.failed === 1, JSON.stringify(dup.errors));
  const notExists = await call('GET', `/api/archive/suppliers?keyword=${encodeURIComponent(`正常供应商${stamp}`)}`);
  check('回滚后无残留数据', Number(notExists.total) === 0);

  const mat = await call('POST', '/api/system/import/execute', {
    kind: 'material',
    fileName: 'smoke.xlsx',
    rows: [
      {
        code: `MTEST${stamp}`,
        name: `冒烟物料${stamp}`,
        spec: 'TEST-1',
        unit: '个',
        safetyStock: 10,
        supplier: `冒烟供应商${stamp}`,
      },
    ],
  });
  check('物料导入成功（含供应商关联）', mat.success === 1, JSON.stringify(mat.errors));

  const badSupplier = await call('POST', '/api/system/import/execute', {
    kind: 'material',
    fileName: 'smoke.xlsx',
    rows: [{ code: `MBAD${stamp}`, name: `冒烟物料X${stamp}`, supplier: '不存在的供应商' }],
  });
  check('供应商不存在被拦截', badSupplier.failed === 1, JSON.stringify(badSupplier.errors));

  const initImp = await call('POST', '/api/system/import/execute', {
    kind: 'initial_stock',
    fileName: 'smoke.xlsx',
    rows: [{ code: `MTEST${stamp}`, itemType: '物料', qty: 88, price: 3.5 }],
  });
  check('期初库存导入成功', initImp.success === 1, JSON.stringify(initImp.errors));

  const stockRow = await call('GET', `/api/inventory/materials?keyword=${encodeURIComponent(`冒烟物料${stamp}`)}`);
  const srow = stockRow.list[0];
  check('期初数量生效', Number(srow.current_stock) === 88, `库存 ${srow.current_stock}`);
  check('期初单价写入加权成本', Number(srow.avg_cost) === 3.5, `成本 ${srow.avg_cost}`);

  // 重复导入 = 覆盖（设定语义）
  await call('POST', '/api/system/import/execute', {
    kind: 'initial_stock',
    fileName: 'smoke.xlsx',
    rows: [{ code: `MTEST${stamp}`, qty: 50, price: 4 }],
  });
  const stockRow2 = await call('GET', `/api/inventory/materials?keyword=${encodeURIComponent(`冒烟物料${stamp}`)}`);
  check('期初重复导入为覆盖而非累加', Number(stockRow2.list[0].current_stock) === 50, `库存 ${stockRow2.list[0].current_stock}`);

  console.log('\n== P5 冒烟：系统参数 & 预警 ==');
  const settings = await call('GET', '/api/system/settings');
  check('参数列表返回', settings.length >= 7, `${settings.length} 项`);
  await call('PUT', '/api/system/settings', { items: [{ key: 'alert.severeRatio', value: '0.8' }] });
  const after2 = await call('GET', '/api/system/settings');
  check('参数保存生效', after2.find((s) => s.key === 'alert.severeRatio').value === '0.8');
  let bad = false;
  try {
    await call('PUT', '/api/system/settings', { items: [{ key: 'alert.severeRatio', value: '99' }] });
  } catch (e) {
    bad = e.status === 400;
  }
  check('超范围参数被拦截', bad);
  await call('PUT', '/api/system/settings', { items: [{ key: 'alert.severeRatio', value: '0.5' }] });

  const alarm = await call('GET', '/api/warehouse/alarm');
  check('预警看板读取配置阈值', !!alarm.cards, JSON.stringify(alarm.cards));

  console.log('\n== P5 冒烟：系统初始化（放在最后，会清空数据） ==');

  /**
   * 安全护栏（事故教训）：本步骤会真实清空目标库的业务单据与基础档案。
   * 曾经因为没有显式指定 BASE，脚本按默认值连到本机 3001 的开发演示库，
   * 结果把本地演示数据全清了。
   * 因此：只要目标仍是默认地址且没有显式声明「我知道这是破坏性操作」，
   * 就跳过这一步并给出提示，而不是闷头执行。
   */
  const isDefaultTarget = /^https?:\/\/(localhost|127\.0\.0\.1):3001\/?$/.test(BASE);
  const allowed = process.env.ALLOW_SYSTEM_INIT === '1';
  if (isDefaultTarget && !allowed) {
    console.log('  ⚠ 已跳过：目标是默认开发库且未设置 ALLOW_SYSTEM_INIT=1');
    console.log('    本步骤会清空业务单据与基础档案。请显式指定临时库：');
    console.log('    rm -f server/data/rp.db*');
    console.log('    DB_FILE=server/data/rp.db PORT=3093 npx tsx server/src/index.ts');
    console.log('    ALLOW_SYSTEM_INIT=1 API_BASE=http://127.0.0.1:3093 node server/scripts/smoke-finance.mjs');
  } else {
  const pv2 = await call('GET', '/api/system/init/preview');
  check('预检返回待清空统计', Array.isArray(pv2.groups) && pv2.groups.length === 2);
  console.log(`    待清空：${pv2.groups.map((g) => `${g.label} ${g.total}`).join('，')}`);
  console.log(`    保留：${pv2.keep.join('、')}`);

  let rejected = false;
  try {
    await call('POST', '/api/system/init/execute', { groups: ['biz'], clearStock: true, confirmText: '清空' });
  } catch (e) {
    rejected = e.status === 400;
  }
  check('确认文字不正确被拒绝', rejected);

  const seqBefore = (await call('GET', '/api/purchase/orders?pageSize=5')).list
    .map((o) => Number(String(o.order_no).split('-')[1] ?? 0))
    .reduce((a, b) => Math.max(a, b), 0);
  const res2 = await call('POST', '/api/system/init/execute', {
    groups: ['biz', 'archive'],
    clearStock: true,
    confirmText: '确认清空',
  });
  check('系统初始化执行成功', res2.deletedRows > 0, `删除 ${res2.deletedRows} 行`);
  void seqBefore;

  const left = await call('GET', '/api/inventory/materials?pageSize=1');
  check('物料档案已清空', Number(left.total) === 0);
  const ordersLeft = await call('GET', '/api/purchase/orders?pageSize=1');
  check('业务单据已清空', Number(ordersLeft.total) === 0);
  const users = await call('GET', '/api/system/users?pageSize=1');
  check('账号保留', Number(users.total) > 0, `${users.total} 个账号`);

  const seq = await call('GET', '/api/reports/data?kind=purchase.supplier');
  check('清空后报表仍可取数', Array.isArray(seq.rows));

  // 编号不重置（需求 4.8）：清空后新建单据，序号必须继续递增而不是回到 0001
  const stamp2 = Date.now();
  await call('POST', '/api/system/import/execute', {
    kind: 'supplier',
    fileName: 'after-init.xlsx',
    rows: [{ code: `SAI${stamp2}`, name: `清空后供应商${stamp2}` }],
  });
  await call('POST', '/api/system/import/execute', {
    kind: 'material',
    fileName: 'after-init.xlsx',
    rows: [{ code: `MAI${stamp2}`, name: `清空后物料${stamp2}`, unit: '个' }],
  });
  const m2 = (await call('GET', '/api/archive/materials?pageSize=5')).list[0];
  const newOrder = await call('POST', '/api/purchase/orders', {
    mode: 'direct',
    orderDate: new Date().toISOString().slice(0, 10),
    items: [{ materialId: m2.id, qty: 10, price: 1 }],
  });
  const newList = (await call('GET', '/api/purchase/orders?pageSize=5')).list;
  const seqAfter = Number(String(newList[0].order_no).split('-')[1] ?? 0);
  check(
    '编号持续递增不重置（需求 4.8）',
    seqAfter > seqBefore,
    `清空前最大序号 ${seqBefore} → 清空后 ${newList[0].order_no}`,
  );
  void newOrder;

  console.log(`\n${failures === 0 ? '✅ P5 全部通过' : `❌ ${failures} 项失败`}`);
  if (failures > 0) process.exit(1);
  }
}

main().catch((e) => {
  console.error('冒烟失败：', e.message);
  process.exit(1);
});
