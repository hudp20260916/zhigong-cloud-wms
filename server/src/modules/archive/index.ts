import { Router } from 'express';
import { materialRouter } from './materials.js';
import { productRouter } from './products.js';
import { supplierRouter, customerRouter } from './partners.js';

export const archiveRouter = Router();

archiveRouter.use('/materials', materialRouter);
archiveRouter.use('/products', productRouter);
archiveRouter.use('/suppliers', supplierRouter);
archiveRouter.use('/customers', customerRouter);
