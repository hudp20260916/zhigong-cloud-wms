/**
 * 列表页「真实挂载」冒烟：在 jsdom 里用 Vite 加载**真实页面模块**并 createRoot 挂载，
 * 再喂一份 mock 列表数据，用来抓「点进去白屏」这类**数据回来之后**才炸的渲染期异常
 * （tsc / build / 空列表 SSR 都抓不到）。
 *
 * 用法：
 *   npx tsx --tsconfig web/tsconfig.json web/scripts/mount-check.mts src/features/purchase/PurchaseReceiptPage.tsx
 * 注意：路径不要带前导斜杠（Git Bash 会把 /src/... 转成 PortableGit 下的 Windows 路径）。
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
// jsdom 没实现带伪元素的 getComputedStyle，antd 的 rc-* 组件会摸到，这里忽略伪元素参数
const rawGetComputedStyle = dom.window.getComputedStyle.bind(dom.window);
const safeGetComputedStyle = (elt: any, _pseudo?: string) => rawGetComputedStyle(elt);
dom.window.getComputedStyle = safeGetComputedStyle as any;
g.getComputedStyle = safeGetComputedStyle;
g.requestAnimationFrame = (cb: any) => setTimeout(cb, 0);
g.cancelAnimationFrame = (id: any) => clearTimeout(id);
g.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
g.ShadowRoot = dom.window.ShadowRoot;
const MOBILE = process.env.MOBILE === '1';
const fakeMatchMedia = () =>
  ({
    matches: MOBILE,
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

// —— mock 后端：按 URL 关键词返回不同形态的假数据 ——
const RECEIPT_ROW = {
  id: 101,
  receipt_date: '2026-10-14',
  purchaseContent: '钢板 2.0mm × 50 / 铝型材 × 20',
  supplier_name: '佛山市南海区某某五金厂',
  order_no: 'PO20261014001',
  total_amount: 12345.67,
  source: 'order',
  operator_name: '平哥',
  status: '有效',
  canUndo: true,
};

g.fetch = async (url: string) => {
  const u = String(url);
  const json = (data: unknown) => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, data }),
  });
  if (u.includes('/pending')) {
    return json({
      order: { id: 5, order_no: 'PO20261014009', supplier_name: '测试供应商' },
      items: [
        {
          materialId: 1,
          materialCode: 'M0001',
          materialName: '钢板 2.0mm',
          spec: '2.0mm',
          unit: 'kg',
          pendingQty: 10,
          price: 5.5,
        },
      ],
    } as any);
  }
  if (u.includes('options')) return json([] as any);
  if (u.includes('receipts')) return json({ list: [RECEIPT_ROW], total: 1 } as any);
  if (u.includes('orders')) return json({ list: [], total: 0 } as any);
  return json({ list: [], total: 0 } as any);
};

const target = process.argv[2] || 'src/features/purchase/PurchaseReceiptPage.tsx';
const targetFile = path.isAbsolute(target) ? target : path.join(WEB_ROOT, target);

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

let failed = false;
const realError = console.error;
console.error = (...args: any[]) => {
  const first = typeof args[0] === 'string' ? args[0] : '';
  // React 的「渲染期异常」会以 console.error 形式再打一遍，这里一并记为失败
  if (first.includes('The above error occurred')) failed = true;
  realError(...args);
};

try {
  const mod = await server.ssrLoadModule(targetFile);
  const Comp = mod.default;
  if (!Comp) throw new Error('模块没有 default 导出');

  // 给足权限：否则 PermGate / RowActionButton 直接 return null，
  // 那些按钮里的 render 期异常就测不到了（白屏恰恰常藏在这里）
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
    /* 权限仓库注入失败不影响渲染断言 */
  }

  const container = document.getElementById('root')!;
  const root = createRoot(container);

  // ORDER_ID=1 时模拟「从采购订单点『去入库』跳进来」这条路径（location.state 带 receiveOrderId）
  const orderId = process.env.ORDER_ID;
  const routerProps = orderId
    ? { initialEntries: [{ pathname: '/purchase/receipts', state: { receiveOrderId: Number(orderId) } }] }
    : {};
  await act(async () => {
    root.render(React.createElement(MemoryRouter, routerProps as any, React.createElement(Comp)));
  });
  // 让 useEffect 里的异步取数 resolve 并触发二次渲染
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });

  const text = container.textContent ?? '';
  const html = container.innerHTML.length;
  const hasRow = text.includes('佛山市南海区某某五金厂');
  console.log(`HTML ${html} 字符 / textContent ${text.length} 字符`);
  console.log(`${hasRow ? '✅' : '❌'} 列表数据已渲染（能找到 mock 供应商名）`);
  console.log(`${html > 2000 ? '✅' : '❌'} 页面不是空白（DOM 节点数正常）`);
  if (!hasRow || html <= 2000) {
    failed = true;
    console.log('---- 前 500 字符 textContent ----');
    console.log(text.slice(0, 500));
  }
} catch (e: any) {
  failed = true;
  console.log(`❌ 挂载/渲染失败：${target}`);
  console.log(e?.stack ?? String(e));
} finally {
  await server.close();
}

if (failed) {
  console.log('\n==== 结论：该页面存在渲染期异常（白屏）====');
  process.exitCode = 1;
} else {
  console.log('\n==== 结论：挂载渲染正常 ====');
}
