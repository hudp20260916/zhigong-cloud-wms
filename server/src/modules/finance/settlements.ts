import { Router } from 'express';
import { z } from 'zod';
import { DOC_STATUS } from '../../../../shared/enums.js';
import { db, nowIso, tx } from '../../db/index.js';
import { Err } from '../../core/errors.js';
import { nextCode } from '../../core/code.js';
import { writeLog } from '../../core/log.js';
import { maskList } from '../../core/serializer.js';
import { requirePerm } from '../../middleware/auth.js';
import { canViewPrice } from '../../middleware/context.js';
import { countRows, parsePage } from '../../shared/query.js';
import { ok, okList } from '../../shared/http.js';

export const financeRouter = Router();

/**
 * 结算模型说明（取舍）：
 * 应付余额记在「单据」上（purchase_receipts.settled_amount），而不是给每次核销写对冲记录。
 * 一个入库单可被多张付款单分批核销，累计已核销金额即可表达全部状态，模型最轻。
 * 代价：无法直接查询「某笔付款覆盖了哪些明细行」——但需求只要求单据级核销，够用。
 */

/** 四舍五入到分，避免浮点累计误差 */
function money(n: number): number {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/** 待结算单据：退货单作为负数冲减应付 */
interface PayableDoc {
  docType: 'receipt' | 'return';
  docId: number;
  receiptNo: string | null;
  returnNo: string | null;
  docDate: string;
  docAmount: number;
  settledAmount: number;
  unsettledAmount: number;
}

function payableDocsOf(supplierId: number): PayableDoc[] {
  const receipts = db
    .prepare(
      `SELECT id, receipt_no, receipt_date, total_amount, settled_amount
         FROM purchase_receipts
        WHERE supplier_id = ? AND status = ?`,
    )
    .all(supplierId, DOC_STATUS.VALID) as any[];

  const returns = db
    .prepare(
      `SELECT id, return_no, return_date, total_amount, settled_amount
         FROM purchase_returns
        WHERE supplier_id = ? AND status = ?`,
    )
    .all(supplierId, DOC_STATUS.VALID) as any[];

  const docs: PayableDoc[] = [
    ...receipts.map((r) => ({
      docType: 'receipt' as const,
      docId: Number(r.id),
      receiptNo: r.receipt_no,
      returnNo: null,
      docDate: r.receipt_date,
      docAmount: money(r.total_amount),
      settledAmount: money(r.settled_amount),
      unsettledAmount: money(money(r.total_amount) - money(r.settled_amount)),
    })),
    ...returns.map((r) => ({
      docType: 'return' as const,
      docId: Number(r.id),
      receiptNo: null,
      returnNo: r.return_no,
      docDate: r.return_date,
      // 退货冲减应付：金额为负，待结算为「负的未核销部分」
      docAmount: -money(r.total_amount),
      settledAmount: -money(r.settled_amount),
      unsettledAmount: -money(money(r.total_amount) - money(r.settled_amount)),
    })),
  ];

  // 核销顺序：日期由早到晚（FIFO，符合财务惯例），同日按 id 升序保证稳定
  docs.sort((a, b) => (a.docDate === b.docDate ? a.docId - b.docId : a.docDate < b.docDate ? -1 : 1));
  return docs;
}

/**
 * 自动核销：按 FIFO 把付款金额分配到待结算单据。
 * 退货单（负金额）优先核销 —— 先抵退货再付款，避免多付。
 */
function autoAllocate(docs: PayableDoc[], amount: number) {
  const pending = docs.filter((d) => Math.abs(d.unsettledAmount) > 0.005);
  // 负数（退货）在前：先冲退货，再核销入库
  pending.sort((a, b) => {
    const sa = a.unsettledAmount < 0 ? 0 : 1;
    const sb = b.unsettledAmount < 0 ? 0 : 1;
    if (sa !== sb) return sa - sb;
    return a.docDate === b.docDate ? a.docId - b.docId : a.docDate < b.docDate ? -1 : 1;
  });

  let left = money(amount);
  const out: { doc: PayableDoc; applyAmount: number }[] = [];
  for (const d of pending) {
    if (left <= 0.005) break;
    const take = Math.min(Math.abs(d.unsettledAmount), left);
    // 退货单：applyAmount 记负数，与 docAmount 同号
    const signed = d.unsettledAmount < 0 ? -take : take;
    out.push({ doc: d, applyAmount: money(signed) });
    left = money(left - take);
  }
  return { allocations: out, remain: money(left) };
}

// ---------------------------------------------------------------- 应付汇总

/** 供应商应付汇总：已入库存货金额 - 已付 - 退货冲减 */
financeRouter.get('/payables', requirePerm('finance.settle.view'), (_req, res) => {
  const rows = db
    .prepare(
      `SELECT s.id AS supplier_id, s.code AS supplier_code, s.name AS supplier_name,
              (SELECT IFNULL(SUM(total_amount), 0) FROM purchase_receipts
                WHERE supplier_id = s.id AND status = ?) AS receipt_amount,
              (SELECT IFNULL(SUM(settled_amount), 0) FROM purchase_receipts
                WHERE supplier_id = s.id AND status = ?) AS receipt_settled,
              (SELECT IFNULL(SUM(total_amount), 0) FROM purchase_returns
                WHERE supplier_id = s.id AND status = ?) AS return_amount,
              (SELECT IFNULL(SUM(settled_amount), 0) FROM purchase_returns
                WHERE supplier_id = s.id AND status = ?) AS return_settled,
              (SELECT COUNT(*) FROM purchase_receipts
                WHERE supplier_id = s.id AND status = ?
                  AND total_amount - settled_amount > 0.005) AS pending_count
         FROM suppliers s
        ORDER BY s.name COLLATE NOCASE ASC`,
    )
    .all(DOC_STATUS.VALID, DOC_STATUS.VALID, DOC_STATUS.VALID, DOC_STATUS.VALID, DOC_STATUS.VALID) as any[];

  const ctx = { canViewPrice: canViewPrice(_req.ctx!) };
  // 同时输出驼峰别名，前端页面统一用驼峰，避免每个页面再做一次转换
  const list = maskList(
    rows.map((r) => ({
      ...r,
      supplierId: r.supplier_id,
      supplierCode: r.supplier_code,
      supplierName: r.supplier_name,
      receiptAmount: money(r.receipt_amount),
      returnAmount: money(r.return_amount),
      settledAmount: money(money(r.receipt_settled) + money(r.return_settled)),
      payableAmount: money(
        money(r.receipt_amount) - money(r.receipt_settled) - money(r.return_amount) + money(r.return_settled),
      ),
      pendingCount: Number(r.pending_count ?? 0),
    })),
    ctx,
  );
  ok(res, list);
});

/** 某供应商的待结算单据明细（供付款单勾选 / 自动核销预览） */
financeRouter.get('/payables/:supplierId/docs', requirePerm('finance.settle.view'), (req, res) => {
  const supplierId = Number(req.params.supplierId);
  const supplier = db.prepare(`SELECT * FROM suppliers WHERE id = ?`).get(supplierId) as any;
  if (!supplier) throw Err.notFound('供应商不存在');

  const docs = payableDocsOf(supplierId);
  const ctx = { canViewPrice: canViewPrice(req.ctx!) };
  const list = maskList(
    docs.map((d) => ({
      ...d,
      itemSummary: docSummary(d),
    })),
    ctx,
  );
  ok(res, { supplier: { id: supplier.id, name: supplier.name }, docs: list });
});

/** 单据内容摘要：入库单不显示单号，用「物料摘要」表达（需求 4.5） */
function docSummary(d: PayableDoc): string {
  if (d.docType === 'return') return `采购退货 ${d.returnNo}`;
  const rows = db
    .prepare(
      `SELECT m.name FROM purchase_receipt_items ri JOIN materials m ON m.id = ri.material_id
        WHERE ri.receipt_id = ? ORDER BY ri.id`,
    )
    .all(d.docId) as { name: string }[];
  const names = rows.map((r) => r.name);
  if (names.length === 0) return '采购入库';
  if (names.length <= 2) return names.join('、');
  return `${names[0]}、${names[1]}等${names.length}项`;
}

// ---------------------------------------------------------------- 付款单

const allocSchema = z.object({
  docType: z.enum(['receipt', 'return']),
  docId: z.number().int().positive(),
  applyAmount: z.number(),
});

const createSchema = z.object({
  supplierId: z.number().int().positive('请选择供应商'),
  settleDate: z.string().min(1, '请选择付款日期'),
  method: z.string().trim().min(1).default('转账'),
  amount: z.number().positive('付款金额必须大于 0'),
  mode: z.enum(['auto', 'manual']).default('auto'),
  allocations: z.array(allocSchema).optional().default([]),
  remark: z.string().trim().optional().default(''),
});

financeRouter.get('/settlements', requirePerm('finance.settle.view'), (req, res) => {
  const { page, pageSize, offset, keyword } = parsePage(req);
  const cond: string[] = ['1=1'];
  const params: any[] = [];
  if (keyword) {
    cond.push(`(IFNULL(s.name,'') LIKE ? OR IFNULL(st.settle_no,'') LIKE ?)`);
    params.push(`%${keyword}%`, `%${keyword}%`);
  }

  const rows = db
    .prepare(
      `SELECT st.*, s.name AS supplier_name, u.display_name AS operator_name
         FROM supplier_settlements st
         LEFT JOIN suppliers s ON s.id = st.supplier_id
         LEFT JOIN users u ON u.id = st.operator_id
        WHERE ${cond.join(' AND ')}
        ORDER BY st.id DESC
        LIMIT ? OFFSET ?`,
    )
    .all(...params, pageSize, offset) as any[];

  const total = countRows(
    `supplier_settlements st LEFT JOIN suppliers s ON s.id = st.supplier_id`,
    cond.join(' AND '),
    params,
  );

  const ctx = req.ctx!;
  const canAudit = ctx.permissions.includes('finance.settle.audit');
  const list = maskList(rows, { canViewPrice: canViewPrice(ctx) }).map((r: any) => ({
    ...r,
    canUndo: canAudit && r.status === DOC_STATUS.VALID,
  }));
  okList(res, list, total);
});

financeRouter.get('/settlements/:id', requirePerm('finance.settle.view'), (req, res) => {
  const id = Number(req.params.id);
  const head = db
    .prepare(
      `SELECT st.*, s.name AS supplier_name, u.display_name AS operator_name
         FROM supplier_settlements st
         LEFT JOIN suppliers s ON s.id = st.supplier_id
         LEFT JOIN users u ON u.id = st.operator_id
        WHERE st.id = ?`,
    )
    .get(id) as any;
  if (!head) throw Err.notFound('付款单不存在');

  const items = db
    .prepare(`SELECT * FROM settlement_items WHERE settlement_id = ? ORDER BY id`)
    .all(id) as any[];

  const ctx = { canViewPrice: canViewPrice(req.ctx!) };
  ok(res, {
    settlement: maskList([head], ctx)[0],
    items: maskList(items, ctx),
  });
});

financeRouter.post('/settlements', requirePerm('finance.settle.audit'), (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) throw Err.badRequest(parsed.error.issues[0].message);
  const d = parsed.data;
  const ctx = req.ctx!;

  const id = tx(() => {
    const supplier = db.prepare(`SELECT id FROM suppliers WHERE id = ?`).get(d.supplierId) as any;
    if (!supplier) throw Err.notFound('供应商不存在');

    const docs = payableDocsOf(d.supplierId);
    const byKey = new Map(docs.map((x) => [`${x.docType}-${x.docId}`, x]));

    let allocations: { doc: PayableDoc; applyAmount: number }[] = [];
    if (d.mode === 'auto') {
      allocations = autoAllocate(docs, d.amount).allocations;
    } else {
      for (const a of d.allocations) {
        const doc = byKey.get(`${a.docType}-${a.docId}`);
        if (!doc) throw Err.badRequest('核销单据不存在或不属于该供应商');
        const sign = doc.unsettledAmount < 0 ? -1 : 1;
        const apply = money(Math.abs(a.applyAmount) * sign);
        if (Math.abs(apply) - Math.abs(doc.unsettledAmount) > 0.005) {
          throw Err.badRequest(
            `单据核销金额超出未结算金额（未结算 ${money(doc.unsettledAmount)}）`,
          );
        }
        allocations.push({ doc, applyAmount: apply });
      }
      const sum = money(allocations.reduce((s, a) => s + Math.abs(a.applyAmount), 0));
      if (sum - money(d.amount) > 0.005) {
        throw Err.badRequest(`核销金额合计 ${sum} 超过付款金额 ${money(d.amount)}`);
      }
    }

    if (allocations.length === 0) throw Err.conflict('该供应商没有待结算单据，无需付款');

    const applied = money(allocations.reduce((s, a) => s + Math.abs(a.applyAmount), 0));
    const settleNo = nextCode('settlement', d.settleDate);

    const info = db
      .prepare(
        `INSERT INTO supplier_settlements
           (settle_no, supplier_id, settle_date, method, amount, applied_amount, operator_id, status, remark, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        settleNo,
        d.supplierId,
        d.settleDate,
        d.method,
        money(d.amount),
        applied,
        ctx.userId,
        DOC_STATUS.VALID,
        d.remark,
        nowIso(),
      );
    const settleId = Number(info.lastInsertRowid);

    const insItem = db.prepare(
      `INSERT INTO settlement_items
         (settlement_id, doc_type, doc_id, receipt_no, return_no, doc_date, doc_amount, apply_amount)
       VALUES (?,?,?,?,?,?,?,?)`,
    );

    // 累加已结算金额：入库单与退货单分别回写各自表
    const incReceipt = db.prepare(
      `UPDATE purchase_receipts SET settled_amount = settled_amount + ? WHERE id = ?`,
    );
    const incReturn = db.prepare(
      `UPDATE purchase_returns SET settled_amount = settled_amount + ? WHERE id = ?`,
    );

    for (const a of allocations) {
      const { doc, applyAmount } = a;
      insItem.run(
        settleId,
        doc.docType,
        doc.docId,
        doc.receiptNo,
        doc.returnNo,
        doc.docDate,
        doc.docAmount,
        applyAmount,
      );
      const delta = Math.abs(applyAmount);
      if (doc.docType === 'receipt') incReceipt.run(delta, doc.docId);
      else incReturn.run(delta, doc.docId);
    }

    writeLog({
      operatorId: ctx.userId,
      action: '采购付款结算',
      targetType: 'supplier_settlement',
      targetId: settleId,
      detail: { supplierId: d.supplierId, amount: money(d.amount), applied, mode: d.mode },
    });

    return settleId;
  });

  ok(res, { id });
});

/** 撤销付款单：回滚各单据已结算金额 */
financeRouter.post('/settlements/:id/undo', requirePerm('finance.settle.audit'), (req, res) => {
  const id = Number(req.params.id);
  const ctx = req.ctx!;

  tx(() => {
    const head = db.prepare(`SELECT * FROM supplier_settlements WHERE id = ?`).get(id) as any;
    if (!head) throw Err.notFound('付款单不存在');
    if (head.status !== DOC_STATUS.VALID) throw Err.conflict('该付款单已撤销');

    const items = db
      .prepare(`SELECT * FROM settlement_items WHERE settlement_id = ?`)
      .all(id) as any[];

    const decReceipt = db.prepare(
      `UPDATE purchase_receipts SET settled_amount = MAX(settled_amount - ?, 0) WHERE id = ?`,
    );
    const decReturn = db.prepare(
      `UPDATE purchase_returns SET settled_amount = MAX(settled_amount - ?, 0) WHERE id = ?`,
    );
    for (const it of items) {
      const delta = Math.abs(Number(it.apply_amount));
      if (it.doc_type === 'receipt') decReceipt.run(delta, it.doc_id);
      else decReturn.run(delta, it.doc_id);
    }

    db.prepare(`UPDATE supplier_settlements SET status = ? WHERE id = ?`).run(
      DOC_STATUS.CANCELLED,
      id,
    );

    writeLog({
      operatorId: ctx.userId,
      action: '撤销采购付款结算',
      targetType: 'supplier_settlement',
      targetId: id,
      detail: { amount: head.amount, count: items.length },
    });
  });

  ok(res, { id });
});

/** 核销试算：前端输入金额即时看到覆盖哪些单据（不落库） */
financeRouter.post('/settlements/preview', requirePerm('finance.settle.view'), (req, res) => {
  const schema = z.object({
    supplierId: z.number().int().positive(),
    amount: z.number().min(0),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) throw Err.badRequest(parsed.error.issues[0].message);

  const docs = payableDocsOf(parsed.data.supplierId);
  const { allocations, remain } = autoAllocate(docs, parsed.data.amount);
  const ctx = { canViewPrice: canViewPrice(req.ctx!) };

  ok(res, {
    remain,
    allocations: maskList(
      allocations.map((a) => ({
        docType: a.doc.docType,
        docId: a.doc.docId,
        returnNo: a.doc.returnNo,
        docDate: a.doc.docDate,
        docAmount: a.doc.docAmount,
        unsettledAmount: a.doc.unsettledAmount,
        applyAmount: a.applyAmount,
        itemSummary: docSummary(a.doc),
      })),
      ctx,
    ),
  });
});
