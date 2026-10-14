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

  // 先调大再回到下限：改成下限 100 会让「已入 100 = 计划 100」直接变已完工，
  // 之后的编辑会被「已完工禁止修改」拦截，所以调大的用例必须放在前面。
  const ok300 = await call('PUT', `/production/work-orders/${wo.id}`, {
    productId, planQty: 300, bomVersion: 'V1.0', planStart: today, planEnd: today, remark: 'smoke',
  });
  assert('改成 300（调大）→ 允许', ok300.status === 200, ok300.body);

  const ok99 = await call('PUT', `/production/work-orders/${wo.id}`, {
    productId, planQty: 100, bomVersion: 'V1.0', planStart: today, planEnd: today, remark: 'smoke',
  });
  assert('改成 100（= 下限）→ 允许', ok99.status === 200, ok99.body);

  // ---------- 规则 4：已完工禁止编辑；已发生业务禁止删除 ----------
  console.log('\n[规则 4] 已完工禁止编辑 / 已发生业务禁止删除');
  await call('PUT', `/production/work-orders/${wo.id}`, {
    productId, planQty: 100, bomVersion: 'V1.0', planStart: today, planEnd: today, remark: 'smoke',
  });
  const done = D(await call('GET', `/production/work-orders/${wo.id}`));
  assert('已入库量 = 计划量 → 状态变为「已完工」', done.status === '已完工', done);

  const editDown = await call('PUT', `/production/work-orders/${wo.id}`, {
    productId, planQty: 99, bomVersion: 'V1.0', planStart: today, planEnd: today, remark: 'smoke',
  });
  assert('已完工工单改小到 99 → 被拒（409）', editDown.status === 409, editDown.body);

  const editUp = await call('PUT', `/production/work-orders/${wo.id}`, {
    productId, planQty: 150, bomVersion: 'V1.0', planStart: today, planEnd: today, remark: 'smoke',
  });
  assert('已完工工单调大到 150 → 被拒（409）', editUp.status === 409, editUp.body);
  assert('提示为「已完工，禁止修改」', msg(editUp).includes('已完工'), msg(editUp));

  const list2 = await call('GET', `/production/work-orders?keyword=${encodeURIComponent(done.wo_no)}`);
  const row2 = (list2.body?.data?.list ?? []).find((r) => r.id === wo.id);
  assert('列表 canEdit = false（已完工不可编辑）', row2?.canEdit === false, row2);

  const del = await call('DELETE', `/production/work-orders/${wo.id}`);
  assert('已发生领料/入库的工单 → 删除被拒（409）', del.status === 409, del.body);

  // ---------- 主产品锁定：已领料 / 已入库的工单不允许换产品 ----------
  console.log('\n[主产品锁定] 已发生领料或入库 → 不可更换主产品');
  const productId2 = D(await call('POST', '/archive/products', {
    name: `冒烟成品2-${Date.now()}`, unit: '台', safetyStock: 0, bomVersion: 'V1.0',
    bom: [{ materialId, qty: 1 }], confirmNoBom: false,
  })).id;
  assert('创建第二个成品用于换产品测试', !!productId2);

  // 用一条「已领料但未完工」的工单测试，避免被「已完工禁止修改」抢先拦截
  const wo5 = D(await call('POST', '/production/work-orders', {
    productId, planQty: 200, bomVersion: 'V1.0', planStart: today, planEnd: today, remark: 'smoke-swap',
  }));
  await call('POST', '/production/issues', { woId: wo5.id, issueDate: today, produceQty: 50, remark: 'smoke' });
  const wo5Before = D(await call('GET', `/production/work-orders/${wo5.id}`));
  assert('构造已领料未完工工单（issued=50）', Number(wo5Before.issued_qty) === 50, wo5Before);

  const swap = await call('PUT', `/production/work-orders/${wo5.id}`, {
    productId: productId2, planQty: 200, bomVersion: 'V1.0', planStart: today, planEnd: today, remark: 'smoke',
  });
  assert('已领料的工单换主产品 → 409 拒绝', swap.status === 409, swap.body);
  assert('提示明确说明不允许更换主产品', msg(swap).includes('不允许更换主产品'), msg(swap));

  const keepSame = await call('PUT', `/production/work-orders/${wo5.id}`, {
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

  // ---------- BOM 需求预估（仅展示，不校验不拦截） ----------
  console.log('\n[BOM 预估] 选主产品 + 计划量 → 按 BOM 用量算需求并比对库存');
  const noProduct = await call('GET', '/production/work-orders/bom-preview?planQty=10');
  assert('未选主产品 → 400 且提示先选主产品',
    noProduct.status === 400 && msg(noProduct).includes('请先选择主产品'), noProduct.body);

  const zeroQty = D(await call('GET', `/production/work-orders/bom-preview?productId=${productId}&planQty=0`));
  assert('计划量为空/0 → 返回空明细且不报错',
    Array.isArray(zeroQty.items) && zeroQty.items.length === 0 && zeroQty.shortageCount === 0, zeroQty);

  const pvOk = D(await call('GET', `/production/work-orders/bom-preview?productId=${productId}&planQty=10`));
  const lineOk = (pvOk.items ?? []).find((i) => Number(i.materialId) === materialId);
  assert('返回 BOM 物料明细（含编码/名称/单位）',
    (pvOk.items ?? []).length >= 1 && !!lineOk?.materialCode, pvOk);
  assert('需求数量 = 计划量 × BOM 用量（10 × 1 = 10）', Number(lineOk?.requireQty) === 10, lineOk);
  assert('库存满足 → enough = true，整体 shortageCount = 0',
    (pvOk.items ?? []).every((i) => i.enough === true) && pvOk.shortageCount === 0, pvOk);

  const pvBad = D(await call('GET', `/production/work-orders/bom-preview?productId=${productId}&planQty=200000`));
  assert('需求大于库存 → enough = false', (pvBad.items ?? []).every((i) => i.enough === false), pvBad);
  assert('缺料项数 shortageCount 与明细一致',
    Number(pvBad.shortageCount) === (pvBad.items ?? []).filter((i) => !i.enough).length, pvBad);
  assert('缺料数量 = 需求 − 库存',
    (pvBad.items ?? []).every((i) => Math.abs(i.shortage - (i.requireQty - i.stock)) < 1e-6), pvBad);

  const shortWo = await call('POST', '/production/work-orders', {
    productId, planQty: 200000, bomVersion: 'V1.0', planStart: today, planEnd: '', remark: 'smoke-shortage',
  });
  assert('缺料状态仍可正常建单（只读提示，不拦截）', shortWo.status === 200, shortWo.body);

  // ---------- 复制工单 ----------
  console.log('\n[复制工单] 以原单为模板建新单');
  const src = D(await call('POST', '/production/work-orders', {
    productId, planQty: 120, bomVersion: 'V1.0', planStart: today, planEnd: today, remark: 'smoke-src',
  }));
  const srcDetail = D(await call('GET', `/production/work-orders/${src.id}`));
  assert('原单就绪（计划 120）', Number(srcDetail.plan_qty) === 120, srcDetail);

  const copied = await call('POST', '/production/work-orders', {
    productId: srcDetail.product_id,
    planQty: srcDetail.plan_qty,
    bomVersion: srcDetail.bom_version,
    planStart: today,   // 开工日期默认当天
    planEnd: '',        // 完工日期留空
    remark: srcDetail.remark,
  });
  const cp = D(copied);
  assert('复制建单成功（接口仅返回新单 id，单号由系统生成）', copied.status === 200 && !!cp.id, copied.body);

  const cpDetail = D(await call('GET', `/production/work-orders/${cp.id}`));
  assert('单号由系统自动生成且与原单不同',
    !!cpDetail.wo_no && cpDetail.wo_no !== srcDetail.wo_no && /^WO/i.test(cpDetail.wo_no), cpDetail);
  assert('复制单主产品 = 原单主产品', Number(cpDetail.product_id) === Number(srcDetail.product_id), cpDetail);
  assert('复制单计划量 = 原单计划量（120）', Number(cpDetail.plan_qty) === 120, cpDetail);
  assert('复制单 BOM 版本 = 原单', cpDetail.bom_version === srcDetail.bom_version, cpDetail);
  assert('复制单备注 = 原单备注', cpDetail.remark === srcDetail.remark, cpDetail);
  assert('复制单开工日期 = 当天', String(cpDetail.plan_start).slice(0, 10) === today, cpDetail);
  assert('复制单完工日期留空', !cpDetail.plan_end, cpDetail);
  assert('复制单未继承已领料 / 已入库数量（均为 0）',
    Number(cpDetail.issued_qty) === 0 && Number(cpDetail.received_qty) === 0, cpDetail);
  assert('复制单状态非已完工（保存后可继续编辑）', cpDetail.status !== '已完工', cpDetail);

  const patchEnd = await call('PUT', `/production/work-orders/${cp.id}`, {
    productId, planQty: 120, bomVersion: cpDetail.bom_version, planStart: today, planEnd: today, remark: 'smoke-copy',
  });
  assert('保存后可编辑补录完工日期', patchEnd.status === 200, patchEnd.body);
  const afterEnd = D(await call('GET', `/production/work-orders/${cp.id}`));
  assert('补录后完工日期已写入', String(afterEnd.plan_end).slice(0, 10) === today, afterEnd);

  const delCopy = await call('DELETE', `/production/work-orders/${cp.id}`);
  assert('复制单未发生业务时可删除', delCopy.status === 200, delCopy.body);

  console.log(`\n结果：PASS ${pass} / FAIL ${fail}`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error('脚本异常：', e);
  process.exit(1);
});
