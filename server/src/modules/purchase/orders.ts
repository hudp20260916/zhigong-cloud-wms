import { Router } from 'express';
import { z } from 'zod';
import { PO_STATUS } from '../../../../shared/enums.js';
import { db, nowIso, tx } from '../../db/index.js';
import { Err } from '../../core/errors.js';
import { nextCode } from '../../core/code.js';
import { writeLog } from '../../core/log.js';
import { maskList } from '../../core/serializer.js';
import { requirePerm } from '../../middleware/auth.js';
import { canViewPrice } from '../../middleware/context.js';
import { countRows, parsePage } from '../../shared/query.js';
import { ok, okList } from '../../shared/http.js';
import {
  buildSummary,
  hasPending,
  materialNames,
  pendingItemsOf,
  refreshOrderStatus,
  syncParentStatus,
} from './helpers.js';

export const purchaseOrderRouter = Router();

const itemSchema = z.object({
  materialId: z.number().int().positive(),
  qty: z.number().positive('采购数量必须大于 0'),
  price: z.number().min(0).default(0),
});

const createSchema = z.object({
  mode: z.enum(['bom', 'direct']),
  items: z.array(itemSchema).min(1, '请至少选择一项采购内容'),
  /** bom 模式：主产品与计划产量，用于记录 BOM 版本与展开来源 */
  productId: z.number().int().nullable().optional(),
  planQty: z.number().positive().nullable().optional(),
  bomVersion: z.string().trim().optional(),
  /** 手工指定供应商时覆盖物料默认供应商 */
  supplierId: z.number().int().nullable().optional(),
  orderDate: z.string().min(1, '请选择下单日期'),
  expectedDate: z.string().optional().default(''),
  remark: z.string().trim().optional().default(''),
});

/** 列表：附带采购摘要、是否可去入库（需求 4.1 状态与权限联动） */
purchaseOrderRouter.get('/', requirePerm('purchase.order.view'), (req, res) => {
  const { page, pageSize, offset, keyword } = parsePage(req);
  const status = String(req.query.status ?? '').trim();

  const cond: string[] = ['1=1'];
  const params: any[] = [];
  if (keyword) {
    cond.push(
      `(o.order_no LIKE @kw OR IFNULL(o.summary,'') LIKE @kw OR IFNULL(s.name,'') LIKE @kw OR IFNULL(p.name,'') LIKE @kw)`,
    );
  }
  if (status) {
    cond.push('o.status = @status');
  }

  const bind: any = { limit: pageSize, offset };
  if (keyword) bind.kw = `%${keyword}%`;
  if (status) bind.status = status;

  const rows = db
    .prepare(
      `SELECT o.*, s.name AS supplier_name, u.display_name AS creator_name, p.name AS product_name,
              (SELECT COUNT(*) FROM purchase_order_items i WHERE i.order_id = o.id) AS item_count
         FROM purchase_orders o
         LEFT JOIN suppliers s ON s.id = o.supplier_id
         LEFT JOIN users u ON u.id = o.created_by
         LEFT JOIN products p ON p.id = o.product_id
        WHERE ${cond.join(' AND ')}
        ORDER BY o.id DESC
        LIMIT @limit OFFSET @offset`,
    )
    .all(bind) as any[];

  const totalParams: any[] = [];
  const totalCond = cond.map((c) => {
    if (c.includes('@kw')) {
      totalParams.push(`%${keyword}%`);
      return c.replace('@kw', '?');
    }
    if (c.includes('@status')) {
      totalParams.push(status);
      return c.replace('@status', '?');
    }
    return c;
  });
  const total = countRows(
    `purchase_orders o
      LEFT JOIN suppliers s ON s.id = o.supplier_id
      LEFT JOIN users u ON u.id = o.created_by
      LEFT JOIN products p ON p.id = o.product_id`,
    totalCond.join(' AND '),
    totalParams,
  );

  const ctx = req.ctx!;
  const canReceive = ctx.role === 'admin' || ctx.permissions.includes('purchase.receipt.create');
  const canEditOrder = ctx.permissions.includes('purchase.order.update');

  const list = maskList(rows, { canViewPrice: canViewPrice(ctx) }).map((r: any) => {
    const isParent = r.item_count === 0;
    // 采购员只能改自己建的，管理员可改全部进行中订单
    const editable =
      canEditOrder &&
      !isParent &&
      r.status === PO_STATUS.ONGOING &&
      (ctx.role === 'admin' || r.created_by === ctx.userId);

    return {
      ...r,
      isParent,
      canReceive: canReceive && !isParent && r.status === PO_STATUS.ONGOING && hasPending(r.id),
      canEdit: editable,
      canDelete: ctx.permissions.includes('purchase.order.delete') && !isParent,
    };
  });

  okList(res, list, total);
});

/** 去入库预填数据：带出订单与待入库明细（需求 4.1） */
purchaseOrderRouter.get('/:id/pending', requirePerm('purchase.receipt.create'), (req, res) => {
  const id = Number(req.params.id);
  const order = db
    .prepare(
      `SELECT o.*, s.name AS supplier_name, p.name AS product_name
         FROM purchase_orders o
         LEFT JOIN suppliers s ON s.id = o.supplier_id
         LEFT JOIN products p ON p.id = o.product_id
        WHERE o.id = ?`,
    )
    .get(id) as any;
  if (!order) throw Err.notFound('采购订单不存在');
  if (order.status !== PO_STATUS.ONGOING) {
    throw Err.conflict('该订单当前状态不可入库');
  }
  ok(res, { order, items: pendingItemsOf(id) });
});

purchaseOrderRouter.get('/:id', requirePerm('purchase.order.view'), (req, res) => {
  const id = Number(req.params.id);
  const order = db
    .prepare(
      `SELECT o.*, s.name AS supplier_name, p.name AS product_name
         FROM purchase_orders o
         LEFT JOIN suppliers s ON s.id = o.supplier_id
         LEFT JOIN products p ON p.id = o.product_id
        WHERE o.id = ?`,
    )
    .get(id) as any;
  if (!order) throw Err.notFound('采购订单不存在');

  const items = db
    .prepare(
      `SELECT i.*, m.code, m.name, m.spec, m.unit
         FROM purchase_order_items i JOIN materials m ON m.id = i.material_id
        WHERE i.order_id = ?`,
    )
    .all(id) as any[];

  ok(res, {
    order: maskList([order], { canViewPrice: canViewPrice(req.ctx!) })[0],
    items: maskList(items, { canViewPrice: canViewPrice(req.ctx!) }),
  });
});

/**
 * 新增采购订单（双模式 + 按默认供应商拆单）。
 * 拆单规则：单个供应商 -> 一条订单；多个供应商 -> 一条父单（无明细，仅汇总）+ N 条子单。
 * 父单不参与入库，避免出现重复入库入口。
 */
purchaseOrderRouter.post('/', requirePerm('purchase.order.create'), (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) throw Err.badRequest(parsed.error.issues[0].message);
  const d = parsed.data;
  const ctx = req.ctx!;

  const result = tx(() => {
    // 去重合并同一物料
    const merged = new Map<number, { qty: number; price: number }>();
    for (const it of d.items) {
      const cur = merged.get(it.materialId);
      if (cur) {
        cur.qty += it.qty;
        if (!cur.price && it.price) cur.price = it.price;
      } else {
        merged.set(it.materialId, { qty: it.qty, price: it.price });
      }
    }

    // 按供应商分组
    const groups = new Map<number | null, { materialId: number; qty: number; price: number }[]>();
    for (const [materialId, v] of merged) {
      const m = db.prepare(`SELECT default_supplier_id FROM materials WHERE id = ?`).get(materialId) as
        | { default_supplier_id: number | null }
        | undefined;
      if (!m) throw Err.badRequest(`物料 #${materialId} 不存在`);
      const supplier = d.supplierId ?? m.default_supplier_id ?? null;
      const arr = groups.get(supplier) ?? [];
      arr.push({ materialId, ...v });
      groups.set(supplier, arr);
    }

    const allNames = materialNames([...merged.keys()]);
    const summary = buildSummary(allNames);
    const created: { id: number; orderNo: string; supplierId: number | null }[] = [];

    const insertOrder = (supplierId: number | null, parentNo: string | null, names: string[]) => {
      const orderNo = nextCode('purchaseOrder', d.orderDate);
      const info = db
        .prepare(
          `INSERT INTO purchase_orders
             (order_no, parent_order_no, supplier_id, order_date, expected_date, created_by,
              status, mode, product_id, plan_qty, bom_version, summary, remark, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          orderNo,
          parentNo,
          supplierId,
          d.orderDate,
          d.expectedDate || null,
          ctx.userId,
          PO_STATUS.ONGOING,
          d.mode,
          d.productId ?? null,
          d.planQty ?? null,
          d.bomVersion ?? null,
          buildSummary(names),
          d.remark,
          nowIso(),
          nowIso(),
        );
      return { id: Number(info.lastInsertRowid), orderNo };
    };

    const insertItems = (orderId: number, items: { materialId: number; qty: number; price: number }[]) => {
      const stmt = db.prepare(
        `INSERT INTO purchase_order_items (order_id, material_id, qty, price, received_qty) VALUES (?,?,?,?,0)`,
      );
      for (const it of items) stmt.run(orderId, it.materialId, it.qty, it.price);
    };

    if (groups.size === 1) {
      const [supplierId, items] = [...groups.entries()][0];
      const o = insertOrder(supplierId, null, materialNames(items.map((i) => i.materialId)));
      insertItems(o.id, items);
      created.push({ ...o, supplierId });
    } else {
      const parent = insertOrder(null, null, allNames);
      for (const [supplierId, items] of groups.entries()) {
        const child = insertOrder(supplierId, parent.orderNo, materialNames(items.map((i) => i.materialId)));
        insertItems(child.id, items);
        created.push({ ...child, supplierId });
      }
      created.unshift({ ...parent, supplierId: null });
    }

    writeLog({
      operatorId: ctx.userId,
      action: '新增采购订单',
      targetType: 'purchase_order',
      targetId: created[0].id,
      detail: { mode: d.mode, summary, children: created.length },
    });

    return { orderNo: created[0].orderNo, orders: created, summary };
  });

  ok(res, result);
});

/** 编辑：仅进行中、未全部入库/未结算/未关闭；采购员限本人，管理员不限（需求 4.4） */
purchaseOrderRouter.put('/:id', requirePerm('purchase.order.update'), (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) throw Err.badRequest(parsed.error.issues[0].message);
  const d = parsed.data;
  const id = Number(req.params.id);
  const ctx = req.ctx!;

  tx(() => {
    const order = db.prepare(`SELECT * FROM purchase_orders WHERE id = ?`).get(id) as any;
    if (!order) throw Err.notFound('采购订单不存在');
    if (order.status !== PO_STATUS.ONGOING) {
      throw Err.conflict('仅进行中的订单可编辑；已入库完成、已结算或已关闭的订单禁止修改');
    }
    if (ctx.role !== 'admin' && order.created_by !== ctx.userId) {
      throw Err.forbidden('仅允许修改本人创建的采购订单');
    }
    const received = db
      .prepare(`SELECT COALESCE(SUM(received_qty),0) AS done FROM purchase_order_items WHERE order_id = ?`)
      .get(id) as { done: number };
    if (Number(received.done) > 0) {
      throw Err.conflict('该订单已发生入库，禁止修改');
    }

    const merged = new Map<number, { qty: number; price: number }>();
    for (const it of d.items) {
      const cur = merged.get(it.materialId);
      if (cur) {
        cur.qty += it.qty;
        if (!cur.price && it.price) cur.price = it.price;
      } else merged.set(it.materialId, { qty: it.qty, price: it.price });
    }

    db.prepare(`DELETE FROM purchase_order_items WHERE order_id = ?`).run(id);
    const stmt = db.prepare(
      `INSERT INTO purchase_order_items (order_id, material_id, qty, price, received_qty) VALUES (?,?,?,?,0)`,
    );
    for (const [materialId, v] of merged) stmt.run(id, materialId, v.qty, v.price);

    db.prepare(
      `UPDATE purchase_orders SET supplier_id=?, order_date=?, expected_date=?, mode=?, product_id=?,
         plan_qty=?, bom_version=?, summary=?, remark=?, updated_at=?
       WHERE id=?`,
    ).run(
      d.supplierId ?? null,
      d.orderDate,
      d.expectedDate || null,
      d.mode,
      d.productId ?? null,
      d.planQty ?? null,
      d.bomVersion ?? null,
      buildSummary(materialNames([...merged.keys()])),
      d.remark,
      nowIso(),
      id,
    );

    refreshOrderStatus(id);
    if (order.parent_order_no) syncParentStatus(order.parent_order_no);

    writeLog({
      operatorId: ctx.userId,
      action: '修改采购订单',
      targetType: 'purchase_order',
      targetId: id,
      detail: { orderNo: order.order_no },
    });
  });

  ok(res, { id });
});

purchaseOrderRouter.delete('/:id', requirePerm('purchase.order.delete'), (req, res) => {
  const id = Number(req.params.id);
  const ctx = req.ctx!;
  tx(() => {
    const order = db.prepare(`SELECT * FROM purchase_orders WHERE id = ?`).get(id) as any;
    if (!order) throw Err.notFound('采购订单不存在');
    if (order.status !== PO_STATUS.ONGOING) throw Err.conflict('仅进行中的订单可删除');
    if (ctx.role !== 'admin' && order.created_by !== ctx.userId) {
      throw Err.forbidden('仅允许删除本人创建的采购订单');
    }
    db.prepare(`DELETE FROM purchase_orders WHERE id = ?`).run(id);
    if (order.parent_order_no) syncParentStatus(order.parent_order_no);
    writeLog({
      operatorId: ctx.userId,
      action: '删除采购订单',
      targetType: 'purchase_order',
      targetId: id,
      detail: { orderNo: order.order_no },
    });
  });
  ok(res, { id });
});

export { refreshOrderStatus };
