/**
 * 专项：采购入库页「点击行展开明细」是否把整棵树炸掉（React 18 下 effect/render 抛错
 * 会直接卸载根节点，表现就是「点进去白屏」）。
 *
 * 用法：
 *   npx tsx --tsconfig web/tsconfig.json web/scripts/expand-check.mts src/features/purchase/PurchaseReceiptPage.tsx
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

const ROW = {
  id: 101,
  receipt_date: '2026-10-14',
  purchaseContent: '钢板 2.0mm × 50',
  supplier_name: '佛山市南海区某某五金厂',
  order_no: 'PO20261014001',
  total_amount: 12345.67,
  source: 'order',
  operator_name: '平哥',
  status: '有效',
  canUndo: true,
};

const calls: string[] = [];
g.fetch = async (url: string) => {
  const u = String(url);
  calls.push(u.replace(/^.*\/api/, ''));
  const json = (data: unknown) => ({ ok: true, status: 200, json: async () => ({ ok: true, data }) });
  if (u.includes('options')) return json([] as any);
  if (u.includes('/purchase/receipts/') && !u.includes('?')) {
    return json({
      id: 101,
      items: [
        {
          code: 'M0001',
          name: '钢板 2.0mm',
          spec: '2.0mm',
          unit: 'kg',
          qty: 50,
          price: 12.5,
          remark: '',
        },
      ],
    } as any);
  }
  if (u.includes('receipts')) return json({ list: [ROW], total: 1 } as any);
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

let crashed = false;
const realError = console.error;
console.error = (...args: any[]) => {
  const first = typeof args[0] === 'string' ? args[0] : '';
  if (first.includes('The above error occurred')) crashed = true;
  realError(...args);
};

try {
  const mod = await server.ssrLoadModule(targetFile);
  const Comp = mod.default;
  const { useAuthStore } = await server.ssrLoadModule('src/stores/auth.ts');
  useAuthStore.setState({
    user: { id: 1, username: 'admin', displayName: '平哥', role: 'admin' },
    permissions: ['*'],
    has: () => true,
    canViewPrice: () => true,
    canExport: () => true,
  } as any);

  const container = document.getElementById('root')!;
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(MemoryRouter, null, React.createElement(Comp)));
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 60));
  });

  const before = container.innerHTML.length;
  console.log(`展开前 DOM = ${before} 字符`);

  // 1) 找到展开图标并点击
  const icons = container.querySelectorAll('.ant-table-row-expand-icon');
  console.log(`展开图标数量 = ${icons.length}`);
  if (icons.length === 0) {
    console.log('❌ 没找到展开图标（rowSelection 与 expandable 组合后列位置可能变了）');
    crashed = true;
  } else {
    await act(async () => {
      (icons[0] as HTMLElement).click();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 80));
    });
  }

  // 2) 打开「新增入库」弹窗，检查弹窗内容是否被 DraggableModal 影响
  const btns = Array.from(container.querySelectorAll('button'));
  const addBtn = btns.find((b) => (b.textContent ?? '').includes('新增入库'));
  console.log(`找到「新增入库」按钮 = ${!!addBtn}`);
  if (addBtn) {
    await act(async () => {
      addBtn.click();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 80));
    });
    const modal = document.querySelector('.ant-modal') as HTMLElement | null;
    const bodyText = document.querySelector('.ant-modal-body')?.textContent ?? '';
    console.log(`弹窗已挂载 = ${!!modal}`);
    console.log(
      bodyText.includes('添加明细行')
        ? '✅ 弹窗内容已渲染（找到「添加明细行」）'
        : `❌ 弹窗内容空白（body textContent = ${JSON.stringify(bodyText.slice(0, 120))}）`,
    );
    if (!bodyText.includes('添加明细行')) crashed = true;
    await act(async () => {
      (document.querySelector('.ant-modal-close') as HTMLElement | null)?.click();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 80));
    });
  }

  const after = container.innerHTML.length;
  const text = container.textContent ?? '';
  console.log(`展开后 DOM = ${after} 字符`);
  console.log(crashed ? '❌ 渲染期发生异常' : '✅ 渲染期无异常');
  console.log(
    text.includes('钢板') ? '✅ 明细已渲染（找到「钢板」）' : '❌ 明细未渲染（textContent 里没有物料名）',
  );
  console.log('请求序列：', calls.join(' | '));
} catch (e: any) {
  crashed = true;
  console.log('❌ 挂载/交互失败');
  console.log(e?.stack ?? String(e));
} finally {
  await server.close();
}

console.log(crashed ? '\n==== 结论：点开展开明细会白屏 ====' : '\n==== 结论：展开交互正常 ====');
if (crashed) process.exitCode = 1;
