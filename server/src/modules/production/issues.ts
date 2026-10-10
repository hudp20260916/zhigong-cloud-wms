import { Router } from 'express';
import { z } from 'zod';
import { DOC_STATUS } from '../../../../shared/enums.js';
import { db, nowIso, tx } from '../../db/index.js';
import { Err } from '../../core/errors.js';
import { nextCode } from '../../core/code.js';
import { expandBom } from '../../core/bom.js';
import { applyStock, reverseStock } from '../../core/ledger.js';
import { writeLog } from '../../core/log.js';
import { requirePerm } from '../../middleware/auth.js';
import { canViewPrice } from '../../middleware/context.js';
import { maskList } from '../../core/serializer.js';
import { countRows, parsePage } from '../../shared/query.js';
import { ok, okList } from '../../shared/http.js';
import { availableToReceive, cartonQtyOf, refreshWorkOrder } from './helpers.js';

export const issueRouter = Router();

const schema = z.object({
  woId: z.number().int().positive('必须关联生产工单'),
  issueDate: z.string().min(1, '请选择领料日期'),
  produceQty: z.number().positive('生产数量必须大于 0'),
  /** 不传则按 BOM 自动生成扣料明细 */
  items: z
    .array(z.object({ materialId: z.number().int().positive(), qty: z.number().positive() }))
    .optional(),
  remark: z.string().trim().optional().default(''),
});

/** 领料列表：新增「主产品名称」列（需求 3.5.2） */
issueRouter.get('/', requirePerm('production.issue.view'), (req, res) => {
  const { page, pageSize, offset, keyword } = parsePage(req);
  const where = keyword
    ? `(i.issue_no LIKE @kw OR IFNULL(p.name,'') LIKE @kw OR w.wo_no LIKE @kw)`
    : '1=1';
  const params = keyword ? { kw: `%${keyword}%`, limit: pageSize, offset } : { limit: pageSize, offset };

  const rows = db
    .prepare(
      `SELECT i.*, w.wo_no, w.product_id, w.plan_qty, w.received_qty, w.issued_qty,
              p.name AS product_name, p.code AS product_code,
              u.display_name AS operator_name
         FROM material_issues i
         JOIN work_orders w ON w.id = i.wo_id
         LEFT JOIN products p ON p.id = w.product_id
         LEFT JOIN users u ON u.id = i.operator_id
        WHERE ${where}
        ORDER BY i.id DESC
        LIMIT @limit OFFSET @offset`,
    )
    .all(params) as any[];

  const total = countRows(
    `material_issues i
      JOIN work_orders w ON w.id = i.wo_id
      LEFT JOIN products p ON p.id = w.product_id`,
    keyword ? `(i.issue_no LIKE ? OR IFNULL(p.name,'') LIKE ? OR w.wo_no LIKE ?)` : '1=1',
    keyword ? [`%${keyword}%`, `%${keyword}%`, `%${keyword}%`] : [],
  );

  const ctx = req.ctx!;
  const canReceive = ctx.permissions.includes('production.receipt.create');

  // 可入库余量 = 工单累计有效领料 - 工单已入库量；余量 0 时隐藏入口（需求 3.5.2）
  const list = maskList(rows, { canViewPrice: canViewPrice(ctx) }).map((r: any) => {
    const remain = availableToReceive(r.wo_id);
    const qty = Math.min(Number(r.produce_qty), remain);
    return {
      ...r,
      productName: r.product_name ?? '未关联主产品',
      remainQty: remain,
      lockQty: qty,
      canReceive:
        canReceive &&
        r.status === DOC_STATUS.VALID &&
        !!r.product_id &&
        remain > 0 &&
        qty > 0,
      canUndo: ctx.permissions.includes('production.receipt.undo') && r.status === DOC_STATUS.VALID,
    };
  });

  okList(res, list, total);
});

/** 去入库预填：类型锁定「生产入库（已领料）」，数量只读 = min(领料数量, 可入库余量) */
issueRouter.get('/:id/for-receipt', requirePerm('production.receipt.create'), (req, res) => {
  const id = Number(req.params.id);
  const issue = db
    .prepare(
      `SELECT i.*, w.id AS wo_id, w.wo_no, w.product_id, w.plan_qty, w.received_qty, w.issued_qty,
              p.name AS product_name, p.code AS product_code, p.unit
         FROM material_issues i
         JOIN work_orders w ON w.id = i.wo_id
         JOIN products p ON p.id = w.product_id
        WHERE i.id = ?`,
    )
    .get(id) as any;
  if (!issue) throw Err.notFound('领料单不存在');
  if (issue.status !== DOC_STATUS.VALID) throw Err.conflict('该领料单已撤销');

  const remain = availableToReceive(issue.wo_id);
  if (remain <= 0) {
    throw Err.conflict('该工单可入库余量为 0，请先继续领料');
  }
  ok(res, {
    issue,
    workOrderId: issue.wo_id,
    productId: issue.product_id,
    lockQty: Math.min(Number(issue.produce_qty), remain),
    receiptType: '生产入库（已领料）',
  });
});

issueRouter.get('/:id', requirePerm('production.issue.view'), (req, res) => {
  const id = Number(req.params.id);
  const issue = db.prepare(`SELECT * FROM material_issues WHERE id = ?`).get(id) as any;
  if (!issue) throw Err.notFound('领料单不存在');
  const items = db
    .prepare(
      `SELECT ii.*, m.code, m.name, m.spec, m.unit
         FROM material_issue_items ii JOIN materials m ON m.id = ii.material_id
        WHERE ii.issue_id = ?`,
    )
    .all(id) as any[];
  const ctx = { canViewPrice: canViewPrice(req.ctx!) };
  ok(res, { issue, items: maskList(items, ctx) });
});

/** 按 BOM 生成领料单：虚拟件穿透为实阶物料（需求 3.5.2） */
issueRouter.post('/', requirePerm('production.issue.create'), (req, res) => {
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) throw Err.badRequest(parsed.error.issues[0].message);
  const d = parsed.data;

  const id = tx(() => {
    const wo = db.prepare(`SELECT * FROM work_orders WHERE id = ?`).get(d.woId) as any;
    if (!wo) throw Err.notFound('生产工单不存在');
    const product = db.prepare(`SELECT * FROM products WHERE id = ?`).get(wo.product_id) as any;
    if (!product) throw Err.notFound('工单关联的主产品不存在');

    // 未显式指定明细时按 BOM 展开（含虚拟件穿透）并追加外箱
    const requirement = new Map<number, number>();
    if (d.items && d.items.length > 0) {
      for (const it of d.items) requirement.set(it.materialId, (requirement.get(it.materialId) ?? 0) + it.qty);
    } else {
      for (const [mid, qty] of expandBom(wo.product_id, d.produceQty)) {
        requirement.set(mid, (requirement.get(mid) ?? 0) + qty);
      }
    }
    const cartonQty = cartonQtyOf(product, d.produceQty);
    if (cartonQty > 0 && product.carton_material_id) {
      requirement.set(
        product.carton_material_id,
        (requirement.get(product.carton_material_id) ?? 0) + cartonQty,
      );
    }

    if (requirement.size === 0) {
      throw Err.conflict('该成品未配置 BOM，无法按 BOM 生成领料，请手工录入明细');
    }

    const issueNo = nextCode('issue', d.issueDate);
    const info = db
      .prepare(
        `INSERT INTO material_issues (issue_no, wo_id, issue_date, produce_qty, status, operator_id, remark, created_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(issueNo, d.woId, d.issueDate, d.produceQty, DOC_STATUS.VALID, req.ctx!.userId, d.remark, nowIso());
    const issueId = Number(info.lastInsertRowid);

    const ins = db.prepare(
      `INSERT INTO material_issue_items (issue_id, material_id, qty, unit_price) VALUES (?,?,?,?)`,
    );
    const entries = [];
    for (const [materialId, qty] of requirement) {
      const m = db.prepare(`SELECT avg_cost FROM materials WHERE id = ?`).get(materialId) as any;
      ins.run(issueId, materialId, qty, m?.avg_cost ?? 0);
      entries.push({
        itemType: 'material' as const,
        itemId: materialId,
        direction: 'out' as const,
        qty,
        bizType: '生产领料',
        bizId: issueId,
        bizNo: issueNo,
        unitPrice: m?.avg_cost ?? 0,
        operatorId: req.ctx!.userId,
      });
    }
    applyStock(entries);

    refreshWorkOrder(d.woId);
    writeLog({
      operatorId: req.ctx!.userId,
      action: '生产领料',
      targetType: 'material_issue',
      targetId: issueId,
      detail: { issueNo, produceQty: d.produceQty, kinds: requirement.size },
    });
    return issueId;
  });

  ok(res, { id });
});

issueRouter.post('/:id/undo', requirePerm('production.receipt.undo'), (req, res) => {
  const id = Number(req.params.id);
  tx(() => {
    const issue = db.prepare(`SELECT * FROM material_issues WHERE id = ?`).get(id) as any;
    if (!issue) throw Err.notFound('领料单不存在');
    if (issue.status !== DOC_STATUS.VALID) throw Err.conflict('该领料单已撤销');

    // 已依据本单入库的成品数量需先撤销，避免领料回滚后出现负余量
    const remain = availableToReceive(issue.wo_id);
    if (remain < Number(issue.produce_qty)) {
      throw Err.conflict('该领料单已有成品入库，请先撤销对应的成品入库单');
    }

    reverseStock('生产领料', id, req.ctx!.userId);
    db.prepare(`UPDATE material_issues SET status = ? WHERE id = ?`).run(DOC_STATUS.CANCELLED, id);
    refreshWorkOrder(issue.wo_id);
    writeLog({
      operatorId: req.ctx!.userId,
      action: '撤销生产领料',
      targetType: 'material_issue',
      targetId: id,
    });
  });
  ok(res, { id });
});
