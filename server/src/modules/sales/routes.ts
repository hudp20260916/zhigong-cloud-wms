import { Router } from 'express';
import { z } from 'zod';
import { DOC_STATUS } from '../../../../shared/enums.js';
import { db, nowIso, tx } from '../../db/index.js';
import { Err } from '../../core/errors.js';
import { nextCode } from '../../core/code.js';
import { applyStock, reverseStock } from '../../core/ledger.js';
import { writeLog } from '../../core/log.js';
import { maskList } from '../../core/serializer.js';
import { requirePerm } from '../../middleware/auth.js';
import { canViewPrice } from '../../middleware/context.js';
import { countRows, parsePage } from '../../shared/query.js';
import { ok, okList } from '../../shared/http.js';

export const saleRouter = Router();

const itemSchema = z.object({
  productId: z.number().int().positive(),
  qty: z.number().positive('数量必须大于 0'),
  price: z.number().min(0).default(0),
});

const orderSchema = z.object({
  customerId: z.number().int().nullable().optional(),
  orderDate: z.string().min(1, '请选择开单日期'),
  items: z.array(itemSchema).min(1, '请至少录入一条销售明细'),
  remark: z.string().trim().optional().default(''),
});

// ---------------- 销售开单 ----------------

saleRouter.get('/orders', requirePerm('sale.order.view'), (req, res) => {
  const { page, pageSize, offset, keyword } = parsePage(req);
  const where = keyword ? `(o.order_no LIKE @kw OR IFNULL(c.name,'') LIKE @kw)` : '1=1';
  const params = keyword ? { kw: `%${keyword}%`, limit: pageSize, offset } : { limit: pageSize, offset };

  const rows = db
    .prepare(
      `SELECT o.*, c.name AS customer_name, u.display_name AS creator_name,
              (SELECT IFNULL(SUM(qty),0) FROM sale_order_items i WHERE i.order_id = o.id) AS total_qty
         FROM sale_orders o
         LEFT JOIN customers c ON c.id = o.customer_id
         LEFT JOIN users u ON u.id = o.created_by
        WHERE ${where} ORDER BY o.id DESC LIMIT @limit OFFSET @offset`,
    )
    .all(params) as any[];

  const total = countRows(
    `sale_orders o LEFT JOIN customers c ON c.id = o.customer_id`,
    keyword ? `(o.order_no LIKE ? OR IFNULL(c.name,'') LIKE ?)` : '1=1',
    keyword ? [`%${keyword}%`, `%${keyword}%`] : [],
  );

  const ctx = req.ctx!;
  okList(
    res,
    maskList(rows, { canViewPrice: canViewPrice(ctx) }).map((r: any) => ({
      ...r,
      pendingQty: Math.max(0, Number(r.total_qty) - Number(r.deliveredTotal ?? 0)),
      canDeliver: ctx.permissions.includes('sale.delivery.create') && r.status === '待出库',
      canReturn: ctx.permissions.includes('sale.return.create') && r.status !== '已撤销',
    })),
    total,
  );
});

saleRouter.post('/orders', requirePerm('sale.order.create'), (req, res) => {
  const parsed = orderSchema.safeParse(req.body);
  if (!parsed.success) throw Err.badRequest(parsed.error.issues[0].message);
  const d = parsed.data;

  const id = tx(() => {
    // 开单即校验库存，避免开出无法出库的单据
    for (const it of d.items) {
      const p = db.prepare(`SELECT name, current_stock FROM products WHERE id = ?`).get(it.productId) as any;
      if (!p) throw Err.notFound('成品档案不存在');
      if (Number(p.current_stock) < it.qty) {
        throw Err.conflict(`成品【${p.name}】可用库存不足：可用 ${p.current_stock}，本次需 ${it.qty}`);
      }
    }

    const orderNo = nextCode('saleOrder', d.orderDate);
    const totalAmount = d.items.reduce((s, i) => s + i.qty * i.price, 0);
    const info = db
      .prepare(
        `INSERT INTO sale_orders (order_no, customer_id, order_date, status, total_amount, remark, created_by, created_at, updated_at)
         VALUES (?,?,?, '待出库', ?,?,?,?,?)`,
      )
      .run(orderNo, d.customerId ?? null, d.orderDate, totalAmount, d.remark, req.ctx!.userId, nowIso(), nowIso());
    const orderId = Number(info.lastInsertRowid);

    const ins = db.prepare(
      `INSERT INTO sale_order_items (order_id, product_id, qty, price, delivered_qty) VALUES (?,?,?,?,0)`,
    );
    for (const it of d.items) ins.run(orderId, it.productId, it.qty, it.price);

    writeLog({
      operatorId: req.ctx!.userId,
      action: '销售开单',
      targetType: 'sale_order',
      targetId: orderId,
      detail: { orderNo, totalAmount },
    });
    return orderId;
  });
  ok(res, { id });
});

saleRouter.get('/orders/:id', requirePerm('sale.order.view'), (req, res) => {
  const id = Number(req.params.id);
  const order = db
    .prepare(`SELECT o.*, c.name AS customer_name FROM sale_orders o LEFT JOIN customers c ON c.id = o.customer_id WHERE o.id = ?`)
    .get(id) as any;
  if (!order) throw Err.notFound('销售单不存在');
  const items = db
    .prepare(
      `SELECT i.*, p.code, p.name, p.spec, p.unit, p.current_stock
         FROM sale_order_items i JOIN products p ON p.id = i.product_id WHERE i.order_id = ?`,
    )
    .all(id) as any[];
  const ctx = { canViewPrice: canViewPrice(req.ctx!) };
  ok(res, { order: maskList([order], ctx)[0], items: maskList(items, ctx) });
});

// ---------------- 销售出库 ----------------

saleRouter.get('/deliveries', requirePerm('sale.delivery.view'), (req, res) => {
  const { page, pageSize, offset, keyword } = parsePage(req);
  const where = keyword ? `(d.delivery_no LIKE @kw OR IFNULL(o.order_no,'') LIKE @kw)` : '1=1';
  const params = keyword ? { kw: `%${keyword}%`, limit: pageSize, offset } : { limit: pageSize, offset };

  const rows = db
    .prepare(
      `SELECT d.*, o.order_no, c.name AS customer_name, u.display_name AS operator_name
         FROM sale_deliveries d
         LEFT JOIN sale_orders o ON o.id = d.order_id
         LEFT JOIN customers c ON c.id = d.customer_id
         LEFT JOIN users u ON u.id = d.operator_id
        WHERE ${where} ORDER BY d.id DESC LIMIT @limit OFFSET @offset`,
    )
    .all(params) as any[];

  const total = countRows(
    `sale_deliveries d LEFT JOIN sale_orders o ON o.id = d.order_id`,
    keyword ? `(d.delivery_no LIKE ? OR IFNULL(o.order_no,'') LIKE ?)` : '1=1',
    keyword ? [`%${keyword}%`, `%${keyword}%`] : [],
  );

  const ctx = req.ctx!;
  okList(
    res,
    maskList(rows, { canViewPrice: canViewPrice(ctx) }).map((r: any) => ({
      ...r,
      canUndo: ctx.permissions.includes('sale.delivery.create') && r.status === DOC_STATUS.VALID,
    })),
    total,
  );
});

/** 一键生成出库单：扣减成品库存，禁止负库存 */
saleRouter.post('/deliveries', requirePerm('sale.delivery.create'), (req, res) => {
  const schema = z.object({
    orderId: z.number().int().positive('必须关联销售开单'),
    deliveryDate: z.string().min(1, '请选择出库日期'),
    remark: z.string().trim().optional().default(''),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) throw Err.badRequest(parsed.error.issues[0].message);
  const d = parsed.data;

  const id = tx(() => {
    const order = db.prepare(`SELECT * FROM sale_orders WHERE id = ?`).get(d.orderId) as any;
    if (!order) throw Err.notFound('销售单不存在');
    if (order.status === '已撤销') throw Err.conflict('该销售单已撤销，无法出库');
    if (order.status === '已出库') throw Err.conflict('该销售单已全部出库');

    const items = db
      .prepare(
        `SELECT i.*, p.name FROM sale_order_items i JOIN products p ON p.id = i.product_id
          WHERE i.order_id = ? AND i.delivered_qty < i.qty`,
      )
      .all(d.orderId) as any[];
    if (items.length === 0) throw Err.conflict('该销售单没有待出库明细');

    const deliveryNo = nextCode('saleDelivery', d.deliveryDate);
    const totalAmount = items.reduce(
      (s, i) => s + (Number(i.qty) - Number(i.delivered_qty)) * Number(i.price),
      0,
    );
    const info = db
      .prepare(
        `INSERT INTO sale_deliveries (delivery_no, order_id, customer_id, delivery_date, status, total_amount, operator_id, remark, created_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        deliveryNo,
        d.orderId,
        order.customer_id,
        d.deliveryDate,
        DOC_STATUS.VALID,
        totalAmount,
        req.ctx!.userId,
        d.remark,
        nowIso(),
      );
    const deliveryId = Number(info.lastInsertRowid);

    const ins = db.prepare(`INSERT INTO sale_delivery_items (delivery_id, product_id, qty, price) VALUES (?,?,?,?)`);
    const entries = [];
    for (const it of items) {
      const qty = Number(it.qty) - Number(it.delivered_qty);
      ins.run(deliveryId, it.product_id, qty, it.price);
      entries.push({
        itemType: 'product' as const,
        itemId: it.product_id,
        direction: 'out' as const,
        qty,
        bizType: '销售出库',
        bizId: deliveryId,
        bizNo: deliveryNo,
        unitPrice: it.price,
        operatorId: req.ctx!.userId,
      });
    }
    applyStock(entries);

    const upd = db.prepare(`UPDATE sale_order_items SET delivered_qty = qty WHERE order_id = ?`);
    upd.run(d.orderId);
    db.prepare(`UPDATE sale_orders SET status = '已出库', updated_at = ? WHERE id = ?`).run(nowIso(), d.orderId);

    writeLog({
      operatorId: req.ctx!.userId,
      action: '销售出库',
      targetType: 'sale_delivery',
      targetId: deliveryId,
      detail: { deliveryNo, orderNo: order.order_no },
    });
    return deliveryId;
  });
  ok(res, { id });
});

/** 撤销出库：恢复待出库状态并回补库存 */
saleRouter.post('/deliveries/:id/undo', requirePerm('sale.delivery.create'), (req, res) => {
  const id = Number(req.params.id);
  tx(() => {
    const d = db.prepare(`SELECT * FROM sale_deliveries WHERE id = ?`).get(id) as any;
    if (!d) throw Err.notFound('出库单不存在');
    if (d.status !== DOC_STATUS.VALID) throw Err.conflict('该出库单已撤销');

    reverseStock('销售出库', id, req.ctx!.userId);
    db.prepare(`UPDATE sale_deliveries SET status = ? WHERE id = ?`).run(DOC_STATUS.CANCELLED, id);

    const items = db.prepare(`SELECT * FROM sale_delivery_items WHERE delivery_id = ?`).all(id) as any[];
    const upd = db.prepare(
      `UPDATE sale_order_items SET delivered_qty = MAX(delivered_qty - ?, 0) WHERE order_id = ? AND product_id = ?`,
    );
    for (const it of items) upd.run(it.qty, d.order_id, it.product_id);

    if (d.order_id) {
      db.prepare(`UPDATE sale_orders SET status = '待出库', updated_at = ? WHERE id = ?`).run(nowIso(), d.order_id);
    }
    writeLog({
      operatorId: req.ctx!.userId,
      action: '撤销销售出库',
      targetType: 'sale_delivery',
      targetId: id,
    });
  });
  ok(res, { id });
});

// ---------------- 销售退货 ----------------

saleRouter.get('/returns', requirePerm('sale.return.view'), (req, res) => {
  const { page, pageSize, offset } = parsePage(req);
  const rows = db
    .prepare(
      `SELECT r.*, o.order_no, c.name AS customer_name, u.display_name AS operator_name
         FROM sale_returns r
         LEFT JOIN sale_orders o ON o.id = r.order_id
         LEFT JOIN customers c ON c.id = r.customer_id
         LEFT JOIN users u ON u.id = r.operator_id
        ORDER BY r.id DESC LIMIT ? OFFSET ?`,
    )
    .all(pageSize, offset) as any[];
  const ctx = req.ctx!;
  okList(
    res,
    maskList(rows, { canViewPrice: canViewPrice(ctx) }).map((r: any) => ({
      ...r,
      canUndo: ctx.permissions.includes('sale.return.create') && r.status === DOC_STATUS.VALID,
    })),
    countRows('sale_returns'),
  );
});

saleRouter.post('/returns', requirePerm('sale.return.create'), (req, res) => {
  const schema = z.object({
    orderId: z.number().int().nullable().optional(),
    customerId: z.number().int().nullable().optional(),
    returnDate: z.string().min(1, '请选择退货日期'),
    items: z.array(itemSchema).min(1, '请至少录入一条退货明细'),
    remark: z.string().trim().optional().default(''),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) throw Err.badRequest(parsed.error.issues[0].message);
  const d = parsed.data;

  const id = tx(() => {
    const returnNo = nextCode('saleReturn', d.returnDate);
    const totalAmount = d.items.reduce((s, i) => s + i.qty * i.price, 0);
    const info = db
      .prepare(
        `INSERT INTO sale_returns (return_no, order_id, customer_id, return_date, status, total_amount, operator_id, remark, created_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        returnNo,
        d.orderId ?? null,
        d.customerId ?? null,
        d.returnDate,
        DOC_STATUS.VALID,
        totalAmount,
        req.ctx!.userId,
        d.remark,
        nowIso(),
      );
    const returnId = Number(info.lastInsertRowid);
    const ins = db.prepare(`INSERT INTO sale_return_items (return_id, product_id, qty, price) VALUES (?,?,?,?)`);
    for (const it of d.items) ins.run(returnId, it.productId, it.qty, it.price);

    // 退货 = 成品入库
    applyStock(
      d.items.map((it) => ({
        itemType: 'product' as const,
        itemId: it.productId,
        direction: 'in' as const,
        qty: it.qty,
        bizType: '销售退货',
        bizId: returnId,
        bizNo: returnNo,
        unitPrice: it.price,
        operatorId: req.ctx!.userId,
      })),
    );

    writeLog({
      operatorId: req.ctx!.userId,
      action: '销售退货',
      targetType: 'sale_return',
      targetId: returnId,
      detail: { returnNo },
    });
    return returnId;
  });
  ok(res, { id });
});

saleRouter.post('/returns/:id/undo', requirePerm('sale.return.create'), (req, res) => {
  const id = Number(req.params.id);
  tx(() => {
    const r = db.prepare(`SELECT * FROM sale_returns WHERE id = ?`).get(id) as any;
    if (!r) throw Err.notFound('退货单不存在');
    if (r.status !== DOC_STATUS.VALID) throw Err.conflict('该退货单已撤销');
    reverseStock('销售退货', id, req.ctx!.userId);
    db.prepare(`UPDATE sale_returns SET status = ? WHERE id = ?`).run(DOC_STATUS.CANCELLED, id);
    writeLog({
      operatorId: req.ctx!.userId,
      action: '撤销销售退货',
      targetType: 'sale_return',
      targetId: id,
    });
  });
  ok(res, { id });
});
