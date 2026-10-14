/**
 * 「点行任意位置即选中」统一交互的断言脚本（jsdom 真实挂载 ResponsiveTable）。
 *
 * 覆盖：
 *  桌面端表格行 —— 点普通单元格选中、同步行首单选圆点、再点一次取消选中
 *  排除规则     —— 行内 button / a / 展开箭头 / 勾选列 都不触发选中
 *  样式          —— 选中行加 row-selected，且不覆盖调用方自己的 rowClassName
 *  移动端卡片    —— 点卡片选中并高亮，点卡片里的按钮不触发
 *
 * 用法：
 *   npx tsx --tsconfig web/tsconfig.json web/scripts/verify-row-select.mts
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
});
const g = globalThis as any;
g.window = dom.window;
g.document = dom.window.document;
g.HTMLElement = dom.window.HTMLElement;
g.Element = dom.window.Element;
g.Node = dom.window.Node;
g.MouseEvent = dom.window.MouseEvent;
g.KeyboardEvent = dom.window.KeyboardEvent;
g.SVGElement = dom.window.SVGElement;
g.HTMLInputElement = dom.window.HTMLInputElement;
g.localStorage = dom.window.localStorage;
g.sessionStorage = dom.window.sessionStorage;
const rawGCS = dom.window.getComputedStyle.bind(dom.window);
const safeGCS = (elt: any, _p?: string) => rawGCS(elt);
dom.window.getComputedStyle = safeGCS as any;
g.getComputedStyle = safeGCS;
g.requestAnimationFrame = (cb: any) => setTimeout(cb, 0);
g.cancelAnimationFrame = (id: any) => clearTimeout(id);
g.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
g.ShadowRoot = dom.window.ShadowRoot;

/** 用这个开关控制 useIsMobile 的返回值，同一份脚本跑桌面 / 移动两种形态 */
let MOBILE = false;
const fakeMM = () =>
  ({
    get matches() {
      return MOBILE;
    },
    media: '',
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => false,
  }) as any;
dom.window.matchMedia = fakeMM as any;
g.matchMedia = fakeMM;
g.IS_REACT_ACT_ENVIRONMENT = true;

const { createServer } = await import('vite');
const server = await createServer({
  root: WEB_ROOT,
  configFile: path.join(WEB_ROOT, 'vite.config.ts'),
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'error',
});

const React = (await import('react')).default;
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');

const { ResponsiveTable } = await server.ssrLoadModule('src/components/ResponsiveTable.tsx');
const { useRowSelect } = await server.ssrLoadModule('src/components/RowActions.tsx');

const ROWS = [
  { id: 1, name: '单据A' },
  { id: 2, name: '单据B' },
];

let selectedCount = 0;

function Demo() {
  const { selectedId, rowSelection, onRowClick } = useRowSelect();
  selectedCount = selectedId === null ? 0 : 1;
  return React.createElement(ResponsiveTable, {
    rowKey: 'id',
    size: 'small',
    dataSource: ROWS,
    // 调用方自己的 rowClassName 不能被覆盖（库存页 low-stock-row / 台账页 voided-row 同理）
    rowClassName: (r: any) => (r.id === 2 ? 'low-stock-row' : ''),
    rowSelection,
    onRowClick: (row: any) => {
      (window as any).__rowClicks.push(row.id);
      onRowClick(row);
    },
    selectedRowKeys: selectedId === null ? [] : [selectedId],
    expandable: {
      expandedRowRender: () => React.createElement('div', null, '明细内容'),
    },
    columns: [
      { title: '名称', dataIndex: 'name', render: (v: string) => React.createElement('span', { className: 'cell-text' }, v) },
      {
        title: '操作',
        render: () =>
          React.createElement(
            'button',
            { className: 'in-row-btn', onClick: (e: any) => e.preventDefault() },
            '行内按钮',
          ),
      },
      {
        title: '链接',
        render: () =>
          React.createElement(
            'a',
            { className: 'in-row-link', href: '#x', onClick: (e: any) => e.preventDefault() },
            '行内链接',
          ),
      },
    ],
  });
}

let pass = 0;
let fail = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    pass += 1;
    console.log('✅ PASS:', msg);
  } else {
    fail += 1;
    console.error('❌ FAIL:', msg);
  }
}

const container = document.getElementById('root')!;
const root = createRoot(container);
(window as any).__rowClicks = [];

async function click(el: Element | null | undefined, label: string) {
  if (!el) {
    assert(false, `${label}：找不到目标元素`);
    return;
  }
  (window as any).__rowClicks = [];
  await act(async () => {
    (el as HTMLElement).click();
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 10));
  });
}

const clicks = () => (window as any).__rowClicks as number[];

// ===================== 桌面端 =====================
MOBILE = false;
await act(async () => {
  root.render(React.createElement(Demo));
});
await act(async () => {
  await new Promise((r) => setTimeout(r, 20));
});

assert(container.querySelectorAll('tbody tr.ant-table-row').length === 2, '桌面端渲染出 2 行数据');

const rows = () => Array.from(container.querySelectorAll('tbody tr.ant-table-row')) as HTMLElement[];

await click(rows()[0].querySelector('.cell-text'), '桌面：点名称单元格');
assert(clicks().length === 1 && clicks()[0] === 1, '桌面：点普通单元格触发选中（回调收到 id=1）');
assert(rows()[0].className.includes('row-selected'), '桌面：选中行加上 row-selected 高亮类');
assert(
  (rows()[0].querySelector('input.ant-radio-input') as HTMLInputElement | null)?.checked === true,
  '桌面：行首单选圆点同步为选中态',
);
assert(rows()[1].className.includes('low-stock-row'), '桌面：调用方自己的 rowClassName 没被覆盖');

await click(rows()[0].querySelector('.cell-text'), '桌面：再点一次同一行');
assert(clicks()[0] === 1 && selectedCount === 0, '桌面：再点一次已选中行 = 取消选中');
assert(!rows()[0].className.includes('row-selected'), '桌面：取消选中后高亮移除');

await click(rows()[1].querySelector('.cell-text'), '桌面：点第二行');
assert(clicks()[0] === 2 && selectedCount === 1, '桌面：切换到第二行');
assert(rows()[1].className.includes('row-selected'), '桌面：第二行高亮');
assert(!rows()[0].className.includes('row-selected'), '桌面：第一行取消高亮（单选互斥）');

await click(rows()[1].querySelector('button.in-row-btn'), '桌面：点行内按钮');
assert(clicks().length === 0, '桌面：行内 button 不触发选中');

await click(rows()[1].querySelector('a.in-row-link'), '桌面：点行内链接');
assert(clicks().length === 0, '桌面：行内 a 链接不触发选中');

await click(rows()[1].querySelector('.ant-table-row-expand-icon'), '桌面：点展开箭头');
assert(clicks().length === 0, '桌面：展开箭头不触发选中');

await click(rows()[1].querySelector('td.ant-table-selection-column'), '桌面：点勾选列');
assert(clicks().length === 0, '桌面：勾选列不触发选中（保留 antd 自己的勾选语义）');

// 排除规则不能影响「点单元格空白处」
await click(rows()[0].querySelectorAll('td')[0], '桌面：点第一个 td（勾选列之外的空白）');
assert(clicks().length === 1, '桌面：点 td 空白处仍可选中');

// ===================== 移动端卡片 =====================
MOBILE = true;
await act(async () => {
  root.render(React.createElement('div'));
});
await act(async () => {
  root.render(React.createElement(Demo));
});
await act(async () => {
  await new Promise((r) => setTimeout(r, 20));
});

const cards = () => Array.from(container.querySelectorAll('.mobile-card')) as HTMLElement[];
assert(cards().length === 2, '移动端渲染出 2 张卡片');

await click(cards()[0].querySelector('.mobile-card__title'), '移动：点卡片标题');
assert(clicks()[0] === 1, '移动：点卡片触发选中');
assert(cards()[0].className.includes('mobile-card--selected'), '移动：选中卡片加 mobile-card--selected');

await click(cards()[1].querySelector('button.in-row-btn'), '移动：点卡片内按钮');
assert(clicks().length === 0, '移动：卡片内 button 不触发选中');

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
await server.close();
if (fail) {
  console.log('==== 结论：行选中交互存在回归 ====');
  process.exitCode = 1;
} else {
  console.log('==== 结论：行选中交互全系统一致 ====');
}
