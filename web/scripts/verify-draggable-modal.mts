/**
 * 仿真测试：在 jsdom 里真实挂载 DraggableModal，验证拖拽行为。
 *
 * 覆盖：
 *   1) 标题栏按下 → window mousemove → .ant-modal 的 transform 跟着变
 *   2) 拖到屏幕外时被 clamp 在可视区内（边界保护）
 *   3) 拖拽期间 body.userSelect = 'none'（禁止选中文本），松手恢复
 *   4) 关闭弹窗后 transform 复位（下次打开仍是默认居中）
 *   5) 标题栏上的按钮不触发拖拽
 *
 * 用法：npx tsx web/scripts/verify-draggable-modal.mts
 */
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
});
const g = globalThis as any;
g.window = dom.window;
g.document = dom.window.document;
// 注意：Node 22 的 globalThis.navigator 是只读 getter，不能赋值（verify-backfill 里踩过）
g.HTMLElement = dom.window.HTMLElement;
// rc-util 检测 shadow DOM 时直接引用全局 ShadowRoot，jsdom 里挂在 window 上
g.ShadowRoot = dom.window.ShadowRoot;
g.Element = dom.window.Element;
g.Node = dom.window.Node;
g.MouseEvent = dom.window.MouseEvent;
g.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
g.requestAnimationFrame = (cb: any) => setTimeout(cb, 0);
g.cancelAnimationFrame = (id: any) => clearTimeout(id);
g.IS_REACT_ACT_ENVIRONMENT = true;
// antd 内部用到 ResizeObserver，jsdom 没有，给个空壳
g.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
dom.window.matchMedia =
  dom.window.matchMedia ||
  (() => ({
    matches: false,
    media: '',
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => false,
  }));

/** 视口尺寸固定，便于算边界 */
const VW = 1200;
const VH = 800;
Object.defineProperty(dom.window.document.documentElement, 'clientWidth', {
  value: VW,
  configurable: true,
});
Object.defineProperty(dom.window.document.documentElement, 'clientHeight', {
  value: VH,
  configurable: true,
});

const React = (await import('react')).default;
const { createRoot } = await import('react-dom/client');
const { act } = await import('react');
const { Modal } = await import('../src/components/DraggableModal.tsx');

let pass = 0;
let fail = 0;
function assert(name: string, cond: boolean, extra?: any) {
  if (cond) {
    pass++;
    console.log(`✅ PASS: ${name}`);
  } else {
    fail++;
    console.log(`❌ FAIL: ${name}${extra !== undefined ? ` -> ${JSON.stringify(extra)}` : ''}`);
  }
}

const container = document.createElement('div');
document.body.appendChild(container);
const root = createRoot(container);

let open = true;
function render(nextOpen: boolean) {
  open = nextOpen;
  return root.render(
    React.createElement(
      Modal,
      { open: nextOpen, title: '测试弹窗' },
      React.createElement('div', null, '内容'),
    ),
  );
}

await act(async () => {
  render(true);
});

const modalEl = document.querySelector('.ant-modal') as any;
assert('弹窗已渲染 .ant-modal', !!modalEl);
if (!modalEl) process.exit(1);

// jsdom 的 getBoundingClientRect 恒为 0，这里给一个真实尺寸用于算边界
const RECT = { left: 100, top: 50, width: 600, height: 400, right: 700, bottom: 450 };
modalEl.getBoundingClientRect = () => ({ ...RECT, x: RECT.left, y: RECT.top, toJSON: () => RECT });

const handle = document.querySelector('.dm-drag-handle') as any;
assert('标题栏生成拖拽把手 .dm-drag-handle', !!handle);
assert('把手样式为 move 光标且禁选中', handle?.style?.cursor === 'move' && handle?.style?.userSelect === 'none', {
  cursor: handle?.style?.cursor,
  userSelect: handle?.style?.userSelect,
});

function mouse(type: string, target: any, clientX: number, clientY: number) {
  const ev = new dom.window.MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    clientX,
    clientY,
  });
  target.dispatchEvent(ev);
}

// —— 1) 拖动：从 (200,100) 移到 (300,200) → 位移 (100,100) ——
await act(async () => {
  mouse('mousedown', handle, 200, 100);
});
assert('按下标题栏后禁止选中文本', document.body.style.userSelect === 'none', document.body.style.userSelect);
assert('按下标题栏后光标为 move', document.body.style.cursor === 'move', document.body.style.cursor);

await act(async () => {
  mouse('mousemove', dom.window, 300, 200);
});
let transform = modalEl.style.transform;
assert('拖动后 transform = translate(100px, 100px)', transform === 'translate(100px, 100px)', transform);

// —— 2) 边界：往左上角拖很远，应被 clamp 到「弹窗不超出视口 - 8px」——
await act(async () => {
  mouse('mousemove', dom.window, -5000, -5000);
});
transform = modalEl.style.transform;
// minX = -left + 8 = -92；minY = -top + 8 = -42
assert('左/上超界被 clamp 到 -92 / -42', transform === 'translate(-92px, -42px)', transform);

await act(async () => {
  mouse('mousemove', dom.window, 5000, 5000);
});
transform = modalEl.style.transform;
// maxX = VW - (left + width) - 8 = 1200 - 700 - 8 = 492；maxY = 800 - 450 - 8 = 342
assert('右/下超界被 clamp 到 492 / 342', transform === 'translate(492px, 342px)', transform);

// —— 3) 松手恢复 ——
await act(async () => {
  mouse('mouseup', dom.window, 5000, 5000);
});
assert('松手后恢复文本可选中', document.body.style.userSelect === '', `"${document.body.style.userSelect}"`);
assert('松手后恢复光标', document.body.style.cursor === '', `"${document.body.style.cursor}"`);

// —— 4) 关闭复位 ——
await act(async () => {
  render(false);
});
transform = modalEl.style.transform;
assert('关闭后 transform 复位（下次打开默认居中）', !transform, `"${transform}"`);

// —— 5) 标题栏上的按钮不触发拖拽 ——
await act(async () => {
  render(true);
});
const handle2 = document.querySelector('.dm-drag-handle') as any;
const btn = document.createElement('button');
btn.textContent = 'X';
handle2.appendChild(btn);
await act(async () => {
  mouse('mousedown', btn, 200, 100);
});
assert('点标题栏里的按钮不进入拖拽（body 未被锁）', document.body.style.userSelect === '', document.body.style.userSelect);

console.log(`\n=== ${fail === 0 ? '全部通过' : `失败 ${fail} 项`}（PASS ${pass} / FAIL ${fail}）===`);
if (fail > 0) process.exit(1);
