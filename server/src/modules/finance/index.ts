import { Router } from 'express';
import { financeRouter } from './settlements.js';

/**
 * 财务模块。
 * 目前只有采购应付结算；收款（销售应收）走同一套 settlement 模型的扩展点：
 * 后续加 customer_settlements 时可复用 settlements.ts 的核销算法（抽到 core/settle.ts）。
 */
export const financeModuleRouter = Router();

financeModuleRouter.use('/', financeRouter);

export { financeRouter };
