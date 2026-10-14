/**
 * 采购订单「按主产品 BOM 采购」改造的前端断言脚本（jsdom 真实挂载页面）。
 *
 * 覆盖：
 *  1. 排产页带 prefill 跳进来 → 自动切 BOM 模式、带出主产品与计划产量
 *  2. 选好主产品后**自动**向服务端要测算（bom-preview），不需要点「展开 BOM」
 *  3. 明细行自动铺出，新增 6 个测算列（单位用量 / 需求量 / 已占用 / 可用库存 / 缺料数量 / 采购在途）
 *  4. 排产页跳入时自动按缺料数量回填采购数量（不用再点「计算」）
 *  5. 未点「计算」→ 采购数量 = 计划产量（切回 BOM 模式后复现该分支）
 *  6. 点「计算」→ 采购数量 = 缺料数量（库存充足的行为 0）
 *  7. 「展开 BOM」按钮已移除，「计算 / 重新展开」在位，点「重新展开」会再发一次请求
 *
 * 用法：
 *   npx tsx --tsconfig web/tsconfig.json web/scripts/verify-purchase-bom.mts
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
const PRODUCT_ID = 9001;
const PLAN_QTY = 20;

const PREVIEW = {
  productId: PRODUCT_ID,
  productCode: 'P9001',
  productName: '验收-成品P',
  productUnit: '台',
  bomVersion: 'V2.0',
  planQty: PLAN_QTY,
  deepExpanded: true,
  bomMissing: false,
  bomError: null,
  cartonQty: 0,
  shortageCount: 1,
  items: [
    {
      materialId: 1,
      materialCode: 'M001',
      materialName: '原料A',
      spec: '2.0mm',
      unit: '个',
      qtyPerUnit: 2,
      isCarton: false,
      requireQty: 40,
      stock: 10,
      occupiedQty: 0,
      availableQty: 10,
      shortageQty: 30,
      purchaseQty: 30,
      inTransitQty: 8,
      price: 5,
      enough: false,
    },
    {
      materialId: 2,
      materialCode: 'M002',
      materialName: '原料B',
      spec: '1m',
      unit: '米',
      qtyPerUnit: 1,
      isCarton: false,
      requireQty: 20,
      stock: 50,
      occupiedQty: 0,
      availableQty: 50,
      shortageQty: 0,
      purchaseQty: 0,
      inTransitQty: 0,
      price: 2,
      enough: true,
    },
  ],
};

const calls: string[] = [];

g.fetch = async (url: string) => {
  const u = String(url);
  const json = (data: unknown) => ({ ok: true, status: 200, json: async () => ({ ok: true, data }) });
  if (u.includes('bom-preview')) {
    calls.push(u);
    return json(PREVIEW);
  }
  if (u.includes('/archive/materials/options')) {
    return json([
      { id: 1, code: 'M001', name: '原料A', spec: '2.0mm', unit: '个', current_stock: 10, avg_cost: 5 },
      { id: 2, code: 'M002', name: '原料B', spec: '1m', unit: '米', current_stock: 50, avg_cost: 2 },
    ]);
  }
  if (u.includes('/archive/products/options')) {
    return json([{ id: PRODUCT_ID, code: 'P9001', name: '验收-成品P', spec: '', unit: '台', pinyin: 'yscp' }]);
  }
  if (u.includes('/archive/suppliers/options')) return json([]);
  if (u.includes('/purchase/orders')) return json({ list: [], total: 0 });
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

const mod = await server.ssrLoadModule('src/features/purchase/PurchaseOrderPage.tsx');
const PurchaseOrderPage = mod.default;

// 给足权限，否则 PermGate 里的按钮不渲染
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

async function settle(ms = 450) {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

async function click(el: Element | null | undefined, label: string) {
  if (!el) {
    assert(false, `${label}：找不到目标元素`);
    return;
  }
  await act(async () => {
    (el as HTMLElement).click();
  });
  await settle(60);
}

const body = () => document.body;
const modal = () => body().querySelector('.ant-modal') as HTMLElement | null;
const itemRows = () =>
  Array.from(modal()?.querySelectorAll('tbody tr.ant-table-row') ?? []) as HTMLElement[];
const headers = () =>
  Array.from(modal()?.querySelectorAll('thead th') ?? []).map((th) => th.textContent?.trim() ?? '');
/** 行内的文本输入（antd InputNumber）：[0]=物料 Select 的搜索框，[1]=采购数量，[2]=单价 */
const rowInputs = (row: HTMLElement) => Array.from(row.querySelectorAll('input')) as HTMLInputElement[];
const qtyOf = (row: HTMLElement) => rowInputs(row)[1]?.value;

/* ---------------- 场景 1：排产页带 prefill 跳入 ---------------- */
console.log('\n[1] 排产页「按缺料采购」带入主产品 + 计划产量');
await act(async () => {
  root.render(
    React.createElement(
      MemoryRouter,
      {
        initialEntries: [
          { pathname: '/purchase/orders', state: { prefill: { productId: PRODUCT_ID, planQty: PLAN_QTY } } },
        ],
      } as any,
      React.createElement(PurchaseOrderPage),
    ),
  );
});
await settle(600);

assert(!!modal(), '弹窗已自动打开（无需先点新增）');
const modalTitle = modal()?.querySelector('.ant-modal-title')?.textContent ?? '';
assert(modalTitle.includes('新增采购订单'), '标题为「新增采购订单」', modalTitle);

const bomRadio = Array.from(modal()?.querySelectorAll('.ant-radio-button-wrapper') ?? []).find((el) =>
  el.textContent?.includes('按主产品 BOM 采购'),
);
assert(
  (bomRadio as HTMLElement | undefined)?.className.includes('ant-radio-button-wrapper-checked') === true,
  '已自动切到「按主产品 BOM 采购」模式',
);

// 工具栏里的第一个 InputNumber 就是「计划产量」（明细表的在它后面）
const planInput = modal()?.querySelector('.ant-input-number input') as HTMLInputElement | null;
assert(
  Number(planInput?.value) === PLAN_QTY,
  '计划产量已带出 = 20',
  `实际 ${planInput?.value}`,
);

console.log('\n[2] 选品后自动展开多级 BOM（无需点「展开 BOM」）');
assert(
  calls.length >= 1 && calls[0].includes(`productId=${PRODUCT_ID}`) && calls[0].includes(`planQty=${PLAN_QTY}`),
  '自动调用了 bom-preview 且参数正确',
  calls[0] ?? '(没有调用)',
);
assert(!body().textContent?.includes('展开 BOM'), '「展开 BOM」按钮已移除');
// antd 默认在两个汉字之间插空格（「计 算」），比较前去掉空白
const txt = (el: Element) => (el.textContent ?? '').replace(/\s/g, '');
const findBtn = (label: string) =>
  Array.from(modal()?.querySelectorAll('button') ?? []).find((b) => txt(b) === label);
assert(!!findBtn('计算'), '「计算」按钮在位');
assert(!!findBtn('重新展开'), '「重新展开」按钮在位');
assert(body().textContent?.includes('已展开多级 BOM') === true, '展示了「已展开多级 BOM」标记');
assert(body().textContent?.includes('BOM V2.0') === true, '展示了 BOM 版本 V2.0');

console.log('\n[3] 明细行自动铺出 + 6 个测算列');
assert(itemRows().length === 2, '明细行自动铺出 2 行', `实际 ${itemRows().length}`);
const hs = headers();
for (const col of ['单位用量', '需求量', '已占用', '可用库存', '缺料数量', '采购在途']) {
  assert(hs.some((h) => h.includes(col)), `新增列「${col}」已渲染`);
}
const rowA = itemRows()[0];
const rowB = itemRows()[1];
assert(rowA?.textContent?.includes('原料A') === true, '第 1 行是原料A');
assert(rowB?.textContent?.includes('原料B') === true, '第 2 行是原料B');
assert(rowA?.textContent?.includes('40') === true, '原料A 需求量 40 已展示');
assert(rowA?.textContent?.includes('30') === true, '原料A 缺料数量 30 已展示');
assert(rowB?.textContent?.includes('充足') === true, '原料B 充足（缺料为 0，显示「充足」而非负数）');

console.log('\n[4] 排产页跳入时自动按缺料数量回填（无需再点「计算」）');
assert(qtyOf(rowA) === '30', '原料A 采购数量 = 30（缺料数量）', `实际 ${qtyOf(rowA)}`);
assert(qtyOf(rowB) === '0', '原料B 采购数量 = 0（库存充足）', `实际 ${qtyOf(rowB)}`);
assert(
  body().textContent?.includes('已带出主产品与计划产量') === true,
  '弹出了「已带出主产品与计划产量」提示',
);

console.log('\n[5] 未点「计算」→ 采购数量 = 计划产量');
// 切到「直接采购物料」再切回来：calculated 被重置为 false，复现「先选品、未计算」分支
const radios = Array.from(modal()?.querySelectorAll('.ant-radio-button-wrapper') ?? []) as HTMLElement[];
const directRadio = radios.find((el) => el.textContent?.includes('直接采购物料'));
const bomRadio2 = radios.find((el) => el.textContent?.includes('按主产品 BOM 采购'));
await click(directRadio?.querySelector('input'), '切到「直接采购物料」');
await click(bomRadio2?.querySelector('input'), '切回「按主产品 BOM 采购」');
await settle(500);
const rows2 = itemRows();
assert(rows2.length === 2, '切回 BOM 模式后明细行重新铺出', `实际 ${rows2.length}`);
assert(qtyOf(rows2[0]) === String(PLAN_QTY), '未计算：原料A 采购数量 = 计划产量 20', `实际 ${qtyOf(rows2[0])}`);
assert(qtyOf(rows2[1]) === String(PLAN_QTY), '未计算：原料B 采购数量 = 计划产量 20', `实际 ${qtyOf(rows2[1])}`);
assert(rows2[0]?.textContent?.includes('30') === true, '未计算时缺料数量列仍然展示 30（可对照）');

console.log('\n[6] 点「计算」→ 采购数量 = 缺料数量');
const calcBtn = findBtn('计算');
const before = calls.length;
await click(calcBtn, '点「计算」');
await settle(500);
const rows3 = itemRows();
assert(qtyOf(rows3[0]) === '30', '计算后：原料A 采购数量 = 30', `实际 ${qtyOf(rows3[0])}`);
assert(qtyOf(rows3[1]) === '0', '计算后：原料B 采购数量 = 0（库存充足不采购）', `实际 ${qtyOf(rows3[1])}`);

console.log('\n[7] 「重新展开」会重新拉一次测算');
const refreshBtn = findBtn('重新展开');
await click(refreshBtn, '点「重新展开」');
await settle(500);
assert(calls.length > before, '「重新展开」触发了新的测算请求', `${before} → ${calls.length}`);
assert(itemRows().length === 2 && qtyOf(itemRows()[0]) === '30', '重新展开后已计算状态保持（采购数量仍为 30）');

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
await server.close();
if (fail) {
  console.log('==== 结论：采购 BOM 改造前端存在回归 ====');
  process.exitCode = 1;
} else {
  console.log('==== 结论：采购 BOM 改造前端行为符合预期 ====');
}
