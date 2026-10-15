import path from 'node:path';
import fs from 'node:fs';
import express from 'express';
import cors from 'cors';
import { authRouter } from './modules/auth/routes.js';
import { archiveRouter } from './modules/archive/index.js';
import { inventoryRouter } from './modules/inventory/routes.js';
import { purchaseRouter } from './modules/purchase/index.js';
import { productionRouter } from './modules/production/index.js';
import { saleRouter } from './modules/sales/routes.js';
import { warehouseRouter } from './modules/warehouse/routes.js';
import { systemRouter } from './modules/system/routes.js';
import { financeModuleRouter } from './modules/finance/index.js';
import { reportRouter } from './modules/reports/index.js';
import { dashboardRouter } from './modules/dashboard/routes.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';
import { requireAuth } from './middleware/auth.js';
import { licenseWriteGate } from './middleware/license.js';
import { config } from './config.js';

export function createApp() {
  const app = express();

  app.use(cors());
  app.use(express.json({ limit: '10mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, data: { status: 'ok', time: new Date().toISOString() } });
  });

  // 登录接口无需鉴权，其余 /api 接口统一先过鉴权，业务路由只关心权限点
  app.use('/api/auth', authRouter);
  app.use('/api', requireAuth);
  // 授权写入门禁：授权彻底过期后进入只读模式（查询/导出不受影响，激活接口可自救）
  app.use('/api', licenseWriteGate);

  app.use('/api/dashboard', dashboardRouter);
  app.use('/api/archive', archiveRouter);
  app.use('/api/inventory', inventoryRouter);
  app.use('/api/purchase', purchaseRouter);
  app.use('/api/production', productionRouter);
  app.use('/api/sale', saleRouter);
  app.use('/api/warehouse', warehouseRouter);
  app.use('/api/system', systemRouter);
  app.use('/api/finance', financeModuleRouter);
  app.use('/api/reports', reportRouter);

  app.use('/api', notFoundHandler);

  // 一体化部署：web/dist 存在时由后端直接托管前端（单进程单域名，最省事）。
  // 分离部署（静态托管 + 独立后端）时该目录不存在，自动跳过。
  const webDist = path.resolve(config.serverRoot, '../web/dist');
  if (fs.existsSync(path.join(webDist, 'index.html'))) {
    app.use(express.static(webDist));
    // HashRouter：除 /api 外的所有路径都回 index.html
    app.get(/^\/(?!api\/).*/, (_req, res) => {
      res.sendFile(path.join(webDist, 'index.html'));
    });
  }

  app.use(errorHandler);

  return app;
}
