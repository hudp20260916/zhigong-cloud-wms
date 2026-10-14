/**
 * 到货核对页「设置（列显示）」的断言脚本（jsdom 真实挂载页面）。
 *
 * 覆盖：
 *  1. 工具栏「导出」之后紧跟一个「设置」按钮
 *  2. 点开浮层：列出表格全部表头，顺序与表格一致
 *  3. 取消勾选 → 对应列立即从表格消失；再勾选 → 回来
 *  4. 全选 / 取消全选 / 恢复默认
 *  5. 不会出现「所有列被隐藏」：锁定列不可取消，且只剩一列时该列禁用
 *
 * 用法：
 *   npx tsx --tsconfig web/tsconfig.json web/scripts/verify-column-settings.mts
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

/** 表格全量表头（与 ArrivalPage 的 ARRIVAL_COLUMNS 一一对应） */
const ALL_TITLES = [
  '订单编号',
  '父订单号',
  '采购内容',
  '供应商',
  '物料编码',
  '物料名称',
  '规格',
  '下单量',
  '已入库',
  '未入库',
  '单价',
  '下单日期',
  '预计到货',
  '到货状态',
];

const ROW = {
  item_id: 1,
  order_no: 'PO20261015001',
  parent_order_no: 'PO20261015001-1',
  purchaseContent: '钢板、铝型材等3项',
  supplier_name: '东莞某某五金厂',
  material_code: 'M1001',
  material_name: '钢板 2.0mm',
  spec: '2.0mm',
  order_qty: 100,
  received_qty: 40,
  pendingQty: 60,
  price: 5.5,
  order_date: '2026-10-10',
  expected_date: '2026-10-20',
  arrivalStatus: '部分到货',
};

g.fetch = async (url: string) => {
  const u = String(url);
  const json = (data: unknown) => ({ ok: true, status: 200, json: async () => ({ ok: true, data }) });
  if (u.includes('/purchase/arrivals')) return json({ list: [ROW], total: 1 });
  if (u.includes('/archive/suppliers/options')) return json([]);
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
const { MemoryRouter } = await import('react-router-dom');

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

const ArrivalPage = (await server.ssrLoadModule('src/features/purchase/ArrivalPage.tsx')).default;

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

const container = document.getElementById('root')!;
const root = createRoot(container);

async function settle(ms = 150) {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

await act(async () => {
  root.render(
    React.createElement(MemoryRouter, null, React.createElement(ArrivalPage)),
  );
});
await settle(200);

const norm = (s: string | null | undefined) => (s ?? '').replace(/\s/g, '');
const btn = (label: string, scope: ParentNode = document.body) =>
  Array.from(scope.querySelectorAll('button')).find((b) => norm(b.textContent) === label);
const headers = () =>
  Array.from(container.querySelectorAll('.ant-table-thead th')).map((th) => norm(th.textContent));
const panelBoxes = () =>
  Array.from(document.body.querySelectorAll('.ant-popover .ant-checkbox-wrapper')) as HTMLElement[];
const panelTitles = () => panelBoxes().map((b) => norm(b.textContent));

console.log('\n[1] 工具栏「设置」按钮');
const toolbar = container.querySelector('.ant-card-extra') as HTMLElement;
const toolbarBtns = Array.from(toolbar?.querySelectorAll('button') ?? []).map((b) => norm(b.textContent));
assert(toolbarBtns.includes('导出') && toolbarBtns.includes('设置'), '工具栏同时有「导出」与「设置」');
assert(
  toolbarBtns.indexOf('设置') === toolbarBtns.indexOf('导出') + 1,
  '「设置」紧挨在「导出」之后',
  toolbarBtns.join(' | '),
);

console.log('\n[2] 初始渲染：14 列全显示');
assert(headers().length === ALL_TITLES.length, `表格渲染 ${ALL_TITLES.length} 列`, `实际 ${headers().length}`);
assert(headers().join(',') === ALL_TITLES.join(','), '表头顺序与定义一致');

console.log('\n[3] 点开浮层：列出全部表头且顺序一致');
await act(async () => {
  btn('设置', toolbar)?.click();
});
await settle(200);
assert(panelBoxes().length === ALL_TITLES.length, `浮层列出 ${ALL_TITLES.length} 个字段`, `实际 ${panelBoxes().length}`);
assert(
  panelTitles().map((t) => t.replace('（固定）', '')).join(',') === ALL_TITLES.join(','),
  '浮层字段顺序与表格表头一致',
  panelTitles().join(' | '),
);
assert(norm(document.body.querySelector('.ant-popover')?.textContent ?? '').includes('已显示14/14'), '显示「已显示 14 / 14」计数');

console.log('\n[4] 取消勾选 → 对应列立即从表格消失');
async function toggleByTitle(title: string) {
  const box = panelBoxes().find((b) => norm(b.textContent).replace('（固定）', '') === title);
  const input = box?.querySelector('input') as HTMLInputElement | null;
  await act(async () => {
    input?.click();
  });
  await settle(120);
}
await toggleByTitle('单价');
assert(!headers().includes('单价'), '「单价」列已从表格移除', headers().join(','));
assert(headers().length === ALL_TITLES.length - 1, '表格列数 13', `实际 ${headers().length}`);
assert(container.textContent?.includes('钢板 2.0mm') === true, '其它列数据仍在（没有整表空白）');

await toggleByTitle('单价');
assert(headers().includes('单价'), '再勾选回来 → 「单价」列恢复');

console.log('\n[5] 锁定列不可隐藏');
const lockedBox = panelBoxes().find((b) => norm(b.textContent).includes('订单编号'));
const lockedInput = lockedBox?.querySelector('input') as HTMLInputElement | null;
assert(lockedInput?.disabled === true, '「订单编号」为固定列，复选框禁用');
assert(norm(lockedBox?.textContent ?? '').includes('固定'), '固定列带「（固定）」说明');

console.log('\n[6] 取消全选 → 只剩固定列，不会整表空白');
await act(async () => {
  btn('取消全选')?.click();
});
await settle(150);
assert(headers().length === 1, '表格只剩 1 列', `实际 ${headers().length}`);
assert(headers()[0] === '订单编号', '剩下的是固定列「订单编号」', headers().join(','));
assert(container.textContent?.includes('PO20261015001') === true, '表格仍能看到订单号（没有空白）');

console.log('\n[7] 恢复默认 / 全选');
await act(async () => {
  btn('恢复默认')?.click();
});
await settle(150);
assert(headers().length === ALL_TITLES.length, '「恢复默认」恢复全部列', `实际 ${headers().length}`);

await act(async () => {
  btn('取消全选')?.click();
});
await settle(150);
await act(async () => {
  btn('全选')?.click();
});
await settle(150);
assert(headers().length === ALL_TITLES.length, '「全选」显示全部列', `实际 ${headers().length}`);

console.log('\n[8] 关闭浮层后设置保持生效');
await toggleByTitle('规格');
assert(!headers().includes('规格'), '隐藏「规格」后立即生效');
await act(async () => {
  btn('设置', toolbar)?.click();
});
await settle(200);
assert(!headers().includes('规格'), '关闭浮层后仍然生效（设置不回弹）');

console.log('\n[9] 本地持久化：重载页面后保留');
const saved = dom.window.localStorage.getItem('zgwms.arrival.columns');
assert(!!saved && String(saved).includes('spec'), '隐藏项已写入 localStorage', String(saved));
await act(async () => {
  root.unmount();
});
const root2 = createRoot(container);
await act(async () => {
  root2.render(React.createElement(MemoryRouter, null, React.createElement(ArrivalPage)));
});
await settle(250);
assert(!headers().includes('规格'), '重新打开页面后「规格」仍然是隐藏的');
await act(async () => {
  btn('恢复默认', toolbar)?.click();
});

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
await server.close();
if (fail) {
  console.log('==== 结论：列显示设置存在回归 ====');
  process.exitCode = 1;
} else {
  console.log('==== 结论：列显示设置行为符合预期 ====');
}
