import { Router } from 'express';
import { z } from 'zod';
import { db, nowIso, tx } from '../../db/index.js';
import { Err } from '../../core/errors.js';
import { nextCode } from '../../core/code.js';
import { writeLog } from '../../core/log.js';
import { requirePerm } from '../../middleware/auth.js';
import { countRows, parsePage } from '../../shared/query.js';
import { ok, okList } from '../../shared/http.js';
import { availableToReceive, refreshWorkOrder } from './helpers.js';

export const workOrderRouter = Router();

const schema = z.object({
  productId: z.number().int().positive('请选择主产品'),
  planQty: z.number().positive('计划产量必须大于 0'),
  bomVersion: z.string().trim().optional().default(''),
  planStart: z.string().trim().optional().default(''),
  planEnd: z.string().trim().optional().default(''),
  remark: z.string().trim().optional().default(''),
});

workOrderRouter.get('/', requirePerm('production.wo.view'), (req, res) => {
  const { page, pageSize, offset, keyword } = parsePage(req);
  const where = keyword
    ? `(w.wo_no LIKE @kw OR p.name LIKE @kw OR IFNULL(p.code,'') LIKE @kw)`
    : '1=1';
  const params = keyword ? { kw: `%${keyword}%`, limit: pageSize, offset } : { limit: pageSize, offset };

  const rows = db
    .prepare(
      `SELECT w.*, p.name AS product_name, p.code AS product_code, p.spec AS product_spec,
              p.unit, p.bom_version AS product_bom_version
         FROM work_orders w JOIN products p ON p.id = w.product_id
        WHERE ${where}
        ORDER BY w.id DESC
        LIMIT @limit OFFSET @offset`,
    )
    .all(params) as any[];

  const total = countRows(
    `work_orders w JOIN products p ON p.id = w.product_id`,
    keyword ? `(w.wo_no LIKE ? OR p.name LIKE ? OR IFNULL(p.code,'') LIKE ?)` : '1=1',
    keyword ? [`%${keyword}%`, `%${keyword}%`, `%${keyword}%`] : [],
  );

  const ctx = req.ctx!;
  const canReceive = ctx.permissions.includes('production.receipt.create');

  // 需求 4.6：工单列表「去入库」仅对未领料工单开放；已全部入库自动隐藏
  const list = rows.map((r) => {
    const remain = Math.max(0, Number(r.plan_qty) - Number(r.received_qty));
    return {
      ...r,
      remainQty: remain,
      canReceive: canReceive && Number(r.issued_qty) === 0 && remain > 0,
      canEdit:
        ctx.permissions.includes('production.wo.update') &&
        Number(r.issued_qty) === 0 &&
        r.status !== '已完工',
    };
  });

  okList(res, list, total);
});

workOrderRouter.get('/options', requirePerm('production.wo.view'), (req, res) => {
  const rows = db
    .prepare(
      `SELECT w.id, w.wo_no, w.product_id, w.plan_qty, w.issued_qty, w.received_qty, w.status,
              p.name AS product_name, p.code AS product_code
         FROM work_orders w JOIN products p ON p.id = w.product_id
        WHERE w.status <> '已完工' OR w.received_qty < w.plan_qty
        ORDER BY w.id DESC LIMIT 200`,
    )
    .all() as any[];
  ok(res, rows.map((r) => ({ ...r, availableQty: availableToReceive(r.id) })));
});

/** 去入库预填：仅未领料工单走「成品入库（直接扣料）」（需求 4.6） */
workOrderRouter.get('/:id/for-receipt', requirePerm('production.receipt.create'), (req, res) => {
  const id = Number(req.params.id);
  const wo = db
    .prepare(
      `SELECT w.*, p.name AS product_name, p.code AS product_code, p.spec AS product_spec, p.unit
         FROM work_orders w JOIN products p ON p.id = w.product_id WHERE w.id = ?`,
    )
    .get(id) as any;
  if (!wo) throw Err.notFound('生产工单不存在');
  if (Number(wo.issued_qty) > 0) {
    throw Err.conflict('该工单已领料，请从「生产领料」列表进入入库');
  }
  const remain = Math.max(0, Number(wo.plan_qty) - Number(wo.received_qty));
  if (remain <= 0) throw Err.conflict('该工单已全部入库');
  ok(res, { workOrder: wo, productId: wo.product_id, suggestQty: remain, receiptType: '成品入库（直接扣料）' });
});

workOrderRouter.get('/:id', requirePerm('production.wo.view'), (req, res) => {
  const row = db
    .prepare(
      `SELECT w.*, p.name AS product_name, p.code AS product_code
         FROM work_orders w JOIN products p ON p.id = w.product_id WHERE w.id = ?`,
    )
    .get(Number(req.params.id)) as any;
  if (!row) throw Err.notFound('生产工单不存在');
  ok(res, row);
});

workOrderRouter.post('/', requirePerm('production.wo.create'), (req, res) => {
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) throw Err.badRequest(parsed.error.issues[0].message);
  const d = parsed.data;

  const id = tx(() => {
    const product = db.prepare(`SELECT bom_version FROM products WHERE id = ?`).get(d.productId) as any;
    if (!product) throw Err.notFound('主产品不存在');
    const woNo = nextCode('workOrder');
    const info = db
      .prepare(
        `INSERT INTO work_orders (wo_no, product_id, plan_qty, bom_version, plan_start, plan_end,
           status, remark, created_by, created_at, updated_at)
         VALUES (?,?,?,?,?,?, '未开工', ?,?,?,?)`,
      )
      .run(
        woNo,
        d.productId,
        d.planQty,
        d.bomVersion?.trim() || product.bom_version || 'V1.0',
        d.planStart || null,
        d.planEnd || null,
        d.remark,
        req.ctx!.userId,
        nowIso(),
        nowIso(),
      );
    writeLog({
      operatorId: req.ctx!.userId,
      action: '新增生产工单',
      targetType: 'work_order',
      targetId: Number(info.lastInsertRowid),
      detail: { woNo, planQty: d.planQty },
    });
    return Number(info.lastInsertRowid);
  });
  ok(res, { id });
});

workOrderRouter.put('/:id', requirePerm('production.wo.update'), (req, res) => {
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) throw Err.badRequest(parsed.error.issues[0].message);
  const d = parsed.data;
  const id = Number(req.params.id);

  tx(() => {
    const wo = db.prepare(`SELECT * FROM work_orders WHERE id = ?`).get(id) as any;
    if (!wo) throw Err.notFound('生产工单不存在');
    if (Number(wo.issued_qty) > 0) throw Err.conflict('该工单已领料，禁止修改');
    db.prepare(
      `UPDATE work_orders SET product_id=?, plan_qty=?, bom_version=?, plan_start=?, plan_end=?, remark=?, updated_at=?
        WHERE id=?`,
    ).run(
      d.productId,
      d.planQty,
      d.bomVersion || null,
      d.planStart || null,
      d.planEnd || null,
      d.remark,
      nowIso(),
      id,
    );
    refreshWorkOrder(id);
    writeLog({
      operatorId: req.ctx!.userId,
      action: '修改生产工单',
      targetType: 'work_order',
      targetId: id,
    });
  });
  ok(res, { id });
});

workOrderRouter.delete('/:id', requirePerm('production.wo.update'), (req, res) => {
  const id = Number(req.params.id);
  tx(() => {
    const wo = db.prepare(`SELECT * FROM work_orders WHERE id = ?`).get(id) as any;
    if (!wo) throw Err.notFound('生产工单不存在');
    if (Number(wo.issued_qty) > 0 || Number(wo.received_qty) > 0) {
      throw Err.conflict('该工单已发生领料或入库，禁止删除');
    }
    db.prepare(`DELETE FROM work_orders WHERE id = ?`).run(id);
    writeLog({
      operatorId: req.ctx!.userId,
      action: '删除生产工单',
      targetType: 'work_order',
      targetId: id,
    });
  });
  ok(res, { id });
});

export { refreshWorkOrder };
