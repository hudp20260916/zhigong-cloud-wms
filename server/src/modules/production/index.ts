import { Router } from 'express';
import { workOrderRouter } from './workOrders.js';
import { issueRouter } from './issues.js';
import { materialReturnRouter } from './returns.js';
import { productReceiptRouter } from './receipts.js';

export const productionRouter = Router();

productionRouter.use('/work-orders', workOrderRouter);
productionRouter.use('/issues', issueRouter);
productionRouter.use('/returns', materialReturnRouter);
productionRouter.use('/receipts', productReceiptRouter);
