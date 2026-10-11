import { Router } from 'express';
import { summarize } from '../../../../shared/enums.js';
import { db } from '../../db/index.js';
import { maskList } from '../../core/serializer.js';
import { requirePerm } from '../../middleware/auth.js';
import { canViewPrice } from '../../middleware/context.js';
import { countRows, parsePage } from '../../shared/query.js';
import { okList } from '../../shared/http.js';

export const purchaseArrivalRouter = Router();

/**
 * 到货核对：按订单明细展示下单量 / 已入库 / 差异。
 * 采购内容列：有主产品显示主产品名称，否则显示物料名称（需求 3.4.5）
 */
purchaseArrivalRouter.get('/', requirePerm('purchase.arrival.view'), (req, res) => {
  const { page, pageSize, offset, keyword } = parsePage(req);

  const cond: string[] = ["o.status <> '已撤销'"];
  const params: any[] = [];
  // 需求 7：按日期区间（下单日期）、供应商、物料名称/编码包含字筛选
  const supplierId = Number(req.query.supplierId ?? 0) || 0;
  const materialKeyword = String(req.query.materialKeyword ?? '').trim();
  const dateFrom = String(req.query.dateFrom ?? '').trim();
  const dateTo = String(req.query.dateTo ?? '').trim();

  if (keyword) {
    cond.push(`(IFNULL(p.name,'') LIKE ? OR IFNULL(m.name,'') LIKE ? OR IFNULL(o.order_no,'') LIKE ?)`);
    params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`);
  }
  if (supplierId) {
    cond.push('o.supplier_id = ?');
    params.push(supplierId);
  }
  if (dateFrom) {
    cond.push('o.order_date >= ?');
    params.push(dateFrom);
  }
  if (dateTo) {
    cond.push('o.order_date <= ?');
    params.push(dateTo);
  }
  if (materialKeyword) {
    cond.push('(m.name LIKE ? OR m.code LIKE ?)');
    params.push(`%${materialKeyword}%`, `%${materialKeyword}%`);
  }

  const rows = db
    .prepare(
      `SELECT o.id AS order_id, o.order_no, o.parent_order_no, o.order_date, o.expected_date, o.status,
              s.name AS supplier_name, p.name AS product_name,
              i.id AS item_id, i.material_id, m.code AS material_code, m.name AS material_name,
              m.spec, m.unit, i.qty AS order_qty, i.received_qty, i.price
         FROM purchase_order_items i
         JOIN purchase_orders o ON o.id = i.order_id
         JOIN materials m ON m.id = i.material_id
         LEFT JOIN suppliers s ON s.id = o.supplier_id
         LEFT JOIN products p ON p.id = o.product_id
        WHERE ${cond.join(' AND ')}
        ORDER BY o.id DESC, i.id ASC
        LIMIT ? OFFSET ?`,
    )
    .all(...params, pageSize, offset) as any[];

  const total = countRows(
    `purchase_order_items i
      JOIN purchase_orders o ON o.id = i.order_id
      JOIN materials m ON m.id = i.material_id
      LEFT JOIN suppliers s ON s.id = o.supplier_id
      LEFT JOIN products p ON p.id = o.product_id`,
    cond.join(' AND '),
    params,
  );

  const list = maskList(rows, { canViewPrice: canViewPrice(req.ctx!) }).map((r: any) => ({
    ...r,
    pendingQty: Math.max(0, Number(r.order_qty) - Number(r.received_qty)),
    purchaseContent: r.product_name || r.material_name,
    arrivalStatus:
      Number(r.received_qty) >= Number(r.order_qty)
        ? '已到齐'
        : Number(r.received_qty) > 0
          ? '部分到货'
          : '未到货',
  }));

  okList(res, list, total);
});

export { summarize };
