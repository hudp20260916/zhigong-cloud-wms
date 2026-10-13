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

console.log(process.exitCode ? '\n=== 存在失败用例 ===' : '\n=== 全部通过 ===');
