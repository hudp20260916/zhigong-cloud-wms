/**
 * 冒烟：生产工单「编辑」新规则
 *   1) 已部分领料 → 允许编辑
 *   2) 已部分入库 → 允许编辑
 *   3) 计划数量不得低于 max(已领料, 已入库)
 *   4) 已完工 → 禁止编辑；已发生领料/入库 → 禁止删除
 *
 * 用法（干净库 + 临时端口）：
 *   DB_FILE=server/data/smoke-wo-edit.db PORT=3098 npx tsx server/src/index.ts &
 *   API_BASE=http://127.0.0.1:3098/api node server/scripts/smoke-wo-edit.mjs
 */
const BASE = process.env.API_BASE || 'http://127.0.0.1:3098/api';
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
const D = (r) => r.body?.data ?? r.body;
const msg = (r) => String(r.body?.error?.message ?? r.body?.message ?? '');

function assert(name, cond, extra) {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${extra !== undefined ? ` -> ${JSON.stringify(extra)}` : ''}`);
  }
}

async function main() {
  const login = await call('POST', '/auth/login', { username: 'admin', password: 'admin12345' });
  token = login.body?.data?.token ?? '';
  assert('登录成功', !!token, login.body);

  // ---------- 基础档案 ----------
  const materialId = D(await call('POST', '/archive/materials', {
    name: `冒烟物料-${Date.now()}`, unit: '个', safetyStock: 0, isVirtual: false,
  })).id;
  await call('POST', '/inventory/initial', {
    items: [{ itemType: 'material', itemId: materialId, qty: 100000, price: 1 }],
  });
  const productId = D(await call('POST', '/archive/products', {
    name: `冒烟成品-${Date.now()}`, unit: '台', safetyStock: 0, bomVersion: 'V1.0',
    bom: [{ materialId, qty: 1 }], confirmNoBom: false,
  })).id;
  assert('基础档案就绪', !!materialId && !!productId);

  // ---------- 构造：计划 200 / 已领 100 / 已入 100 ----------
  const wo = D(await call('POST', '/production/work-orders', {
    productId, planQty: 200, bomVersion: 'V1.0', planStart: today, planEnd: today, remark: 'smoke-edit',
  }));
  assert('创建工单：计划 200', !!wo.id, wo);

  const issue = D(await call('POST', '/production/issues', {
    woId: wo.id, issueDate: today, produceQty: 100, remark: 'smoke',
  }));
  assert('领料 100 成功', !!issue.id, issue);

  const fr = D(await call('GET', `/production/work-orders/${wo.id}/for-receipt`));
  const rec = await call('POST', '/production/receipts', {
    receiptType: '生产入库（已领料）', woId: wo.id, issueId: issue.id, receiptDate: today,
    items: [{ productId, qty: 100 }], skipProductIds: [], remark: 'smoke',
  });
  assert('入库 100 成功', rec.status === 200, rec.body);

  const cur = D(await call('GET', `/production/work-orders/${wo.id}`));
  assert('当前已领 100 / 已入 100', Number(cur.issued_qty) === 100 && Number(cur.received_qty) === 100, cur);
  assert('状态为「生产中」（未入满计划 200）', cur.status === '生产中', cur);

  // ---------- 规则 1 / 2：已领料 + 已入库 → 允许编辑 ----------
  console.log('\n[规则 1+2] 已部分领料 / 已部分入库仍可编辑');
  const list = await call('GET', `/production/work-orders?keyword=${encodeURIComponent(cur.wo_no)}`);
  const row = (list.body?.data?.list ?? []).find((r) => r.id === wo.id);
  assert('列表 canEdit = true（已领料 + 已入库）', row?.canEdit === true, row);

  const detail = D(await call('GET', `/production/work-orders/${wo.id}`));
  assert('详情接口返回 plan_start 供表单回填（日期字段）', !!detail.plan_start, detail);

  // ---------- 规则 3：计划数量下限 = max(已领, 已入) ----------
  console.log('\n[规则 3] 计划数量不得低于已领料 / 已入库数量');
  const bad = await call('PUT', `/production/work-orders/${wo.id}`, {
    productId, planQty: 99, bomVersion: 'V1.0', planStart: today, planEnd: today, remark: 'smoke',
  });
  assert('改成 99（< 100）→ 409 拒绝', bad.status === 409, bad.body);
  assert('错误提示含下限值 100', msg(bad).includes('不得低于 100'), msg(bad));
  assert('错误提示同时给出已领料 / 已入库数量',
    msg(bad).includes('已领料 100') && msg(bad).includes('已入库 100'), msg(bad));

  const ok99 = await call('PUT', `/production/work-orders/${wo.id}`, {
    productId, planQty: 100, bomVersion: 'V1.0', planStart: today, planEnd: today, remark: 'smoke',
  });
  assert('改成 100（= 下限）→ 允许', ok99.status === 200, ok99.body);

  const ok300 = await call('PUT', `/production/work-orders/${wo.id}`, {
    productId, planQty: 300, bomVersion: 'V1.0', planStart: today, planEnd: today, remark: 'smoke',
  });
  assert('改成 300（调大）→ 允许', ok300.status === 200, ok300.body);

  // ---------- 规则 4：已完工禁止编辑；已发生业务禁止删除 ----------
  console.log('\n[规则 4] 已完工仍可编辑（受下限约束）/ 已发生业务禁止删除');
  await call('PUT', `/production/work-orders/${wo.id}`, {
    productId, planQty: 100, bomVersion: 'V1.0', planStart: today, planEnd: today, remark: 'smoke',
  });
  const done = D(await call('GET', `/production/work-orders/${wo.id}`));
  assert('已入库量 = 计划量 → 状态变为「已完工」', done.status === '已完工', done);

  // 已完工若禁止编辑，会出现「计划量改到等于已入库量 → 立刻完工 → 永久锁死」的死结，
  // 因此这里放开：改大允许（追加生产），改小仍受下限约束
  const editDown = await call('PUT', `/production/work-orders/${wo.id}`, {
    productId, planQty: 99, bomVersion: 'V1.0', planStart: today, planEnd: today, remark: 'smoke',
  });
  assert('已完工工单改小到 99（低于已入 100）→ 仍被下限拒绝', editDown.status === 409, editDown.body);

  const editUp = await call('PUT', `/production/work-orders/${wo.id}`, {
    productId, planQty: 150, bomVersion: 'V1.0', planStart: today, planEnd: today, remark: 'smoke',
  });
  assert('已完工工单调大到 150 → 允许（可追加生产）', editUp.status === 200, editUp.body);
  const revived = D(await call('GET', `/production/work-orders/${wo.id}`));
  assert('调大后状态回退为「生产中」', revived.status === '生产中', revived);

  const list2 = await call('GET', `/production/work-orders?keyword=${encodeURIComponent(done.wo_no)}`);
  const row2 = (list2.body?.data?.list ?? []).find((r) => r.id === wo.id);
  assert('列表 canEdit = true（已完工也允许编辑）', row2?.canEdit === true, row2);

  const del = await call('DELETE', `/production/work-orders/${wo.id}`);
  assert('已发生领料/入库的工单 → 删除被拒（409）', del.status === 409, del.body);

  // ---------- 主产品锁定：已领料 / 已入库的工单不允许换产品 ----------
  console.log('\n[主产品锁定] 已发生领料或入库 → 不可更换主产品');
  const productId2 = D(await call('POST', '/archive/products', {
    name: `冒烟成品2-${Date.now()}`, unit: '台', safetyStock: 0, bomVersion: 'V1.0',
    bom: [{ materialId, qty: 1 }], confirmNoBom: false,
  })).id;
  assert('创建第二个成品用于换产品测试', !!productId2);

  const swap = await call('PUT', `/production/work-orders/${wo.id}`, {
    productId: productId2, planQty: 150, bomVersion: 'V1.0', planStart: today, planEnd: today, remark: 'smoke',
  });
  assert('已领料且已入库的工单换主产品 → 409 拒绝', swap.status === 409, swap.body);
  assert('提示明确说明不允许更换主产品', msg(swap).includes('不允许更换主产品'), msg(swap));

  const keepSame = await call('PUT', `/production/work-orders/${wo.id}`, {
    productId, planQty: 160, bomVersion: 'V1.0', planStart: today, planEnd: today, remark: 'smoke',
  });
  assert('不换产品、只改计划量 → 仍允许（不影响其它编辑）', keepSame.status === 200, keepSame.body);

  // ---------- 回归：未开工工单仍可自由编辑（含换产品） ----------
  console.log('\n[回归] 未开工工单编辑不受影响');
  const fresh = D(await call('POST', '/production/work-orders', {
    productId, planQty: 50, bomVersion: 'V1.0', planStart: '', planEnd: '', remark: 'smoke-fresh',
  }));
  const up = await call('PUT', `/production/work-orders/${fresh.id}`, {
    productId, planQty: 80, bomVersion: 'V1.0', planStart: '', planEnd: '', remark: 'smoke-fresh',
  });
  assert('未开工工单改计划量 50 → 80 成功', up.status === 200, up.body);
  const freshAfter = D(await call('GET', `/production/work-orders/${fresh.id}`));
  assert('改后计划量 = 80', Number(freshAfter.plan_qty) === 80, freshAfter);

  const swapFresh = await call('PUT', `/production/work-orders/${fresh.id}`, {
    productId: productId2, planQty: 80, bomVersion: 'V1.0', planStart: '', planEnd: '', remark: 'smoke',
  });
  assert('未领料未入库的工单 → 允许更换主产品', swapFresh.status === 200, swapFresh.body);
  const swapped = D(await call('GET', `/production/work-orders/${fresh.id}`));
  assert('主产品已换成第二个成品', Number(swapped.product_id) === productId2, swapped);
  const del2 = await call('DELETE', `/production/work-orders/${fresh.id}`);
  assert('未发生业务的工单可删除', del2.status === 200, del2.body);

  console.log(`\n结果：PASS ${pass} / FAIL ${fail}`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error('脚本异常：', e);
  process.exit(1);
});
