import { Router } from 'express';
import { z } from 'zod';
import { DOC_STATUS, PO_STATUS, summarize } from '../../../../shared/enums.js';
import { db, nowIso, tx } from '../../db/index.js';
import { Err } from '../../core/errors.js';
import { nextCode } from '../../core/code.js';
import { applyStock, reverseStock } from '../../core/ledger.js';
import { writeLog } from '../../core/log.js';
import { maskList } from '../../core/serializer.js';
import { resolveWarehouse } from '../../core/warehouse.js';
import { requirePerm } from '../../middleware/auth.js';
import { canViewPrice } from '../../middleware/context.js';
import { countRows, parsePage } from '../../shared/query.js';
import { ok, okList } from '../../shared/http.js';
import { refreshOrderStatus, syncParentStatus } from './helpers.js';
import { linkOcrReceipt } from './ocr.js';

/** 4 位小数（与 ledger 内 round 口径一致） */
function round4(n: number): number {
  return Math.round(Number(n) * 10000) / 10000;
}

export const purchaseReceiptRouter = Router();

const itemSchema = z.object({
  materialId: z.number().int().positive(),
  qty: z.number().positive('入库数量必须大于 0'),
  price: z.number().min(0).default(0),
  isGift: z.boolean().default(false),
  remark: z.string().trim().optional().default(''),
});

const createSchema = z.object({
  orderId: z.number().int().nullable().optional(),
  supplierId: z.number().int().nullable().optional(),
  receiptDate: z.string().min(1, '请选择入库日期'),
  items: z.array(itemSchema).min(1, '请至少录入一条入库明细'),
  source: z.enum(['order', 'ocr']).default('order'),
  /** OCR 建单时带上识别请求号，用于把 ocr_logs 与最终入库单关联起来 */
  ocrRequestId: z.string().trim().optional(),
  /** 入库仓库：不传按物料的默认仓（物料库）；OCR 建单通常也不传 */
  warehouseId: z.number().int().positive().nullable().optional(),
  remark: z.string().trim().optional().default(''),
});

/** 采购内容：有父单优先展示主产品名称，无父单展示物料名称（需求 3.4.4） */
function purchaseContent(orderId: number | null | undefined, materialIds: number[]): string {
  if (orderId) {
    const order = db
      .prepare(
        `SELECT p.name AS product_name FROM purchase_orders o
           LEFT JOIN products p ON p.id = o.product_id WHERE o.id = ?`,
      )
      .get(orderId) as { product_name: string | null } | undefined;
    if (order?.product_name) return order.product_name;
  }
  if (materialIds.length === 0) return '';
  const ph = materialIds.map(() => '?').join(',');
  const rows = db.prepare(`SELECT name FROM materials WHERE id IN (${ph})`).all(...materialIds) as {
    name: string;
  }[];
  return summarize(rows.map((r) => r.name));
}

purchaseReceiptRouter.get('/', requirePerm('purchase.receipt.view'), (req, res) => {
  const { page, pageSize, offset, keyword } = parsePage(req);
  // 需求 6：按日期区间、供应商、物料名称/编码包含字筛选
  const supplierId = Number(req.query.supplierId ?? 0) || 0;
  const materialKeyword = String(req.query.materialKeyword ?? '').trim();
  const dateFrom = String(req.query.dateFrom ?? '').trim();
  const dateTo = String(req.query.dateTo ?? '').trim();

  const cond: string[] = ['1=1'];
  const params: any[] = [];
  if (keyword) {
    cond.push(
      `(IFNULL(s.name,'') LIKE ? OR EXISTS (SELECT 1 FROM purchase_receipt_items ri JOIN materials m ON m.id = ri.material_id WHERE ri.receipt_id = r.id AND (m.name LIKE ? OR m.code LIKE ?)))`,
    );
    params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`);
  }
  if (supplierId) {
    cond.push('r.supplier_id = ?');
    params.push(supplierId);
  }
  if (dateFrom) {
    cond.push('r.receipt_date >= ?');
    params.push(dateFrom);
  }
  if (dateTo) {
    cond.push('r.receipt_date <= ?');
    params.push(dateTo);
  }
  if (materialKeyword) {
    cond.push(
      `EXISTS (SELECT 1 FROM purchase_receipt_items ri JOIN materials m ON m.id = ri.material_id
                WHERE ri.receipt_id = r.id AND (m.name LIKE ? OR m.code LIKE ?))`,
    );
    params.push(`%${materialKeyword}%`, `%${materialKeyword}%`);
  }

  const rows = db
    .prepare(
      `SELECT r.id, r.order_id, r.supplier_id, r.receipt_date, r.status, r.source,
              r.total_amount, r.remark, r.created_at,
              s.name AS supplier_name, o.order_no, o.parent_order_no, o.product_id,
              p.name AS product_name, u.display_name AS operator_name,
              (SELECT IFNULL(GROUP_CONCAT(m.name, '、'), '')
                 FROM purchase_receipt_items ri JOIN materials m ON m.id = ri.material_id
                WHERE ri.receipt_id = r.id) AS material_names
         FROM purchase_receipts r
         LEFT JOIN suppliers s ON s.id = r.supplier_id
         LEFT JOIN purchase_orders o ON o.id = r.order_id
         LEFT JOIN products p ON p.id = o.product_id
         LEFT JOIN users u ON u.id = r.operator_id
        WHERE ${cond.join(' AND ')}
        ORDER BY r.id DESC
        LIMIT ? OFFSET ?`,
    )
    .all(...params, pageSize, offset) as any[];

  const total = countRows(
    `purchase_receipts r
      LEFT JOIN suppliers s ON s.id = r.supplier_id
      LEFT JOIN purchase_orders o ON o.id = r.order_id`,
    cond.join(' AND '),
    params,
  );

  const ctx = req.ctx!;
  const canUndo = ctx.permissions.includes('purchase.receipt.undo');
  const list = maskList(rows, { canViewPrice: canViewPrice(ctx) }).map((r: any) => ({
    ...r,
    // 采购内容优先取主产品名称，其次物料合并摘要
    purchaseContent: r.product_name || summarize(String(r.material_names ?? '').split('、').filter(Boolean)),
    canUndo: canUndo && r.status === DOC_STATUS.VALID,
  }));

  okList(res, list, total);
});

purchaseReceiptRouter.post('/', requirePerm('purchase.receipt.create'), (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) throw Err.badRequest(parsed.error.issues[0].message);
  const d = parsed.data;
  const ctx = req.ctx!;

  const id = tx(() => {
    let supplierId = d.supplierId ?? null;
    let parentNo: string | null = null;

    if (d.orderId) {
      const order = db.prepare(`SELECT * FROM purchase_orders WHERE id = ?`).get(d.orderId) as any;
      if (!order) throw Err.notFound('关联的采购订单不存在');
      if (order.status !== PO_STATUS.ONGOING) {
        throw Err.conflict('该采购订单当前状态不可入库');
      }
      supplierId = supplierId ?? order.supplier_id ?? null;
      parentNo = order.parent_order_no ?? null;
    }

    const materialIds = d.items.map((i) => i.materialId);

    // 超量校验：关联订单时统计超量并标记，不阻断（需求 3.4.4 超量待结算标记）
    const overs = new Set<number>();
    if (d.orderId) {
      for (const it of d.items) {
        const oi = db
          .prepare(`SELECT qty, received_qty FROM purchase_order_items WHERE order_id = ? AND material_id = ?`)
          .get(d.orderId, it.materialId) as { qty: number; received_qty: number } | undefined;
        if (!oi) {
          throw Err.conflict('入库物料不在该采购订单明细中，请核对');
        }
        if (Number(oi.received_qty) + it.qty > Number(oi.qty)) overs.add(it.materialId);
      }
    }

    const receiptNo = nextCode('purchaseReceipt', d.receiptDate);
    const totalAmount = d.items.reduce((s, i) => s + i.qty * i.price, 0);
    // 仓库：没传就按物料默认仓兜底，保证历史接口与 OCR 建单不受影响
    const whId = resolveWarehouse('material', d.warehouseId ?? null);

    const info = db
      .prepare(
        `INSERT INTO purchase_receipts
           (receipt_no, order_id, supplier_id, receipt_date, operator_id, status, source, total_amount, remark, warehouse_id, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        receiptNo,
        d.orderId ?? null,
        supplierId,
        d.receiptDate,
        ctx.userId,
        DOC_STATUS.VALID,
        d.source,
        totalAmount,
        d.remark,
        whId,
        nowIso(),
      );

    const receiptId = Number(info.lastInsertRowid);

    const insItem = db.prepare(
      `INSERT INTO purchase_receipt_items (receipt_id, material_id, qty, price, amount, is_gift, over_qty, remark)
       VALUES (?,?,?,?,?,?,?,?)`,
    );
    for (const it of d.items) {
      insItem.run(
        receiptId,
        it.materialId,
        it.qty,
        it.price,
        it.qty * it.price,
        it.isGift ? 1 : 0,
        overs.has(it.materialId) ? 1 : 0,
        it.remark,
      );
    }

    // 库存与移动加权成本：唯一入口 applyStock
    applyStock(
      d.items.map((it) => ({
        itemType: 'material' as const,
        itemId: it.materialId,
        direction: 'in' as const,
        qty: it.qty,
        bizType: '采购入库',
        bizId: receiptId,
        bizNo: undefined, // 入库单号前端不可见
        unitPrice: it.price,
        operatorId: ctx.userId,
        warehouseId: whId,
      })),
    );

    if (d.orderId) {
      const upd = db.prepare(
        `UPDATE purchase_order_items SET received_qty = received_qty + ?
          WHERE order_id = ? AND material_id = ?`,
      );
      for (const it of d.items) upd.run(it.qty, d.orderId, it.materialId);
      refreshOrderStatus(d.orderId);
      if (parentNo) syncParentStatus(parentNo);
    }

    writeLog({
      operatorId: ctx.userId,
      action: '采购入库',
      targetType: 'purchase_receipt',
      targetId: receiptId,
      detail: {
        orderId: d.orderId ?? null,
        count: d.items.length,
        totalAmount,
        source: d.source,
        ocrRequestId: d.ocrRequestId ?? null,
      },
    });

    return receiptId;
  });

  // OCR 草稿被采纳后回写日志，便于统计识别采纳率
  if (d.source === 'ocr') linkOcrReceipt(d.ocrRequestId, id);

  ok(res, { id });
});

purchaseReceiptRouter.get('/:id', requirePerm('purchase.receipt.view'), (req, res) => {
  const id = Number(req.params.id);
  const receipt = db.prepare(`SELECT * FROM purchase_receipts WHERE id = ?`).get(id) as any;
  if (!receipt) throw Err.notFound('入库单不存在');
  const items = db
    .prepare(
      `SELECT ri.*, m.code, m.name, m.spec, m.unit
         FROM purchase_receipt_items ri JOIN materials m ON m.id = ri.material_id
        WHERE ri.receipt_id = ?`,
    )
    .all(id) as any[];
  const ctx = { canViewPrice: canViewPrice(req.ctx!) };
  ok(res, {
    receipt: maskList([receipt], ctx)[0],
    items: maskList(items, ctx),
  });
});

/**
 * 需求：物料单价允许填 0，价格「后补」——入库时先按 0 走流程，结算前补录真实单价。
 *
 * 改价的本质（库存数量不变，只动成本与金额，不违反「库存变更只走 applyStock」约束）：
 *  1. 明细 price/amount、单据 total_amount 按新单价重算；
 *  2. 每个物料按其入库数量对新单价做移动加权，更新 materials.avg_cost
 *     （公式与 applyStock 入库一致：(旧成本×旧存 + 新单价×本单量) / (旧存+本单量)）；
 *  3. 同步把该单在 stock_ledger 的对应流水 unit_price/amount 改掉，台账与单据金额保持一致。
 * 0 价改 0 价是幂等的，改回 0 时按 0 金额重新加权（会把成本稀释为 0，属预期）。
 */
const repriceSchema = z.object({
  prices: z
    .array(
      z.object({
        materialId: z.number().int().positive(),
        price: z.number().min(0),
      }),
    )
    .min(1, '请至少指定一个物料的单价'),
});

purchaseReceiptRouter.post(
  '/:id/reprice',
  requirePerm('purchase.receipt.create'),
  (req, res) => {
    const id = Number(req.params.id);
    const parsed = repriceSchema.safeParse(req.body);
    if (!parsed.success) throw Err.badRequest(parsed.error.issues[0].message);
    const ctx = req.ctx!;

    const result = tx(() => {
      const receipt = db
        .prepare(`SELECT * FROM purchase_receipts WHERE id = ?`)
        .get(id) as any;
      if (!receipt) throw Err.notFound('入库单不存在');
      if (receipt.status !== DOC_STATUS.VALID) throw Err.conflict('该入库单已撤销，无法改价');

      const items = db
        .prepare(`SELECT * FROM purchase_receipt_items WHERE receipt_id = ?`)
        .all(id) as any[];
      const itemById = new Map(items.map((i) => [i.material_id, i]));

      const updItem = db.prepare(
        `UPDATE purchase_receipt_items SET price = ?, amount = ? WHERE receipt_id = ? AND material_id = ?`,
      );
      const updLedger = db.prepare(
        `UPDATE stock_ledger
          SET unit_price = ?, amount = ?
          WHERE biz_type = '采购入库' AND biz_id = ? AND item_type = 'material'
            AND item_id = ? AND status = '有效' AND is_reversal = 0`,
      );

      for (const p of parsed.data.prices) {
        const it = itemById.get(p.materialId);
        if (!it) throw Err.conflict(`该入库单里没有物料 ${p.materialId}，无法改价`);
        const qty = Number(it.qty);
        const amount = round4(qty * p.price);

        // 物料加权成本：旧成本基线 + 本单量新单价，移动加权
        const mat = db
          .prepare(`SELECT current_stock, avg_cost FROM materials WHERE id = ?`)
          .get(p.materialId) as { current_stock: number; avg_cost: number };
        const newAvg =
          Number(mat.current_stock) > 0
            ? (Number(mat.current_stock) * Number(mat.avg_cost) + qty * p.price) /
              (Number(mat.current_stock) + qty)
            : p.price;

        db.prepare(`UPDATE materials SET avg_cost = ?, updated_at = ? WHERE id = ?`).run(
          round4(newAvg),
          nowIso(),
          p.materialId,
        );
        updItem.run(p.price, amount, id, p.materialId);
        updLedger.run(p.price, amount, id, p.materialId);
      }

      // 单据总额 = 未改价的明细 + 改价后的明细
      const repicedIds = new Set(parsed.data.prices.map((p) => p.materialId));
      const repicedAmount = parsed.data.prices.reduce((s, p) => {
        const it = itemById.get(p.materialId)!;
        return s + round4(Number(it.qty) * p.price);
      }, 0);
      const untouchedAmount = items
        .filter((i) => !repicedIds.has(i.material_id))
        .reduce((s, i) => s + Number(i.amount), 0);
      const totalAmount = round4(untouchedAmount + repicedAmount);

      db.prepare(`UPDATE purchase_receipts SET total_amount = ? WHERE id = ?`).run(
        totalAmount,
        id,
      );

      writeLog({
        operatorId: ctx.userId,
        action: '补录/修改入库单价',
        targetType: 'purchase_receipt',
        targetId: id,
        detail: { count: parsed.data.prices.length, totalAmount },
      });

      return { totalAmount };
    });

    ok(res, { id, totalAmount: result.totalAmount });
  },
);

/** 撤销入库：反向流水回滚库存，回退订单已入库量（需求 3.4.4） */
purchaseReceiptRouter.post('/:id/undo', requirePerm('purchase.receipt.undo'), (req, res) => {
  const id = Number(req.params.id);
  const ctx = req.ctx!;

  tx(() => {
    const receipt = db.prepare(`SELECT * FROM purchase_receipts WHERE id = ?`).get(id) as any;
    if (!receipt) throw Err.notFound('入库单不存在');
    if (receipt.status !== DOC_STATUS.VALID) throw Err.conflict('该入库单已撤销');

    const items = db
      .prepare(`SELECT * FROM purchase_receipt_items WHERE receipt_id = ?`)
      .all(id) as any[];

    reverseStock('采购入库', id, ctx.userId);

    if (receipt.order_id) {
      const upd = db.prepare(
        `UPDATE purchase_order_items SET received_qty = MAX(received_qty - ?, 0)
          WHERE order_id = ? AND material_id = ?`,
      );
      for (const it of items) upd.run(it.qty, receipt.order_id, it.material_id);
      const order = db.prepare(`SELECT parent_order_no FROM purchase_orders WHERE id = ?`).get(
        receipt.order_id,
      ) as any;
      refreshOrderStatus(receipt.order_id);
      if (order?.parent_order_no) syncParentStatus(order.parent_order_no);
    }

    db.prepare(`UPDATE purchase_receipts SET status = ? WHERE id = ?`).run(DOC_STATUS.CANCELLED, id);

    writeLog({
      operatorId: ctx.userId,
      action: '撤销采购入库',
      targetType: 'purchase_receipt',
      targetId: id,
      detail: { count: items.length },
    });
  });

  ok(res, { id });
});

export { purchaseContent };
