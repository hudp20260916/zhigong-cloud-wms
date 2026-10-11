import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const webRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(webRoot, '..');

export default defineConfig({
  plugins: [react()],
  // 相对基址：构建产物可放在任意子路径下（GitHub Pages 仓库站点 / Nginx 子目录），
  // 路由是 HashRouter，不依赖服务端路径重写
  base: './',
  resolve: {
    alias: {
      '@shared': path.resolve(repoRoot, 'shared'),
      '@': path.resolve(webRoot, 'src'),
    },
  },
  server: {
    port: 5173,
    // 监听所有网卡：局域网内其他电脑也要能打开本地测试地址
    host: true,
    // 共享常量目录在 web 之外，需要显式放开
    fs: { allow: [repoRoot] },
    proxy: {
      '/api': { target: 'http://127.0.0.1:3001', changeOrigin: true },
    },
  },
});
