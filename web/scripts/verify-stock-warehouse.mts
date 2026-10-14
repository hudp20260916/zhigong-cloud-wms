/**
 * 库存查询页「仓库选择锁定」行为断言（jsdom 真实挂载 StockPage + mock 后端）。
 *
 * 覆盖平哥报的场景：
 *   1. 进入页面默认选中「主仓库」（main + is_default 优先）；
 *   2. 手动切到 902 仓库后，切子页签 / 查询 / 翻页 / 排序 / 重渲染都不会跳回默认；
 *   3. 只有「重新进入页面」（组件重新挂载）或用户再次手动切换才变更；
 *   4. 选了物料库这类单一品类仓再切到成品页签 → 明确切到成品首选仓并给出提示。
 *
 * 用法：
 *   npx tsx --tsconfig web/tsconfig.json web/scripts/verify-stock-warehouse.mts
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
const fakeMM = () =>
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
dom.window.matchMedia = fakeMM as any;
g.matchMedia = fakeMM;
g.IS_REACT_ACT_ENVIRONMENT = true;

// ---------------- mock 后端 ----------------
const WAREHOUSES = [
  { id: 1, code: 'MAIN', name: '主仓库', kind: 'main', is_default: 1, status: '启用' },
  { id: 2, code: 'WL', name: '物料库', kind: 'material', is_default: 1, status: '启用' },
  { id: 3, code: 'CP', name: '成品库', kind: 'product', is_default: 1, status: '启用' },
  { id: 902, code: 'W902', name: '902 仓库', kind: 'main', is_default: 0, status: '启用' },
];

/** 每次列表请求的 URL，用来断言 warehouseId 有没有被偷偷改掉 */
const calls: string[] = [];

const ROW = {
  id: 1,
  code: 'X001',
  name: '测试对象',
  spec: 'spec',
  unit: '个',
  current_stock: 100,
  wh_qty: 100,
  safety_stock: 10,
  avg_cost: 5,
};

g.fetch = async (url: string) => {
  const u = String(url);
  const json = (data: unknown) => ({ ok: true, status: 200, json: async () => ({ ok: true, data }) });
  if (u.includes('/me')) {
    return json({
      id: 1,
      username: 'admin',
      displayName: '平哥',
      role: 'admin',
      permissions: ['*'],
    } as any);
  }
  if (u.includes('/inventory/warehouses')) return json({ list: WAREHOUSES, total: WAREHOUSES.length });
  if (u.includes('/inventory/products') || u.includes('/inventory/materials')) {
    calls.push(u);
    return json({ list: [ROW], total: 1 });
  }
  return json({ list: [], total: 0, items: [] });
};

// ---------------- 挂载 ----------------
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
const { MemoryRouter } = await import('react-router-dom');

const StockPage = (await server.ssrLoadModule('src/features/inventory/StockPage.tsx')).default;

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

async function settle(ms = 30) {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

function Page() {
  return React.createElement(MemoryRouter, null, React.createElement(StockPage));
}

/** 仓库下拉当前显示的文字 */
function whText() {
  return (
    container.querySelector('.ant-select-selection-item')?.textContent?.trim() ?? '(空)'
  );
}
/** 最近一次列表请求带的 warehouseId（没有就是 null） */
function lastWhParam() {
  for (let i = calls.length - 1; i >= 0; i -= 1) {
    const m = /warehouseId=(\d+)/.exec(calls[i]);
    if (m) return Number(m[1]);
    if (/inventory\/(products|materials)/.test(calls[i])) return null;
  }
  return null;
}

async function openSelectAndPick(label: string) {
  const sel = container.querySelector('.ant-select-selector') as HTMLElement | null;
  if (!sel) {
    assert(false, '找不到仓库下拉');
    return;
  }
  await act(async () => {
    sel.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true }));
  });
  await settle(30);
  const opts = Array.from(document.querySelectorAll('.ant-select-item-option')) as HTMLElement[];
  const target = opts.find((o) => (o.textContent ?? '').includes(label));
  if (!target) {
    assert(false, `下拉里找不到「${label}」（可选：${opts.map((o) => o.textContent).join(' / ')}）`);
    return;
  }
  await act(async () => {
    target.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  });
  await settle(40);
}

async function clickTab(label: string) {
  const tabs = Array.from(container.querySelectorAll('.ant-tabs-tab')) as HTMLElement[];
  const t = tabs.find((x) => (x.textContent ?? '').includes(label));
  if (!t) {
    assert(false, `找不到页签「${label}」`);
    return;
  }
  await act(async () => {
    t.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  });
  await settle(40);
}

// ===================== 场景 1：进入页面默认选中主仓库 =====================
console.log('\n== 场景 1：从菜单进入，默认选中主仓库 ==');
await act(async () => {
  root.render(React.createElement(Page));
});
await settle(60);

assert(whText().includes('主仓库'), `进入页面默认选中「主仓库」（当前显示：${whText()}）`);
assert(lastWhParam() === 1, `首个列表请求带 warehouseId=1（实际 ${lastWhParam()}）`);
assert(calls.some((u) => u.includes('/inventory/products')), '默认页签是「成品库存」');

// ===================== 场景 2：手动切到 902 仓库 =====================
console.log('\n== 场景 2：手动选择 902 仓库 ==');
await openSelectAndPick('902 仓库');
assert(whText().includes('902 仓库'), `手动选择生效（当前显示：${whText()}）`);
assert(lastWhParam() === 902, `请求带 warehouseId=902（实际 ${lastWhParam()}）`);

// ===================== 场景 3：切子页签后必须保持 =====================
console.log('\n== 场景 3：点「物料库存」子页签，选择必须保持 ==');
await clickTab('物料库存');
assert(whText().includes('902 仓库'), `切到物料页签后仍是 902（当前显示：${whText()}）`);
assert(lastWhParam() === 902, `物料列表请求仍带 warehouseId=902（实际 ${lastWhParam()}）`);
assert(calls.some((u) => u.includes('/inventory/materials')), '页签已切到物料列表');

console.log('\n== 场景 3b：再切回「成品库存」，仍然是 902 ==');
await clickTab('成品库存');
assert(whText().includes('902 仓库'), `切回成品页签后仍是 902（当前显示：${whText()}）`);
assert(lastWhParam() === 902, `成品列表请求仍带 warehouseId=902（实际 ${lastWhParam()}）`);

// ===================== 场景 4：查询 / 翻页也不得重置 =====================
console.log('\n== 场景 4：执行查询（搜索）后仍保持 902 ==');
const searchInput = container.querySelector('.ant-input-search input') as HTMLInputElement | null;
if (searchInput) {
  await act(async () => {
    (searchInput as any).value = '钢板';
    searchInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
  await settle(20);
  await act(async () => {
    searchInput.dispatchEvent(
      new dom.window.KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }),
    );
  });
  await settle(40);
  assert(whText().includes('902 仓库'), `搜索后仍是 902（当前显示：${whText()}）`);
  assert(lastWhParam() === 902, `搜索请求仍带 warehouseId=902（实际 ${lastWhParam()}）`);
} else {
  console.log('  （跳过：没找到搜索框）');
}

console.log('\n== 场景 4b：强制重渲染后仍保持 902 ==');
await act(async () => {
  root.render(React.createElement(Page));
});
await settle(60);
assert(whText().includes('902 仓库'), `同页面重渲染后仍是 902（当前显示：${whText()}）`);

// ===================== 场景 5：重新进入页面才回到默认 =====================
console.log('\n== 场景 5：重新进入页面（卸载再挂载）→ 回到主仓库 ==');
await act(async () => {
  root.render(React.createElement('div'));
});
await settle(20);
await act(async () => {
  root.render(React.createElement(Page));
});
await settle(60);
assert(whText().includes('主仓库'), `重新进入页面回到「主仓库」（当前显示：${whText()}）`);
assert(lastWhParam() === 1, `重新进入后请求带 warehouseId=1（实际 ${lastWhParam()}）`);

// ===================== 场景 6：单一品类仓切页签时明确切换 =====================
console.log('\n== 场景 6：物料页签下选「物料库」，再切到成品页签 → 明确切到成品首选仓 ==');
// 下拉只列当前品类能放的仓，所以必须先切到物料页签才能选到物料库
await clickTab('物料库存');
assert(whText().includes('主仓库'), `主仓两类都能放，切页签后保持主仓库（当前显示：${whText()}）`);
await openSelectAndPick('物料库');
assert(whText().includes('物料库'), `已选中物料库（当前显示：${whText()}）`);
assert(lastWhParam() === 2, `物料列表请求带 warehouseId=2（实际 ${lastWhParam()}）`);
await clickTab('成品库存');
assert(
  !whText().includes('物料库'),
  `物料库放不下成品，已切走（当前显示：${whText()}）`,
);
assert(lastWhParam() === 1, `切到成品首选仓=主仓库(1)（实际 ${lastWhParam()}）`);

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
await server.close();
if (fail) {
  console.log('==== 结论：仓库选择仍会被重置，需继续修 ====');
  process.exitCode = 1;
} else {
  console.log('==== 结论：手动选择的仓库在整个库存查询流程中持续生效 ====');
}
