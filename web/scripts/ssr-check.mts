/**
 * 页面 SSR 冒烟：用 Vite 的 ssrLoadModule 真实加载页面模块并 renderToString，
 * 目的是抓「点进去白屏」这类**渲染期**异常（tsc / build 都抓不到）。
 *
 * 用法：
 *   npx tsx --tsconfig web/tsconfig.json web/scripts/ssr-check.mts <相对 src 的页面路径>
 * 例：
 *   npx tsx --tsconfig web/tsconfig.json web/scripts/ssr-check.mts /src/features/purchase/PurchaseReceiptPage.tsx
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

// 一律用脚本自身位置推导 web 根目录，避免 cwd 被 npx / Git Bash 改掉后
// Vite 把 /src/... 解析到别的地方（第一次跑就踩了这个坑）
const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// antd 在模块加载 / 渲染时会摸 window，先备好 DOM 环境
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
g.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
g.requestAnimationFrame = (cb: any) => setTimeout(cb, 0);
g.cancelAnimationFrame = (id: any) => clearTimeout(id);
g.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
g.ShadowRoot = dom.window.ShadowRoot;
g.localStorage = dom.window.localStorage;
g.sessionStorage = dom.window.sessionStorage;
g.matchMedia =
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

const target = process.argv[2] || '/src/features/purchase/PurchaseReceiptPage.tsx';

const { createServer } = await import('vite');
const server = await createServer({
  root: WEB_ROOT,
  configFile: path.join(WEB_ROOT, 'vite.config.ts'),
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'error',
});

const React = (await import('react')).default;
const { renderToString } = await import('react-dom/server');
const { MemoryRouter } = await import('react-router-dom');

const targetId = target.replace(/^\//, '');
const targetFile = path.isAbsolute(targetId) ? targetId : path.join(WEB_ROOT, targetId);

try {
  const mod = await server.ssrLoadModule(targetFile);
  const Comp = mod.default;
  if (!Comp) throw new Error('模块没有 default 导出');
  const html = renderToString(
    React.createElement(MemoryRouter, null, React.createElement(Comp)),
  );
  console.log(`✅ 渲染成功：${target}（HTML ${html.length} 字符）`);
} catch (e: any) {
  console.log(`❌ 渲染失败：${target}`);
  console.log(e?.stack ?? String(e));
  process.exitCode = 1;
} finally {
  await server.close();
}
