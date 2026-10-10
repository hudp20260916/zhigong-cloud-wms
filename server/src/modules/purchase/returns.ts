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

export const purchaseReturnRouter = Router();

const itemSchema = z.object({
  materialId: z.number().int().positive(),
  qty: z.number().positive('退货数量必须大于 0'),
  price: z.number().min(0).default(0),
});

const createSchema = z.object({
  receiptId: z.number().int().nullable().optional(),
  supplierId: z.number().int().nullable().optional(),
  returnDate: z.string().min(1, '请选择退货日期'),
  items: z.array(itemSchema).min(1, '请至少录入一条退货明细'),
  remark: z.string().trim().optional().default(''),
});

purchaseReturnRouter.get('/', requirePerm('purchase.return.view'), (req, res) => {
  const { page, pageSize, offset, keyword } = parsePage(req);
  const cond: string[] = ['1=1'];
  const params: any[] = [];
  if (keyword) {
    cond.push(`(IFNULL(s.name,'') LIKE ? OR r.return_no LIKE ?)`);
    params.push(`%${keyword}%`, `%${keyword}%`);
  }

  const rows = db
    .prepare(
      `SELECT r.*, s.name AS supplier_name, u.display_name AS operator_name,
              (SELECT IFNULL(GROUP_CONCAT(m.name, '、'), '')
                 FROM purchase_return_items ri JOIN materials m ON m.id = ri.material_id
                WHERE ri.return_id = r.id) AS material_names
         FROM purchase_returns r
         LEFT JOIN suppliers s ON s.id = r.supplier_id
         LEFT JOIN users u ON u.id = r.operator_id
        WHERE ${cond.join(' AND ')}
        ORDER BY r.id DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, pageSize, offset) as any[];

  const total = countRows(
    `purchase_returns r LEFT JOIN suppliers s ON s.id = r.supplier_id`,
    cond.join(' AND '),
    params,
  );

  const ctx = req.ctx!;
  const list = maskList(rows, { canViewPrice: canViewPrice(ctx) }).map((r: any) => ({
    ...r,
    canUndo: ctx.permissions.includes('purchase.return.create') && r.status === DOC_STATUS.VALID,
  }));
  okList(res, list, total);
});

purchaseReturnRouter.post('/', requirePerm('purchase.return.create'), (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) throw Err.badRequest(parsed.error.issues[0].message);
  const d = parsed.data;
  const ctx = req.ctx!;

  const id = tx(() => {
    let supplierId = d.supplierId ?? null;
    if (d.receiptId) {
      const receipt = db.prepare(`SELECT * FROM purchase_receipts WHERE id = ?`).get(d.receiptId) as any;
      if (!receipt) throw Err.notFound('关联的入库单不存在');
      if (receipt.status !== DOC_STATUS.VALID) throw Err.conflict('该入库单已撤销，无法退货');
      supplierId = supplierId ?? receipt.supplier_id ?? null;
    }

    const returnNo = nextCode('purchaseReturn', d.returnDate);
    const totalAmount = d.items.reduce((s, i) => s + i.qty * i.price, 0);

    const info = db
      .prepare(
        `INSERT INTO purchase_returns (return_no, receipt_id, supplier_id, return_date, operator_id, status, total_amount, remark, created_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        returnNo,
        d.receiptId ?? null,
        supplierId,
        d.returnDate,
        ctx.userId,
        DOC_STATUS.VALID,
        totalAmount,
        d.remark,
        nowIso(),
      );
    const returnId = Number(info.lastInsertRowid);

    const ins = db.prepare(
      `INSERT INTO purchase_return_items (return_id, material_id, qty, price, amount) VALUES (?,?,?,?,?)`,
    );
    for (const it of d.items) ins.run(returnId, it.materialId, it.qty, it.price, it.qty * it.price);

    // 退货 = 物料出库，冲减应付由 total_amount 承载
    applyStock(
      d.items.map((it) => ({
        itemType: 'material' as const,
        itemId: it.materialId,
        direction: 'out' as const,
        qty: it.qty,
        bizType: '采购退货',
        bizId: returnId,
        bizNo: returnNo,
        unitPrice: it.price,
        operatorId: ctx.userId,
      })),
    );

    writeLog({
      operatorId: ctx.userId,
      action: '采购退货',
      targetType: 'purchase_return',
      targetId: returnId,
      detail: { returnNo, totalAmount },
    });
    return returnId;
  });

  ok(res, { id });
});

purchaseReturnRouter.post('/:id/undo', requirePerm('purchase.return.create'), (req, res) => {
  const id = Number(req.params.id);
  tx(() => {
    const r = db.prepare(`SELECT * FROM purchase_returns WHERE id = ?`).get(id) as any;
    if (!r) throw Err.notFound('退货单不存在');
    if (r.status !== DOC_STATUS.VALID) throw Err.conflict('该退货单已撤销');
    reverseStock('采购退货', id, req.ctx!.userId);
    db.prepare(`UPDATE purchase_returns SET status = ? WHERE id = ?`).run(DOC_STATUS.CANCELLED, id);
    writeLog({
      operatorId: req.ctx!.userId,
      action: '撤销采购退货',
      targetType: 'purchase_return',
      targetId: id,
    });
  });
  ok(res, { id });
});
