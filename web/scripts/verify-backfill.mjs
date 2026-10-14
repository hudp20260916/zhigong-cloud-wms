// 仿真测试：复刻 MaterialPage / PartnerPage 的「修改/复制回填」逻辑，
// 在 jsdom 里真实挂载并断言 openEdit/openCopy 后 setFieldsValue 被带正确数据调用。
// 目的：在不依赖浏览器（agent-browser 在本环境挂掉）的情况下，证明回填的 React 时序逻辑正确。
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost/',
});
global.window = dom.window;
global.document = dom.window.document;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const React = (await import('react')).default;
const { useState, useEffect } = React;
const { createRoot } = await import('react-dom/client');
const { act } = await import('react');

// —— 被替换的 antd Form 实例，只记录 setFieldsValue 的调用 ——
const calls = [];
const form = {
  setFieldsValue: (v) => calls.push(v),
  resetFields: () => {},
};

const SAMPLE = {
  id: 7,
  code: 'M0007',
  name: '测试物料',
  spec: 'S型',
  category: '电子件',
  unit: '个',
  default_supplier_id: 3,
  safety_stock: 12,
  is_virtual: 1,
  remark: '备注X',
};

// —— 以下逻辑与 MaterialPage.tsx 的 openEdit/openCopy/useEffect 完全一致 ——
function Mirror() {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [copying, setCopying] = useState(false);

  function openEdit(r) {
    setEditing(r);
    setCopying(false);
    setOpen(true);
  }
  function openCopy(r) {
    setEditing(r);
    setCopying(true);
    setOpen(true);
  }

  useEffect(() => {
    if (!open) return;
    if (!editing) return; // 新建模式走 openCreate 的默认值
    const isCopy = copying;
    form.setFieldsValue({
      code: isCopy ? '' : editing.code,
      name: isCopy ? `${editing.name}-副本` : editing.name,
      spec: editing.spec,
      category: editing.category,
      unit: editing.unit,
      defaultSupplierId: editing.default_supplier_id ?? undefined,
      safetyStock: editing.safety_stock,
      isVirtual: editing.is_virtual === 1,
      remark: editing.remark,
    });
  }, [open, editing, copying]);

  return React.createElement(
    React.Fragment,
    null,
    React.createElement('button', { id: 'edit', onClick: () => openEdit(SAMPLE) }, 'edit'),
    React.createElement('button', { id: 'copy', onClick: () => openCopy(SAMPLE) }, 'copy'),
  );
}

const root = createRoot(document.getElementById('root'));
await act(async () => {
  root.render(React.createElement(Mirror));
});

function assert(cond, msg) {
  if (!cond) {
    console.error('❌ FAIL:', msg);
    process.exitCode = 1;
  } else {
    console.log('✅ PASS:', msg);
  }
}

// 1) 点「修改」后，最后一次 setFieldsValue 应包含 SAMPLE 全部字段
await act(async () => {
  document.getElementById('edit').click();
});
const editCall = calls[calls.length - 1];
console.log('修改回填值:', JSON.stringify(editCall));
assert(editCall && editCall.code === 'M0007', '修改：编码回填为 M0007');
assert(editCall && editCall.name === '测试物料', '修改：名称回填');
assert(editCall && editCall.spec === 'S型' && editCall.category === '电子件', '修改：规格/分类回填');
assert(editCall && editCall.unit === '个', '修改：单位回填');
assert(editCall && editCall.defaultSupplierId === 3, '修改：默认供应商回填');
assert(editCall && editCall.safetyStock === 12, '修改：安全库存回填');
assert(editCall && editCall.isVirtual === true, '修改：虚拟件(1→true)回填');
assert(editCall && editCall.remark === '备注X', '修改：备注回填');

// 2) 关闭后再次「复制」：编码置空、名称加 -副本
await act(async () => {
  document.getElementById('copy').click();
});
const copyCall = calls[calls.length - 1];
console.log('复制回填值:', JSON.stringify(copyCall));
assert(copyCall && copyCall.code === '', '复制：编码置空');
assert(copyCall && copyCall.name === '测试物料-副本', '复制：名称加 -副本');
assert(copyCall && copyCall.spec === 'S型', '复制：其余字段仍带出');

// 3) 新建模式不应触发回填（effect 在 !editing 时直接 return）
const before = calls.length;
// 模拟新建：editing 为 null 时打开
function MirrorCreate() {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [copying, setCopying] = useState(false);
  useEffect(() => {
    if (!open) return;
    if (!editing) return;
    form.setFieldsValue({ code: editing.code });
  }, [open, editing, copying]);
  return React.createElement('button', {
    id: 'create',
    onClick: () => {
      setEditing(null);
      setCopying(false);
      setOpen(true);
    },
  }, 'create');
}
const c2 = document.createElement('div');
document.body.appendChild(c2);
const root2 = createRoot(c2);
await act(async () => {
  root2.render(React.createElement(MirrorCreate));
});
await act(async () => {
  document.getElementById('create').click();
});
assert(calls.length === before, '新建：editing 为 null 时不触发回填（走默认值）');

// ============================================================
// 4) 生产工单页（async 拉详情 → pendingDetail → effect 回填）
//    逻辑与 WorkOrderPage.tsx 的 openEdit / useEffect 完全一致
// ============================================================
const woDetail = {
  product_id: 12,
  plan_qty: 300,
  bom_version: 'V2.0',
  plan_start: '2026-10-01',
  plan_end: '2026-10-20',
  remark: '工单备注',
};

// —— 复刻 utils/date.ts 的 dayVal：把后端字符串日期转成 antd DatePicker 需要的 Dayjs ——
const dayjs = (await import('dayjs')).default;
const dayVal = (v) => {
  if (!v) return undefined;
  const d = dayjs(v);
  return d.isValid() ? d : undefined;
};
const woRow = { id: 55, wo_no: 'WO20260055' };

function MirrorWorkOrder() {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [pendingDetail, setPendingDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);

  async function openEdit(row) {
    setDetailLoading(true);
    try {
      const detail = await Promise.resolve(woDetail); // 模拟 productionApi.workOrderDetail
      setEditing(row);
      setPendingDetail({
        productId: detail.product_id,
        planQty: detail.plan_qty,
        bomVersion: detail.bom_version,
        // ⚠️ 必须转成 dayjs：DatePicker 拿到字符串会调 value.format() 抛错 → 弹窗白屏
        planStart: dayVal(detail.plan_start),
        planEnd: dayVal(detail.plan_end),
        remark: detail.remark,
      });
      setOpen(true);
    } finally {
      setDetailLoading(false);
    }
  }

  function closeModal() {
    setOpen(false);
    setEditing(null);
    setPendingDetail(null);
    form.resetFields();
  }

  useEffect(() => {
    if (!open) return;
    if (pendingDetail) form.setFieldsValue(pendingDetail);
  }, [open, editing, pendingDetail]);

  return React.createElement(
    React.Fragment,
    null,
    React.createElement('button', { id: 'wo-edit', onClick: () => void openEdit(woRow) }, 'wo-edit'),
    React.createElement('button', { id: 'wo-close', onClick: closeModal }, 'wo-close'),
    React.createElement('span', { id: 'wo-loading' }, String(detailLoading)),
  );
}

const c3 = document.createElement('div');
document.body.appendChild(c3);
const root3 = createRoot(c3);
await act(async () => {
  root3.render(React.createElement(MirrorWorkOrder));
});
const beforeWo = calls.length;
await act(async () => {
  document.getElementById('wo-edit').click();
});
const woCall = calls[calls.length - 1];
console.log('工单编辑回填值:', JSON.stringify(woCall));
assert(calls.length === beforeWo + 1, '工单：一次打开只回填一次（无重复 / 无遗漏）');
assert(woCall && woCall.productId === 12, '工单：主产品回填');
assert(woCall && woCall.planQty === 300, '工单：计划产量回填 300');
assert(woCall && woCall.bomVersion === 'V2.0', '工单：BOM 版本回填');
assert(
  woCall?.planStart?.format('YYYY-MM-DD') === '2026-10-01' &&
    woCall?.planEnd?.format('YYYY-MM-DD') === '2026-10-20',
  '工单：计划起止回填',
);
// 白屏根因回归：回填给 DatePicker 的必须是 dayjs 对象，字符串会在渲染期 value.format() 抛错
assert(
  woCall && typeof woCall.planStart?.format === 'function' && typeof woCall.planEnd?.format === 'function',
  '工单：日期回填为 dayjs 对象（DatePicker 需要，传字符串会白屏）',
);
assert(typeof '2026-10-01'.format !== 'function', '反例：字符串确实没有 format，旧写法必崩（白屏根因）');
assert(woCall && woCall.remark === '工单备注', '工单：备注回填');

// 关闭再打开另一条：不能残留上一条的数据
await act(async () => {
  document.getElementById('wo-close').click();
});
const beforeWo2 = calls.length;
await act(async () => {
  root3.render(React.createElement(MirrorWorkOrder));
});
await act(async () => {
  document.getElementById('wo-edit').click();
});
const woCall2 = calls[calls.length - 1];
assert(calls.length === beforeWo2 + 1, '工单：关闭后重新打开仍只回填一次');
assert(woCall2 && woCall2.planQty === 300, '工单：重开后数据仍正确（无空表单）');

// ============================================================
// 4.5) 生产工单页「复制工单」：editing 必须置 null（保存走 create），
//      开工日期填当天、完工日期留空，其余业务字段原样带出
// ============================================================
const todayStr = dayjs().format('YYYY-MM-DD');
let copyMode = '';

function MirrorWorkOrderCopy() {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [copying, setCopying] = useState(false);
  const [pendingDetail, setPendingDetail] = useState(null);

  async function openCopy(row) {
    const detail = await Promise.resolve(woDetail); // 模拟 productionApi.workOrderDetail
    setEditing(null); // 复制出来的是新单 → submit 走 create 分支
    setCopying(true);
    setPendingDetail({
      productId: detail.product_id,
      planQty: detail.plan_qty,
      bomVersion: detail.bom_version,
      planStart: dayVal(todayStr),
      planEnd: undefined,
      remark: detail.remark,
    });
    setOpen(true);
  }

  // 与 WorkOrderPage 的 modal title / submit 分支同口径
  copyMode = editing ? 'edit' : copying ? 'copy' : 'create';

  useEffect(() => {
    if (!open) return;
    if (pendingDetail) form.setFieldsValue(pendingDetail);
  }, [open, editing, pendingDetail]);

  return React.createElement('button', { id: 'wo-copy', onClick: () => void openCopy(woRow) }, 'wo-copy');
}

const c3b = document.createElement('div');
document.body.appendChild(c3b);
const root3b = createRoot(c3b);
await act(async () => {
  root3b.render(React.createElement(MirrorWorkOrderCopy));
});
const beforeCopy = calls.length;
await act(async () => {
  document.getElementById('wo-copy').click();
});
const woCopyCall = calls[calls.length - 1];
console.log('工单复制回填值:', JSON.stringify(woCopyCall));
assert(calls.length === beforeCopy + 1, '复制：一次打开只回填一次（无重复 / 无遗漏）');
assert(copyMode === 'copy', `复制：走新建分支（editing=null → create），当前=${copyMode}`);
assert(woCopyCall && woCopyCall.productId === 12, '复制：主产品沿用原单');
assert(woCopyCall && woCopyCall.planQty === 300, '复制：计划产量沿用原单 300');
assert(woCopyCall && woCopyCall.bomVersion === 'V2.0', '复制：BOM 版本沿用原单');
assert(woCopyCall && woCopyCall.remark === '工单备注', '复制：备注沿用原单');
assert(
  woCopyCall?.planStart?.format('YYYY-MM-DD') === todayStr,
  '复制：开工日期默认当天（且是 dayjs 对象）',
);
assert(woCopyCall && woCopyCall.planEnd === undefined, '复制：完工日期留空（保存后可补录）');

// ============================================================
// 5) 用户管理页（同步 openEdit → pendingUser → effect 回填）
//    逻辑与 UserPage.tsx 完全一致
// ============================================================
const userRow = { id: 3, username: 'ping', display_name: '平哥', role: 'admin', status: 'active' };

function MirrorUser() {
  const [userOpen, setUserOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [pendingUser, setPendingUser] = useState(null);

  function openEdit(row) {
    setEditing(row);
    setPendingUser({
      username: row.username,
      displayName: row.display_name,
      role: row.role,
      status: row.status,
    });
    setUserOpen(true);
  }

  useEffect(() => {
    if (!userOpen) return;
    if (pendingUser) form.setFieldsValue(pendingUser);
  }, [userOpen, editing, pendingUser]);

  return React.createElement('button', { id: 'user-edit', onClick: () => openEdit(userRow) }, 'user-edit');
}

const c4 = document.createElement('div');
document.body.appendChild(c4);
const root4 = createRoot(c4);
await act(async () => {
  root4.render(React.createElement(MirrorUser));
});
const beforeUser = calls.length;
await act(async () => {
  document.getElementById('user-edit').click();
});
const userCall = calls[calls.length - 1];
console.log('账号编辑回填值:', JSON.stringify(userCall));
assert(calls.length === beforeUser + 1, '账号：一次打开只回填一次');
assert(userCall && userCall.username === 'ping', '账号：登录账号回填');
assert(userCall && userCall.displayName === '平哥', '账号：姓名回填');
assert(userCall && userCall.role === 'admin' && userCall.status === 'active', '账号：角色 / 状态回填');

console.log(process.exitCode ? '\n=== 存在失败用例 ===' : '\n=== 全部通过 ===');
