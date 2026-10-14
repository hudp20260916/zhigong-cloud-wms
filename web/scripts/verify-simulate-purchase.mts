/**
 * 模拟出货排产页「按缺料采购」的断言脚本（jsdom 真实挂载页面）。
 *
 * 覆盖：
 *  1. 成品缺口每行有「按缺料采购」按钮
 *  2. 点行内「按缺料采购」→ 跳采购订单页并带 productId + planQty（=该成品待生产量）
 *  3. 只有一件成品需排产时，顶部「按缺料去采购」同样带主产品，而不是退化成物料直采
 *  4. 多件成品需排产时，顶部按钮回退为「按缺料物料直采」（避免归属到错误主产品）
 *
 * 用法：
 *   npx tsx --tsconfig web/tsconfig.json web/scripts/verify-simulate-purchase.mts
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
g.DOMRect = dom.window.DOMRect ?? class {};
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
const fakeMatchMedia = () =>
  ({
    matches: false,
    media: '',
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => false,
  }) as any;
dom.window.matchMedia = fakeMatchMedia as any;
g.matchMedia = fakeMatchMedia;
g.IS_REACT_ACT_ENVIRONMENT = true;

/* ---------------- mock 后端 ---------------- */
const PRODUCTS = [
  { id: 501, code: 'P501', name: '成品甲', spec: '', unit: '台', pinyin: 'cpj', current_stock: 10 },
  { id: 502, code: 'P502', name: '成品乙', spec: '', unit: '台', pinyin: 'cpy', current_stock: 0 },
];

/** SCENE=1 → 只有一件成品缺货；SCENE=2 → 两件都缺 */
const SCENE = process.env.SCENE ?? '1';

const SIM_PRODUCTS =
  SCENE === '1'
    ? [
        { productId: 501, code: 'P501', name: '成品甲', requireQty: 100, stock: 10, needProduce: 90 },
        { productId: 502, code: 'P502', name: '成品乙', requireQty: 50, stock: 50, needProduce: 0 },
      ]
    : [
        { productId: 501, code: 'P501', name: '成品甲', requireQty: 100, stock: 10, needProduce: 90 },
        { productId: 502, code: 'P502', name: '成品乙', requireQty: 50, stock: 20, needProduce: 30 },
      ];

g.fetch = async (url: string) => {
  const u = String(url);
  const json = (data: unknown) => ({ ok: true, status: 200, json: async () => ({ ok: true, data }) });
  if (u.includes('/archive/products/options')) return json(PRODUCTS);
  if (u.includes('/warehouse/simulate')) {
    return json({
      products: SIM_PRODUCTS,
      materials: [
        { materialId: 1, code: 'M001', name: '原料A', spec: '', needQty: 200, stock: 20, gapQty: 180 },
      ],
    });
  }
  return json({ list: [], total: 0 });
};

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
const { MemoryRouter, useLocation, Routes, Route } = await import('react-router-dom');

let pass = 0;
let fail = 0;
function assert(cond: boolean, msg: string, extra = '') {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${msg}${extra ? ' — ' + extra : ''}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${msg}${extra ? ' — ' + extra : ''}`);
  }
}

const SimulatePage = (await server.ssrLoadModule('src/features/warehouse/SimulatePage.tsx')).default;

try {
  const { useAuthStore } = await server.ssrLoadModule('src/stores/auth.ts');
  useAuthStore.setState({
    user: { id: 1, username: 'admin', displayName: '平哥', role: 'admin' },
    permissions: ['*'],
    has: () => true,
    canViewPrice: () => true,
    canExport: () => true,
  } as any);
} catch {
  /* 忽略 */
}

/**
 * 落地页探针：navigate 之后排产页会卸载，所以不能用它自己抓 state，
 * 改由目标路由渲染这个组件，把跳转带过来的 location 记下来。
 */
let probeState: any = null;
let probePath: string | null = null;
function Landing() {
  const loc = useLocation() as any;
  probePath = loc.pathname;
  probeState = loc.state;
  return React.createElement('div', null, `已跳转到 ${loc.pathname}`);
}

const container = document.getElementById('root')!;
let root = createRoot(container);

async function settle(ms = 200) {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

/** 排产页 + 两个目标落地页 */
function App() {
  return React.createElement(
    Routes,
    null,
    React.createElement(Route, { path: '/warehouse/simulate', element: React.createElement(SimulatePage) }),
    React.createElement(Route, { path: '/purchase/orders', element: React.createElement(Landing) }),
    React.createElement(Route, { path: '/production/work-orders', element: React.createElement(Landing) }),
  );
}

/** 重新挂载（必须换一个 root：MemoryRouter 的 initialEntries 只在首次挂载生效） */
async function mountSimulate() {
  await act(async () => {
    root.unmount();
  });
  root = createRoot(container);
  probeState = null;
  probePath = null;
  await act(async () => {
    root.render(
      React.createElement(
        MemoryRouter,
        { initialEntries: ['/warehouse/simulate'] } as any,
        React.createElement(App),
      ),
    );
  });
  await settle(150);
}

await mountSimulate();

/* 选两个成品 → 开始测算 */
assert(
  container.querySelectorAll('.ant-select-selector').length >= 1,
  '出货需求的下拉框已渲染',
);

async function pickProduct(idx: number) {
  // 每次都重新查 DOM：重挂载后旧节点已失效
  const sel = container.querySelector('.ant-select-selector') as HTMLElement | null;
  if (!sel) {
    assert(false, '找不到出货需求下拉框');
    return;
  }
  await act(async () => {
    sel.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true }));
  });
  await settle(80);
  const options = Array.from(document.body.querySelectorAll('.ant-select-item-option')) as HTMLElement[];
  if (!options[idx]) {
    assert(false, `下拉第 ${idx + 1} 项没渲染出来（共 ${options.length} 项）`);
    return;
  }
  await act(async () => {
    options[idx].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  });
  await settle(80);
}

await pickProduct(0);
await pickProduct(1);

const demandRows = Array.from(container.querySelectorAll('tbody tr.ant-table-row')) as HTMLElement[];
assert(demandRows.length === 2, '出货需求已加入 2 行', `实际 ${demandRows.length}`);

const runBtn = Array.from(container.querySelectorAll('button')).find(
  (b) => (b.textContent ?? '').replace(/\s/g, '') === '开始测算',
);
await act(async () => {
  runBtn?.click();
});
await settle(250);

const text = container.textContent ?? '';
assert(text.includes('成品缺口分析'), '测算结果已渲染「成品缺口分析」');

console.log(`\n[1] 成品缺口分析的行内「按缺料采购」（SCENE=${SCENE}）`);
const gapTable = Array.from(container.querySelectorAll('.ant-table-tbody'))[1] as HTMLElement | undefined;
const gapRows = Array.from(gapTable?.querySelectorAll('tr.ant-table-row') ?? []) as HTMLElement[];
assert(gapRows.length === 2, '成品缺口分析渲染 2 行', `实际 ${gapRows.length}`);

const gapButtons = Array.from(gapTable?.querySelectorAll('button') ?? []) as HTMLElement[];
const purchaseBtns = gapButtons.filter((b) => (b.textContent ?? '').replace(/\s/g, '') === '按缺料采购');
assert(purchaseBtns.length === (SCENE === '1' ? 1 : 2), `行内「按缺料采购」按钮数量正确（缺货 ${SCENE === '1' ? 1 : 2} 件）`, `实际 ${purchaseBtns.length}`);

console.log('\n[2] 点行内「按缺料采购」→ 带主产品 + 待生产量');
await act(async () => {
  purchaseBtns[0]?.click();
});
await settle(150);
assert(probePath === '/purchase/orders', '已跳转到 /purchase/orders', `实际 ${probePath}`);
assert(
  probeState?.prefill?.productId === 501,
  '带出了主产品 productId = 501',
  JSON.stringify(probeState?.prefill),
);
assert(
  Number(probeState?.prefill?.planQty) === 90,
  '带出了计划产量 = 待生产量 90（用户不用再选）',
  `实际 ${probeState?.prefill?.planQty}`,
);
assert(
  !probeState?.prefill?.materialIds,
  '不再退化成物料直采（没有 materialIds）',
  JSON.stringify(probeState?.prefill),
);

// 回到排产页，验证顶部批量按钮
await mountSimulate();
await pickProduct(0);
await pickProduct(1);
const runBtn2 = Array.from(container.querySelectorAll('button')).find(
  (b) => (b.textContent ?? '').replace(/\s/g, '') === '开始测算',
);
await act(async () => {
  runBtn2?.click();
});
await settle(250);

console.log('\n[3] 顶部「按缺料去采购」');
const topBtn = Array.from(container.querySelectorAll('button')).find(
  (b) => (b.textContent ?? '').replace(/\s/g, '') === '按缺料去采购',
);
assert(!!topBtn, '顶部「按缺料去采购」按钮在位');
await act(async () => {
  topBtn?.click();
});
await settle(150);
if (SCENE === '1') {
  assert(
    probeState?.prefill?.productId === 501 && Number(probeState?.prefill?.planQty) === 90,
    '单件成品缺货 → 顶部按钮也带主产品 + 计划产量',
    JSON.stringify(probeState?.prefill),
  );
} else {
  assert(
    Array.isArray(probeState?.prefill?.materialIds) && probeState?.prefill?.materialIds.length === 1,
    '多件成品缺货 → 回退为「按缺料物料直采」',
    JSON.stringify(probeState?.prefill),
  );
  assert(probeState?.prefill?.productId === undefined, '多件成品时不带 productId（避免归属错误）');
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
await server.close();
if (fail) {
  console.log('==== 结论：排产页「按缺料采购」存在回归 ====');
  process.exitCode = 1;
} else {
  console.log('==== 结论：排产页「按缺料采购」行为符合预期 ====');
}
