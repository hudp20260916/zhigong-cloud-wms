import { Router } from 'express';
import { z } from 'zod';
import { DOC_STATUS } from '../../../../shared/enums.js';
import { db, nowIso, tx } from '../../db/index.js';
import { BizError, Err } from '../../core/errors.js';
import { nextCode } from '../../core/code.js';
import { applyStock, reverseStock, type LedgerEntry } from '../../core/ledger.js';
import { writeLog } from '../../core/log.js';
import { maskList } from '../../core/serializer.js';
import { requirePerm } from '../../middleware/auth.js';
import { canViewPrice } from '../../middleware/context.js';
import { countRows, parsePage } from '../../shared/query.js';
import { ok, okList } from '../../shared/http.js';
import {
  availableToReceive,
  cartonQtyOf,
  checkProductMaterials,
  refreshWorkOrder,
  type ProductShortage,
} from './helpers.js';

export const productReceiptRouter = Router();

/** 已领料工单入库时是否扣减外箱耗材（需求「按配置」——此处为系统配置项，默认开启） */
const DEDUCT_CARTON_ON_ISSUED = true;

const RECEIPT_TYPES = ['生产入库（已领料）', '售后返修入库', '成品入库（直接扣料）'] as const;

const schema = z.object({
  receiptType: z.enum(RECEIPT_TYPES),
  woId: z.number().int().nullable().optional(),
  issueId: z.number().int().nullable().optional(),
  receiptDate: z.string().min(1, '请选择入库日期'),
  items: z.array(z.object({ productId: z.number().int().positive(), qty: z.number().positive('入库数量必须大于 0') })),
  /** 多品入库局部缺料时，前端确认跳过这些成品（需求 4.7） */
  skipProductIds: z.array(z.number().int()).optional().default([]),
  remark: z.string().trim().optional().default(''),
});

productReceiptRouter.get('/', requirePerm('production.receipt.view'), (req, res) => {
  const { page, pageSize, offset, keyword } = parsePage(req);
  const where = keyword
    ? `(IFNULL(w.wo_no,'') LIKE @kw OR EXISTS (SELECT 1 FROM product_receipt_items ri JOIN products p2 ON p2.id = ri.product_id WHERE ri.receipt_id = r.id AND p2.name LIKE @kw))`
    : '1=1';
  const params = keyword ? { kw: `%${keyword}%`, limit: pageSize, offset } : { limit: pageSize, offset };

  const rows = db
    .prepare(
      `SELECT r.id, r.wo_id, r.issue_id, r.receipt_date, r.receipt_type, r.status, r.remark, r.created_at,
              w.wo_no, i.issue_no, u.display_name AS operator_name,
              (SELECT IFNULL(GROUP_CONCAT(p2.name || '×' || ri.qty, '、'), '')
                 FROM product_receipt_items ri JOIN products p2 ON p2.id = ri.product_id
                WHERE ri.receipt_id = r.id) AS content,
              (SELECT IFNULL(SUM(ri.qty), 0) FROM product_receipt_items ri WHERE ri.receipt_id = r.id) AS total_qty
         FROM product_receipts r
         LEFT JOIN work_orders w ON w.id = r.wo_id
         LEFT JOIN material_issues i ON i.id = r.issue_id
         LEFT JOIN users u ON u.id = r.operator_id
        WHERE ${where}
        ORDER BY r.id DESC
        LIMIT @limit OFFSET @offset`,
    )
    .all(params) as any[];

  const total = countRows(
    `product_receipts r
      LEFT JOIN work_orders w ON w.id = r.wo_id`,
    keyword
      ? `(IFNULL(w.wo_no,'') LIKE ? OR EXISTS (SELECT 1 FROM product_receipt_items ri JOIN products p2 ON p2.id = ri.product_id WHERE ri.receipt_id = r.id AND p2.name LIKE ?))`
      : '1=1',
    keyword ? [`%${keyword}%`, `%${keyword}%`] : [],
  );

  const ctx = req.ctx!;
  const list = maskList(rows, { canViewPrice: canViewPrice(ctx) }).map((r: any) => ({
    ...r,
    canUndo: ctx.permissions.includes('production.receipt.undo') && r.status === DOC_STATUS.VALID,
  }));
  okList(res, list, total);
});

productReceiptRouter.get('/:id', requirePerm('production.receipt.view'), (req, res) => {
  const id = Number(req.params.id);
  const receipt = db.prepare(`SELECT * FROM product_receipts WHERE id = ?`).get(id) as any;
  if (!receipt) throw Err.notFound('成品入库单不存在');
  const items = db
    .prepare(
      `SELECT ri.*, p.code, p.name, p.spec, p.unit
         FROM product_receipt_items ri JOIN products p ON p.id = ri.product_id
        WHERE ri.receipt_id = ?`,
    )
    .all(id);
  ok(res, { receipt, items });
});

/**
 * 成品入库（三种类型）。
 * 关键校验：
 *  - 已领料类型：数量必须等于 min(领料数量, 可入库余量)，且累计入库不得超过累计领料（防超产，服务端强制）
 *  - 直接扣料类型：按成品独立校验 BOM 物料，缺料成品可单独跳过
 */
productReceiptRouter.post('/', requirePerm('production.receipt.create'), (req, res) => {
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) throw Err.badRequest(parsed.error.issues[0].message);
  const d = parsed.data;
  const ctx = req.ctx!;

  if (d.items.length === 0) throw Err.badRequest('请至少录入一条入库明细');

  const result = tx(() => {
    const receiptNo = nextCode('productReceipt', d.receiptDate);
    let woId: number | null = d.woId ?? null;
    let issueId: number | null = d.issueId ?? null;

    // ---------- 类型一：生产入库（已领料） ----------
    if (d.receiptType === '生产入库（已领料）') {
      if (!issueId || !woId) throw Err.badRequest('生产入库（已领料）必须关联领料单与工单');

      const issue = db.prepare(`SELECT * FROM material_issues WHERE id = ?`).get(issueId) as any;
      if (!issue) throw Err.notFound('领料单不存在');
      if (issue.status !== DOC_STATUS.VALID) throw Err.conflict('该领料单已撤销');

      const wo = db.prepare(`SELECT * FROM work_orders WHERE id = ?`).get(woId) as any;
      if (!wo) throw Err.notFound('生产工单不存在');

      const remain = availableToReceive(woId);
      const lockQty = Math.min(Number(issue.produce_qty), remain);
      if (lockQty <= 0) throw Err.conflict('可入库余量为 0，请先继续领料');

      const total = d.items.reduce((s, i) => s + i.qty, 0);
      // 服务端强制锁定：数量必须与可入库余量一致，防止前端篡改或刷库存
      if (Math.abs(total - lockQty) > 1e-6 || d.items.length !== 1) {
        throw Err.conflict(
          `已领料工单入库数量被锁定为 ${lockQty}（领料数量与可入库余量取小值），不可修改`,
          { lockQty },
        );
      }
      // 防超产：累计入库不得超过累计有效领料量
      if (Number(wo.received_qty) + total > Number(wo.issued_qty) + 1e-6) {
        throw Err.conflict('累计入库量超过累计领料量，禁止超产入库', {
          issuedQty: Number(wo.issued_qty),
          receivedQty: Number(wo.received_qty),
          attempt: total,
        });
      }

      const product = db.prepare(`SELECT * FROM products WHERE id = ?`).get(d.items[0].productId) as any;
      if (!product) throw Err.notFound('成品档案不存在');

      const info = db
        .prepare(
          `INSERT INTO product_receipts (receipt_no, wo_id, issue_id, receipt_date, receipt_type, status, operator_id, remark, created_at)
           VALUES (?,?,?,?,?,?,?,?,?)`,
        )
        .run(receiptNo, woId, issueId, d.receiptDate, d.receiptType, DOC_STATUS.VALID, ctx.userId, d.remark, nowIso());
      const receiptId = Number(info.lastInsertRowid);
      db.prepare(`INSERT INTO product_receipt_items (receipt_id, product_id, qty) VALUES (?,?,?)`).run(
        receiptId,
        d.items[0].productId,
        total,
      );

      const entries: LedgerEntry[] = [
        {
          itemType: 'product' as const,
          itemId: d.items[0].productId,
          direction: 'in' as const,
          qty: total,
          bizType: '成品入库',
          bizId: receiptId,
          bizNo: undefined,
          operatorId: ctx.userId,
        },
      ];

      // 已领料类型不扣子物料（物料已在领料时扣减），按配置扣外箱
      if (DEDUCT_CARTON_ON_ISSUED) {
        const cartonQty = cartonQtyOf(product, total);
        if (cartonQty > 0 && product.carton_material_id) {
          entries.push({
            itemType: 'material' as const,
            itemId: product.carton_material_id,
            direction: 'out' as const,
            qty: cartonQty,
            bizType: '成品入库',
            bizId: receiptId,
            bizNo: undefined,
            operatorId: ctx.userId,
          });
        }
      }
      applyStock(entries);

      refreshWorkOrder(woId);
      writeLog({
        operatorId: ctx.userId,
        action: '成品入库（已领料）',
        targetType: 'product_receipt',
        targetId: receiptId,
        detail: { woNo: wo.wo_no, qty: total },
      });
      return { id: receiptId };
    }

    // ---------- 类型二：售后返修入库 ----------
    if (d.receiptType === '售后返修入库') {
      const info = db
        .prepare(
          `INSERT INTO product_receipts (receipt_no, wo_id, issue_id, receipt_date, receipt_type, status, operator_id, remark, created_at)
           VALUES (?,?,?,?,?,?,?,?,?)`,
        )
        .run(receiptNo, woId, null, d.receiptDate, d.receiptType, DOC_STATUS.VALID, ctx.userId, d.remark, nowIso());
      const receiptId = Number(info.lastInsertRowid);
      const ins = db.prepare(`INSERT INTO product_receipt_items (receipt_id, product_id, qty) VALUES (?,?,?)`);

      // 相同成品自动合并
      const merged = mergeItems(d.items);
      for (const [productId, qty] of merged) ins.run(receiptId, productId, qty);
      applyStock(
        [...merged].map(([productId, qty]) => ({
          itemType: 'product' as const,
          itemId: productId,
          direction: 'in' as const,
          qty,
          bizType: '成品入库',
          bizId: receiptId,
          bizNo: undefined,
          operatorId: ctx.userId,
        })),
      );
      writeLog({
        operatorId: ctx.userId,
        action: '成品入库（售后返修）',
        targetType: 'product_receipt',
        targetId: receiptId,
      });
      return { id: receiptId };
    }

    // ---------- 类型三：成品入库（直接扣料，支持多品） ----------
    const merged = mergeItems(d.items);
    const skip = new Set(d.skipProductIds ?? []);

    const shortages: ProductShortage[] = [];
    const plans: { productId: number; qty: number; requirements: Map<number, number> }[] = [];

    for (const [productId, qty] of merged) {
      const product = db.prepare(`SELECT * FROM products WHERE id = ?`).get(productId) as any;
      if (!product) throw Err.notFound(`成品 #${productId} 档案不存在`);
      const cartonQty = cartonQtyOf(product, qty);
      const result = checkProductMaterials(productId, qty, cartonQty);
      if (!result.ok) {
        if (!skip.has(productId)) shortages.push(result.shortage);
        continue;
      }
      plans.push({ productId, qty, requirements: result.requirements });
    }

    // 局部缺料：明确提示短缺成品，允许用户剔除后继续（需求 4.7）
    if (shortages.length > 0) {
      throw new BizError(409, 'SHORTAGE_PARTIAL', '部分成品子物料不足，请确认是否剔除缺料成品后继续入库', {
        shortages,
      });
    }
    if (plans.length === 0) throw Err.badRequest('没有可入库的成品，请检查明细或物料库存');

    const info = db
      .prepare(
        `INSERT INTO product_receipts (receipt_no, wo_id, issue_id, receipt_date, receipt_type, status, operator_id, remark, created_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(receiptNo, woId, null, d.receiptDate, d.receiptType, DOC_STATUS.VALID, ctx.userId, d.remark, nowIso());
    const receiptId = Number(info.lastInsertRowid);
    const ins = db.prepare(`INSERT INTO product_receipt_items (receipt_id, product_id, qty) VALUES (?,?,?)`);

    const materialOut = new Map<number, number>();
    for (const plan of plans) {
      ins.run(receiptId, plan.productId, plan.qty);
      for (const [mid, qty] of plan.requirements) {
        materialOut.set(mid, (materialOut.get(mid) ?? 0) + qty);
      }
    }

    const entries: Parameters<typeof applyStock>[0] = [...materialOut].map(([materialId, qty]) => ({
      itemType: 'material' as const,
      itemId: materialId,
      direction: 'out' as const,
      qty,
      bizType: '成品入库',
      bizId: receiptId,
      bizNo: undefined,
      operatorId: ctx.userId,
    }));
    for (const plan of plans) {
      entries.push({
        itemType: 'product' as const,
        itemId: plan.productId,
        direction: 'in' as const,
        qty: plan.qty,
        bizType: '成品入库',
        bizId: receiptId,
        bizNo: undefined,
        operatorId: ctx.userId,
      });
    }
    applyStock(entries);

    if (woId) refreshWorkOrder(woId);
    writeLog({
      operatorId: ctx.userId,
      action: '成品入库（直接扣料）',
      targetType: 'product_receipt',
      targetId: receiptId,
      detail: { products: plans.length, skipped: d.skipProductIds?.length ?? 0 },
    });
    return { id: receiptId };
  });

  ok(res, result);
});

productReceiptRouter.post('/:id/undo', requirePerm('production.receipt.undo'), (req, res) => {
  const id = Number(req.params.id);
  tx(() => {
    const receipt = db.prepare(`SELECT * FROM product_receipts WHERE id = ?`).get(id) as any;
    if (!receipt) throw Err.notFound('成品入库单不存在');
    if (receipt.status !== DOC_STATUS.VALID) throw Err.conflict('该入库单已撤销');

    reverseStock('成品入库', id, req.ctx!.userId);
    db.prepare(`UPDATE product_receipts SET status = ? WHERE id = ?`).run(DOC_STATUS.CANCELLED, id);
    if (receipt.wo_id) refreshWorkOrder(receipt.wo_id);
    writeLog({
      operatorId: req.ctx!.userId,
      action: '撤销成品入库',
      targetType: 'product_receipt',
      targetId: id,
    });
  });
  ok(res, { id });
});

function mergeItems(items: { productId: number; qty: number }[]): Map<number, number> {
  const m = new Map<number, number>();
  for (const it of items) m.set(it.productId, (m.get(it.productId) ?? 0) + it.qty);
  return m;
}
