import { Router } from 'express';
import { purchaseOrderRouter } from './orders.js';
import { purchaseReceiptRouter } from './receipts.js';
import { purchaseReturnRouter } from './returns.js';
import { purchaseArrivalRouter } from './arrivals.js';
import { ocrRouter } from './ocr.js';

export const purchaseRouter = Router();

purchaseRouter.use('/orders', purchaseOrderRouter);
purchaseRouter.use('/receipts', purchaseReceiptRouter);
purchaseRouter.use('/returns', purchaseReturnRouter);
purchaseRouter.use('/arrivals', purchaseArrivalRouter);
purchaseRouter.use('/ocr', ocrRouter);
