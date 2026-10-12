import { Router } from 'express';
import { z } from 'zod';
import { DOC_STATUS } from '../../../../shared/enums.js';
import { db, nowIso, tx } from '../../db/index.js';
import { Err } from '../../core/errors.js';
import { nextCode } from '../../core/code.js';
import { applyStock, reverseStock, type LedgerEntry } from '../../core/ledger.js';
import { writeLog } from '../../core/log.js';
import { requirePerm } from '../../middleware/auth.js';
import { canViewPrice } from '../../middleware/context.js';
import { maskList } from '../../core/serializer.js';
import { countRows, parsePage } from '../../shared/query.js';
import { ok, okList } from '../../shared/http.js';
import { issuedQtyOf, refreshWorkOrder, returnedQtyOf, round } from './helpers.js';

export const materialReturnRouter = Router();

/**
 * 生产退料（2026-10-12）
 *
 * 场景：工单计划 100、按 100 领料、实产 98 台后停工转产，剩余未使用的物料按
 * 「原领料单、原量」退回物料库存。
 *
 * 三条不变量：
 *  1. 退料必须挂在「原领料单」上（issue_id + src_item_id），实现原路回溯；
 *  2. 退料写入的是物料「入库」流水（biz_type='生产退料'），方向与领料相反，撤销走 reverseStock；
 *  3. 退料产量从工单 issued_qty 中核减（refreshWorkOrder 已含此口径），
 *     于是「可入库余量 = 领料 - 退料 - 已入库」自动收敛，入库锁量逻辑无需改动。
 */

const itemSchema = z.object({
  materialId: z.number().int().positive(),
  /** 源领料明细 id，原路退回的依据 */
  srcItemId: z.number().int().positive().optional().nullable(),
  qty: z.number().positive('退料数量必须大于 0'),
  remark: z.string().trim().optional().default(''),
});

const schema = z.object({
  issueId: z.number().int().positive('必须选择原领料单'),
  returnDate: z.string().min(1, '请选择退料日期'),
  /** 本次退回对应的成品数量，用于核减领料产量（= 领料数量 - 实际投产数量） */
  returnQty: z.number().positive('退回成品数量必须大于 0'),
  items: z.array(itemSchema).min(1, '请至少录入一条退料明细'),
  remark: z.string().trim().optional().default(''),
});

/** 某领料单的可退明细：领料量 - 已退量，按物料聚合，带出货架（原路）信息 */
function returnableOf(issueId: number) {
  const rows = db
    .prepare(
      `SELECT ii.id AS src_item_id, ii.material_id, ii.qty AS issued_qty,
              ii.unit_price, m.code, m.name, m.spec, m.unit,
              IFNULL((SELECT SUM(ri.qty) FROM material_return_items ri
                        JOIN material_returns r ON r.id = ri.return_id
                       WHERE ri.src_item_id = ii.id AND r.status = '有效'), 0) AS returned_qty
         FROM material_issue_items ii
         JOIN materials m ON m.id = ii.material_id
        WHERE ii.issue_id = ?
        ORDER BY ii.id`,
    )
    .all(issueId) as any[];

  return rows.map((r) => ({
    ...r,
    remainQty: round(Number(r.issued_qty) - Number(r.returned_qty)),
  }));
}

materialReturnRouter.get('/', requirePerm('production.issue.view'), (req, res) => {
  const { page, pageSize, offset, keyword } = parsePage(req);
  const dateFrom = String(req.query.dateFrom ?? '').trim();
  const dateTo = String(req.query.dateTo ?? '').trim();
  const materialKeyword = String(req.query.materialKeyword ?? '').trim();

  const bind: any = { limit: pageSize, offset };
  if (keyword) bind.kw = `%${keyword}%`;
  if (dateFrom) bind.df = dateFrom;
  if (dateTo) bind.dt = dateTo;
  if (materialKeyword) bind.mkw = `%${materialKeyword}%`;

  const cond: string[] = ['1=1'];
  if (keyword) cond.push(`(mr.return_no LIKE @kw OR i.issue_no LIKE @kw OR w.wo_no LIKE @kw)`);
  if (dateFrom) cond.push('mr.return_date >= @df');
  if (dateTo) cond.push('mr.return_date <= @dt');
  if (materialKeyword) {
    cond.push(
      `EXISTS (SELECT 1 FROM material_return_items ri JOIN materials m ON m.id = ri.material_id
                WHERE ri.return_id = mr.id AND (m.name LIKE @mkw OR m.code LIKE @mkw))`,
    );
  }
  const where = cond.join(' AND ');

  const rows = db
    .prepare(
      `SELECT mr.*, w.wo_no, w.product_id, w.plan_qty, i.issue_no,
              p.name AS product_name, p.code AS product_code,
              u.display_name AS operator_name,
              (SELECT IFNULL(GROUP_CONCAT(m.name || '×' || ri.qty, '、'), '')
                 FROM material_return_items ri JOIN materials m ON m.id = ri.material_id
                WHERE ri.return_id = mr.id) AS content
         FROM material_returns mr
         JOIN work_orders w ON w.id = mr.wo_id
         JOIN material_issues i ON i.id = mr.issue_id
         LEFT JOIN products p ON p.id = w.product_id
         LEFT JOIN users u ON u.id = mr.operator_id
        WHERE ${where}
        ORDER BY mr.id DESC
        LIMIT @limit OFFSET @offset`,
    )
    .all(bind) as any[];

  const totalParams: any[] = [];
  const totalCond = cond.map((c) =>
    c.replace(/@(\w+)/g, (_m, name: string) => {
      totalParams.push(bind[name]);
      return '?';
    }),
  );
  const total = countRows(
    `material_returns mr
      JOIN work_orders w ON w.id = mr.wo_id
      JOIN material_issues i ON i.id = mr.issue_id`,
    totalCond.join(' AND '),
    totalParams,
  );

  const ctx = req.ctx!;
  const list = maskList(rows, { canViewPrice: canViewPrice(ctx) }).map((r: any) => ({
    ...r,
    productName: r.product_name ?? '未关联主产品',
    canUndo: ctx.permissions.includes('production.issue.create') && r.status === DOC_STATUS.VALID,
  }));

  okList(res, list, total);
});

/** 某领料单的可退明细（前端选完领料单后自动带出，原路原量） */
materialReturnRouter.get('/returnable/:issueId', requirePerm('production.issue.view'), (req, res) => {
  const issueId = Number(req.params.issueId);
  const issue = db
    .prepare(
      `SELECT i.*, w.wo_no, w.product_id, w.plan_qty, w.issued_qty, w.received_qty,
              p.name AS product_name, p.code AS product_code, p.unit, p.carton_material_id,
              p.packing_spec
         FROM material_issues i
         JOIN work_orders w ON w.id = i.wo_id
         JOIN products p ON p.id = w.product_id
        WHERE i.id = ?`,
    )
    .get(issueId) as any;
  if (!issue) throw Err.notFound('领料单不存在');
  if (issue.status !== DOC_STATUS.VALID) throw Err.conflict('该领料单已撤销，无需退料');

  const items = returnableOf(issueId).filter((r) => r.remainQty > 0);

  // 可退的成品数量 = 领料产量 - 已退 - 已入库（已投产部分不能退）
  const alreadyReturned = returnedQtyOf(issue.wo_id);
  const issuedThis = Number(issue.produce_qty);
  const received = Number(issue.received_qty);
  const grossIssued = issuedQtyOf(issue.wo_id);
  // 该工单「尚未投产的领料量」= 累计领料 - 累计退料 - 累计入库
  const maxReturnable = Math.max(0, round(grossIssued - alreadyReturned - received));

  ok(res, {
    issue,
    items,
    /** 本次最多可退回的成品数量（未投产部分） */
    maxReturnable,
    /** 本单领料数量，用于前端提示 */
    produceQty: issuedThis,
    receivedQty: received,
  });
});

materialReturnRouter.get('/:id', requirePerm('production.issue.view'), (req, res) => {
  const id = Number(req.params.id);
  const ret = db.prepare(`SELECT * FROM material_returns WHERE id = ?`).get(id) as any;
  if (!ret) throw Err.notFound('退料单不存在');
  const items = db
    .prepare(
      `SELECT ri.*, m.code, m.name, m.spec, m.unit
         FROM material_return_items ri JOIN materials m ON m.id = ri.material_id
        WHERE ri.return_id = ?`,
    )
    .all(id) as any[];
  const ctx = { canViewPrice: canViewPrice(req.ctx!) };
  ok(res, { return: maskList([ret], ctx)[0], items: maskList(items, ctx) });
});

/** 建退料单：按原领料单原量退回，回补物料库存并核减工单已领产量 */
materialReturnRouter.post('/', requirePerm('production.issue.create'), (req, res) => {
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) throw Err.badRequest(parsed.error.issues[0].message);
  const d = parsed.data;
  const ctx = req.ctx!;

  const id = tx(() => {
    const issue = db.prepare(`SELECT * FROM material_issues WHERE id = ?`).get(d.issueId) as any;
    if (!issue) throw Err.notFound('原领料单不存在');
    if (issue.status !== DOC_STATUS.VALID) throw Err.conflict('该领料单已撤销，无法退料');

    const wo = db.prepare(`SELECT * FROM work_orders WHERE id = ?`).get(issue.wo_id) as any;
    if (!wo) throw Err.notFound('工单不存在');

    // ---- 一致性校验 1：退回的成品数量不得超过「未投产部分」 ----
    const grossIssued = issuedQtyOf(issue.wo_id);
    const alreadyReturned = returnedQtyOf(issue.wo_id);
    const received = Number(wo.received_qty);
    const maxReturnable = round(grossIssued - alreadyReturned - received);
    if (d.returnQty > maxReturnable + 1e-6) {
      throw Err.conflict(
        `退回数量超过可退上限 ${maxReturnable}（= 累计领料 ${grossIssued} - 已退 ${alreadyReturned} - 已入库 ${received}），已投产部分不可退`,
        { maxReturnable, grossIssued, alreadyReturned, received },
      );
    }

    // ---- 一致性校验 2：每条明细不得超过该物料的剩余可退量（原路原量） ----
    const returnable = new Map(returnableOf(issue.id).map((r) => [r.src_item_id, r]));
    // 同一次提交内按 srcItemId 合并，避免重复行绕过校验
    const merged = new Map<number, { materialId: number; qty: number; unitPrice: number }>();
    for (const it of d.items) {
      const key = it.srcItemId ?? it.materialId;
      const base = merged.get(key);

      let unitPrice = 0;
      if (it.srcItemId) {
        const src = returnable.get(it.srcItemId);
        if (!src) throw Err.conflict(`源领料明细 #${it.srcItemId} 不存在或不属于该领料单`);
        if (src.material_id !== it.materialId) {
          throw Err.conflict(`物料与源领料明细不匹配（明细 #${it.srcItemId}）`);
        }
        unitPrice = Number(src.unit_price ?? 0);
      } else {
        const m = db.prepare(`SELECT avg_cost FROM materials WHERE id = ?`).get(it.materialId) as any;
        unitPrice = Number(m?.avg_cost ?? 0);
      }

      merged.set(key, {
        materialId: it.materialId,
        qty: (base?.qty ?? 0) + it.qty,
        unitPrice,
      });
    }

    for (const [key, line] of merged) {
      const src = returnable.get(key);
      if (src && line.qty > Number(src.remainQty) + 1e-6) {
        throw Err.conflict(
          `物料「${src.name}」退料量 ${line.qty} 超过可退量 ${src.remainQty}（原领 ${src.issued_qty}，已退 ${src.returned_qty}）`,
          { materialId: line.materialId, remainQty: src.remainQty },
        );
      }
      if (!src && !returnable.size) {
        throw Err.conflict('该领料单没有可退物料');
      }
    }

    const returnNo = nextCode('materialReturn', d.returnDate);
    const info = db
      .prepare(
        `INSERT INTO material_returns (return_no, wo_id, issue_id, return_date, return_qty, status, operator_id, remark, created_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(returnNo, issue.wo_id, issue.id, d.returnDate, d.returnQty, DOC_STATUS.VALID, ctx.userId, d.remark, nowIso());
    const returnId = Number(info.lastInsertRowid);

    const ins = db.prepare(
      `INSERT INTO material_return_items (return_id, material_id, src_item_id, qty, unit_price, remark)
       VALUES (?,?,?,?,?,?)`,
    );
    const entries: LedgerEntry[] = [];
    for (const it of d.items) {
      const src = it.srcItemId ? returnable.get(it.srcItemId) : undefined;
      const unitPrice = src ? Number(src.unit_price ?? 0) : merged.get(it.srcItemId ?? it.materialId)!.unitPrice;
      ins.run(returnId, it.materialId, it.srcItemId ?? null, it.qty, unitPrice, it.remark ?? '');
      entries.push({
        itemType: 'material' as const,
        itemId: it.materialId,
        direction: 'in' as const, // 退料 = 物料回补入库
        qty: it.qty,
        bizType: '生产退料',
        bizId: returnId,
        bizNo: returnNo,
        unitPrice,
        operatorId: ctx.userId,
      });
    }
    applyStock(entries);

    refreshWorkOrder(issue.wo_id);
    writeLog({
      operatorId: ctx.userId,
      action: '生产退料',
      targetType: 'material_return',
      targetId: returnId,
      detail: { returnNo, issueNo: issue.issue_no, returnQty: d.returnQty, kinds: entries.length },
    });
    return returnId;
  });

  ok(res, { id });
});

/** 撤销退料：反向对冲（把退回的料再扣回去），工单已领产量随之恢复 */
materialReturnRouter.post('/:id/undo', requirePerm('production.issue.create'), (req, res) => {
  const id = Number(req.params.id);
  tx(() => {
    const ret = db.prepare(`SELECT * FROM material_returns WHERE id = ?`).get(id) as any;
    if (!ret) throw Err.notFound('退料单不存在');
    if (ret.status !== DOC_STATUS.VALID) throw Err.conflict('该退料单已撤销');

    // 若退料后物料已被消耗（现有库存不足以扣回），reverseStock 会拒绝负库存并抛出明确错误
    reverseStock('生产退料', id, req.ctx!.userId);
    db.prepare(`UPDATE material_returns SET status = ? WHERE id = ?`).run(DOC_STATUS.CANCELLED, id);
    refreshWorkOrder(ret.wo_id);
    writeLog({
      operatorId: req.ctx!.userId,
      action: '撤销生产退料',
      targetType: 'material_return',
      targetId: id,
    });
  });
  ok(res, { id });
});
