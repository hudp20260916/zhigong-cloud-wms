/**
 * 全系统页面挂载冒烟：用同一个 Vite 实例依次真实挂载每个页面（jsdom + mock 后端），
 * 抓「渲染期抛错 → React 18 卸载整棵树 → 白屏」这类问题。
 *
 * 用法：
 *   npx tsx --tsconfig web/tsconfig.json web/scripts/mount-all.mts
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
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

const ROW = {
  id: 1,
  wo_no: 'WO20261014-0001',
  code: 'M0001',
  name: '钢板 2.0mm',
  spec: '2.0mm',
  unit: 'kg',
  item_id: 1,
  itemType: 'material',
  itemCode: 'M0001',
  itemName: '钢板 2.0mm',
  order_no: 'PO20261014001',
  receipt_no: 'RC20261014001',
  receipt_date: '2026-10-14',
  supplier_name: '测试供应商',
  customer_name: '测试客户',
  product_name: '成品A',
  productCode: 'P0001',
  plan_qty: 100,
  issued_qty: 10,
  received_qty: 5,
  qty: 10,
  price: 5.5,
  total_amount: 55,
  status: '有效',
  remark: '',
  operator_name: '平哥',
  created_at: '2026-10-14 10:00:00',
  canUndo: true,
  canEdit: true,
  canReceive: true,
  canIssue: true,
  isLow: false,
  is_reversal: 0,
  username: 'admin',
  displayName: '管理员',
  role: 'admin',
  isActive: 1,
};

/** 后端 mock：列表类返回 1 行假数据，options 类返回空数组 */
g.fetch = async (url: string) => {
  const u = String(url);
  const json = (data: unknown) => ({ ok: true, status: 200, json: async () => ({ ok: true, data }) });
  if (u.includes('/me')) return json({ id: 1, username: 'admin', displayName: '平哥', role: 'admin', permissions: ['*'] } as any);
  // 这些端点页面直接当数组用（.map / .find / .reduce），给错形状会误报成白屏
  if (
    /roles|templates|payables|receivables|meta|settings|items|categories|kinds|options|logs|users/.test(u)
  ) {
    if (u.includes('options') || u.includes('roles')) {
      return json(u.includes('roles') ? ['admin', 'operator'] : ([] as any));
    }
    return json([ROW] as any);
  }
  if (u.includes('dashboard') || u.includes('stat') || u.includes('report') || u.includes('todo')) {
    return json({
      list: [],
      total: 0,
      items: [],
      materialKinds: [],
      productKinds: [],
      pendingReceipt: 0,
      pendingIssue: 0,
      meta: [],
      rows: [],
    } as any);
  }
  return json({ list: [ROW], total: 1, items: [ROW] } as any);
};

const PAGES = [
  'features/dashboard/DashboardPage',
  'features/archive/MaterialPage',
  'features/archive/ProductPage',
  'features/archive/PartnerPage',
  'features/inventory/StockPage',
  'features/inventory/InitialStockPage',
  'features/inventory/TransferPage',
  'features/inventory/LedgerPage',
  'features/production/WorkOrderPage',
  'features/production/IssuePage',
  'features/production/MaterialReturnPage',
  'features/production/ProductReceiptPage',
  'features/purchase/PurchaseOrderPage',
  'features/purchase/PurchaseReceiptPage',
  'features/purchase/PurchaseReturnPage',
  'features/purchase/ArrivalPage',
  'features/sale/SaleOrderPage',
  'features/sale/SaleDeliveryPage',
  'features/sale/SaleReturnPage',
  'features/warehouse/MaterialSalePage',
  'features/warehouse/DefectivePage',
  'features/warehouse/StockCheckPage',
  'features/warehouse/SimulatePage',
  'features/warehouse/AlarmPage',
  'features/finance/SettlementPage',
  'features/finance/ReportPage',
  'features/system/UserPage',
  'features/system/LogPage',
  'features/system/PrintTemplatePage',
  'features/system/SettingsPage',
  'features/system/SystemInitPage',
];

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

const { useAuthStore } = await server.ssrLoadModule('src/stores/auth.ts');
useAuthStore.setState({
  token: 'mock',
  user: { id: 1, username: 'admin', displayName: '平哥', role: 'admin', permissions: ['*'] },
  permissions: ['*'],
  ready: true,
  has: () => true,
  canViewPrice: () => true,
  canExport: () => true,
} as any);

// 静音 React 的 useLayoutEffect / 路由 future flag 噪音，只关心真正的异常
const realError = console.error;
let currentPage = '';
let currentFailed = false;
console.error = (...args: any[]) => {
  const first = typeof args[0] === 'string' ? args[0] : '';
  if (first.includes('The above error occurred')) currentFailed = true;
  if (first.startsWith('Error: Uncaught') || first.startsWith('The above error')) realError(...args);
};

const results: { page: string; ok: boolean; note: string }[] = [];

for (const p of PAGES) {
  currentPage = p;
  currentFailed = false;
  let note = '';
  try {
    const mod = await server.ssrLoadModule(path.join(WEB_ROOT, 'src', `${p}.tsx`));
    const Comp = mod.default;
    if (!Comp) throw new Error('没有 default 导出');
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(React.createElement(MemoryRouter, null, React.createElement(Comp)));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });
    const html = host.innerHTML.length;
    if (html < 500) {
      currentFailed = true;
      note = `DOM 过短（${html} 字符）疑似白屏`;
    }
    await act(async () => {
      root.unmount();
    });
    host.remove();
  } catch (e: any) {
    currentFailed = true;
    note = String(e?.message ?? e).split('\n')[0].slice(0, 160);
  }
  results.push({ page: p, ok: !currentFailed, note });
  console.log(`${currentFailed ? '❌' : '✅'} ${p}${note ? ` — ${note}` : ''}`);
}

console.error = realError;
const bad = results.filter((r) => !r.ok);
console.log(`\n共 ${results.length} 个页面，通过 ${results.length - bad.length}，失败 ${bad.length}`);
if (bad.length) {
  console.log('失败清单：');
  for (const b of bad) console.log(`  - ${b.page}${b.note ? `：${b.note}` : ''}`);
}
await server.close();
if (bad.length) process.exitCode = 1;
