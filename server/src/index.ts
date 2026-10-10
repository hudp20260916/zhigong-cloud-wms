import { createApp } from './app.js';
import { config } from './config.js';
import { db, migrate } from './db/index.js';
import { seedIfEmpty } from './db/seed.js';

migrate();
seedIfEmpty();

const app = createApp();

/**
 * 兜底：任何漏掉 asyncRoute 包装的异步路由抛出的异常，
 * 都不应该让整个服务退出（Express 4 不捕获 async 异常，默认行为是 kill 进程）。
 */
process.on('unhandledRejection', (reason) => {
  console.error('[server] 未处理的 Promise 异常：', reason);
});

app.listen(config.port, () => {
  console.log(`[server] 已启动 http://localhost:${config.port}`);
  console.log(`[server] 数据文件 ${config.dbFile}`);
});

process.on('SIGINT', () => {
  db.close();
  process.exit(0);
});
