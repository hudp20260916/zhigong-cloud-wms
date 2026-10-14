/**
 * 冒烟：生产工单「去入库」分流（已领部分 / 未领物料）+ 编辑回填依赖的接口。
 *
 * 用法（必须在干净库上跑，否则计划量 / 库存绝对值断言会受历史数据影响）：
 *   rm -f server/data/rp.db*; DB_FILE=server/data/rp.db PORT=3095 npx tsx server/src/index.ts &
 *   API_BASE=http://127.0.0.1:3095/api node server/scripts/smoke-wo-receipt.mjs
 */
const BASE = process.env.API_BASE || 'http://127.0.0.1:3001/api';

let token = '';
let pass = 0;
let fail = 0;
const today = new Date().toISOString().slice(0, 10);

async function call(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json };
}

function assert(name, cond, extra) {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${extra ? ` -> ${JSON.stringify(extra)}` : ''}`);
  }
}

async function main() {
  // ---------- 登录 ----------
  const login = await call('POST', '/auth/login', { username: 'admin', password: 'admin12345' });
  assert('登录成功', login.status === 200 && !!login.body?.data?.token, login.body);
  token = login.body?.data?.token ?? '';
  if (!token) throw new Error('无法获取 token，后续用例全部跳过');

  const D = (r) => r.body?.data ?? r.body;

  // ---------- 基础档案 ----------
  const mat = D(await call('POST', '/archive/materials', {
    name: `冒烟物料-${Date.now()}`, unit: '个', safetyStock: 0, isVirtual: false,
  }));
  const materialId = mat.id;
  assert('创建物料', !!materialId, mat);

  const init = await call('POST', '/inventory/initial', {
    items: [{ itemType: 'material', itemId: materialId, qty: 100000, price: 1 }],
  });
  assert('设置物料期初库存 100000', init.status === 200, init.body);

  const prod = D(await call('POST', '/archive/products', {
    name: `冒烟成品-${Date.now()}`, unit: '台', safetyStock: 0, bomVersion: 'V1.0',
    bom: [{ materialId, qty: 1 }], confirmNoBom: false,
  }));
  const productId = prod.id;
  assert('创建成品（BOM 用量 1）', !!productId, prod);

  // =========================================================
  // 场景一：未领物料 → 成品入库（直接扣料），按工单应发数量直接扣库存
  // =========================================================
  console.log('\n[场景一] 未领物料：直接扣料');
  const wo1 = D(await call('POST', '/production/work-orders', {
    productId, planQty: 100, bomVersion: 'V1.0', planStart: '', planEnd: '', remark: 'smoke-unissued',
  }));
  assert('创建工单 WO1 计划 100', !!wo1.id, wo1);

  const fr1 = D(await call('GET', `/production/work-orders/${wo1.id}/for-receipt`));
  assert('未领料 → 入库类型为「成品入库（直接扣料）」', fr1.receiptType === '成品入库（直接扣料）', fr1);
  assert('未领料 → 建议入库数 = 100（计划量 − 已入库）', fr1.suggestQty === 100, fr1);
  assert('未领料 → 数量不锁定（可分批入库）', fr1.locked === false, fr1);

  const r1 = await call('POST', '/production/receipts', {
    receiptType: '成品入库（直接扣料）', woId: wo1.id, issueId: null, receiptDate: today,
    items: [{ productId, qty: 40 }], skipProductIds: [], remark: 'smoke',
  });
  assert('未领料入库 40 成功', r1.status === 200, r1.body);

  const wo1After = D(await call('GET', `/production/work-orders/${wo1.id}`));
  assert('WO1 已入库量 = 40', Number(wo1After.received_qty) === 40, wo1After);

  const fr1b = D(await call('GET', `/production/work-orders/${wo1.id}/for-receipt`));
  assert('再次去入库建议数 = 60（应发 100 − 已入 40）', fr1b.suggestQty === 60, fr1b);

  // =========================================================
  // 场景二：已领部分物料 → 生产入库（已领料），数量 = 实际已领数量且锁定只读
  // =========================================================
  console.log('\n[场景二] 已领部分：按实际已领数量入库并锁定');
  const wo2 = D(await call('POST', '/production/work-orders', {
    productId, planQty: 100, bomVersion: 'V1.0', planStart: '', planEnd: '', remark: 'smoke-partial',
  }));
  const iss2 = D(await call('POST', '/production/issues', {
    woId: wo2.id, issueDate: today, produceQty: 60, remark: 'smoke',
  }));
  assert('WO2 领料 60 成功', !!iss2.id, iss2);

  const fr2 = D(await call('GET', `/production/work-orders/${wo2.id}/for-receipt`));
  assert('已领料 → 入库类型为「生产入库（已领料）」', fr2.receiptType === '生产入库（已领料）', fr2);
  assert('已领料 → 建议入库数 = 60（实际已领数量）', fr2.suggestQty === 60, fr2);
  assert('已领料 → 数量锁定为只读', fr2.locked === true, fr2);
  assert('已领料 → 回填唯一关联领料单', fr2.issueId === iss2.id, fr2);

  const bad2 = await call('POST', '/production/receipts', {
    receiptType: '生产入库（已领料）', woId: wo2.id, issueId: iss2.id, receiptDate: today,
    items: [{ productId, qty: 30 }], skipProductIds: [], remark: 'smoke',
  });
  assert('篡改锁定数量 30 → 服务端拒绝（409）', bad2.status === 409, bad2.body);

  const r2 = await call('POST', '/production/receipts', {
    receiptType: '生产入库（已领料）', woId: wo2.id, issueId: iss2.id, receiptDate: today,
    items: [{ productId, qty: 60 }], skipProductIds: [], remark: 'smoke',
  });
  assert('按已领数量 60 入库成功', r2.status === 200, r2.body);

  const wo2After = D(await call('GET', `/production/work-orders/${wo2.id}`));
  assert('WO2 已领 60 / 已入 60', Number(wo2After.issued_qty) === 60 && Number(wo2After.received_qty) === 60, wo2After);

  // 已领部分已入满、但计划量还没入满 → 仍要走「直接扣料」继续入未领部分
  // （早期版本在这里直接 409，把剩下的计划量一起堵死了，WO20261013-0030 就是这么被拦的）
  const fr2b = await call('GET', `/production/work-orders/${wo2.id}/for-receipt`);
  const d2b = fr2b.body?.data ?? {};
  assert('已领部分入满后 → 放行（200）', fr2b.status === 200, fr2b.body);
  assert('已领部分入满后 → 改走「成品入库（直接扣料）」', d2b.receiptType === '成品入库（直接扣料）', d2b);
  assert('已领部分入满后 → 建议数 = 40（计划 100 − 已入 60）', d2b.suggestQty === 40, d2b);
  assert('已领部分入满后 → 数量不锁定（可分批）', d2b.locked === false, d2b);

  const r2b = await call('POST', '/production/receipts', {
    receiptType: '成品入库（直接扣料）', woId: wo2.id, issueId: null, receiptDate: today,
    items: [{ productId, qty: 40 }], skipProductIds: [], remark: 'smoke',
  });
  assert('未领部分继续入库 40 成功', r2b.status === 200, r2b.body);
  const wo2Done = D(await call('GET', `/production/work-orders/${wo2.id}`));
  assert('WO2 累计入库 100 = 计划量', Number(wo2Done.received_qty) === 100, wo2Done);
  const fr2c = await call('GET', `/production/work-orders/${wo2.id}/for-receipt`);
  assert('计划量入满后 → 去入库才被拒（409）', fr2c.status === 409, fr2c.body);

  // =========================================================
  // 场景三：多张领料单 → 不回填 issueId，按工单累计可入库余量锁定
  // =========================================================
  console.log('\n[场景三] 多张领料单：按工单累计可入库余量');
  const wo3 = D(await call('POST', '/production/work-orders', {
    productId, planQty: 100, bomVersion: 'V1.0', planStart: '', planEnd: '', remark: 'smoke-multi',
  }));
  await call('POST', '/production/issues', { woId: wo3.id, issueDate: today, produceQty: 30, remark: 'smoke' });
  await call('POST', '/production/issues', { woId: wo3.id, issueDate: today, produceQty: 20, remark: 'smoke' });

  const fr3 = D(await call('GET', `/production/work-orders/${wo3.id}/for-receipt`));
  assert('多张领料单 → 建议入库数 = 50（30 + 20）', fr3.suggestQty === 50, fr3);
  assert('多张领料单 → 不回填关联领料单', fr3.issueId === undefined, fr3);
  assert('多张领料单 → 数量锁定', fr3.locked === true, fr3);

  const r3 = await call('POST', '/production/receipts', {
    receiptType: '生产入库（已领料）', woId: wo3.id, issueId: null, receiptDate: today,
    items: [{ productId, qty: 50 }], skipProductIds: [], remark: 'smoke',
  });
  assert('无关联领料单也能按工单余量入库 50', r3.status === 200, r3.body);

  const wo3After = D(await call('GET', `/production/work-orders/${wo3.id}`));
  assert('WO3 已领 50 / 已入 50', Number(wo3After.issued_qty) === 50 && Number(wo3After.received_qty) === 50, wo3After);

  // =========================================================
  // 场景四：编辑回填依赖的工单详情接口
  // =========================================================
  console.log('\n[场景四] 工单详情（编辑弹窗回填数据源）');
  const det = D(await call('GET', `/production/work-orders/${wo1.id}`));
  assert('详情返回 product_id / plan_qty / bom_version 供表单回填',
    det.product_id === productId && Number(det.plan_qty) === 100 && !!det.bom_version, det);

  const upd = await call('PUT', `/production/work-orders/${wo1.id}`, {
    productId, planQty: 120, bomVersion: 'V1.0', planStart: '', planEnd: '', remark: 'smoke-edit',
  });
  assert('编辑保存成功', upd.status === 200, upd.body);
  const det2 = D(await call('GET', `/production/work-orders/${wo1.id}`));
  assert('编辑后计划量 = 120', Number(det2.plan_qty) === 120, det2);

  console.log(`\n结果：PASS ${pass} / FAIL ${fail}`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error('脚本异常：', e);
  process.exit(1);
});
