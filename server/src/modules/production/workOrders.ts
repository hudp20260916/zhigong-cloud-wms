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
  // 需求 9：按日期区间（计划开工日）、完工状态、包含字筛选
  const statusFilter = String(req.query.statusFilter ?? '').trim();
  const dateFrom = String(req.query.dateFrom ?? '').trim();
  const dateTo = String(req.query.dateTo ?? '').trim();

  const bind: any = { limit: pageSize, offset };
  if (keyword) bind.kw = `%${keyword}%`;
  if (dateFrom) bind.df = dateFrom;
  if (dateTo) bind.dt = dateTo;

  const cond: string[] = ['1=1'];
  if (keyword) cond.push(`(w.wo_no LIKE @kw OR p.name LIKE @kw OR IFNULL(p.code,'') LIKE @kw)`);
  if (dateFrom) cond.push('IFNULL(w.plan_start, w.created_at) >= @df');
  if (dateTo) cond.push('IFNULL(w.plan_start, w.created_at) <= @dt');
  if (statusFilter === 'producing') {
    // 生产中：还没完工，但已经领过料
    cond.push(`(w.status <> '已完工' AND IFNULL(w.issued_qty,0) > 0)`);
  } else if (statusFilter === 'unfinished') {
    // 未完工：还没入库够计划产量
    cond.push(`(w.status <> '已完工' OR IFNULL(w.received_qty,0) < w.plan_qty)`);
  } else if (statusFilter === 'finished') {
    // 已完工：标记完工，或入库量已达计划产量
    cond.push(`(w.status = '已完工' OR IFNULL(w.received_qty,0) >= w.plan_qty)`);
  }
  const where = cond.join(' AND ');

  const rows = db
    .prepare(
      `SELECT w.*, p.name AS product_name, p.code AS product_code, p.spec AS product_spec,
              p.unit, p.bom_version AS product_bom_version
         FROM work_orders w JOIN products p ON p.id = w.product_id
        WHERE ${where}
        ORDER BY w.id DESC
        LIMIT @limit OFFSET @offset`,
    )
    .all(bind) as any[];

  // countRows 走位置参数：按占位符出现顺序入参，避免个数对不上
  const totalParams: any[] = [];
  const totalCond = cond.map((c) =>
    c.replace(/@(\w+)/g, (_m, name: string) => {
      totalParams.push(bind[name]);
      return '?';
    }),
  );
  const total = countRows(
    `work_orders w JOIN products p ON p.id = w.product_id`,
    totalCond.join(' AND '),
    totalParams,
  );

  const ctx = req.ctx!;
  const canReceive = ctx.permissions.includes('production.receipt.create');

  // 需求 4.6 + 完工口径修正：「去入库」统一按「计划尚未入库满」(remain = plan - received > 0) 判定，
  // 不再要求 issued_qty === 0。完工 = 实际入库量 == 计划量（不要求领料）；
  // 「不领料直接入库」的单满量后 remain=0 自动隐藏，领了部分料但未满量的 remain>0 仍开放，
  // 与前端「去领料」按钮同读 remain，避免两按钮同口径不同判。
  // 注：去领料/去入库按钮是否可点仍由前端各自判定；后端在此处只保留「可入库余量>0」的硬门槛。
  const list = rows.map((r) => {
    const remain = Math.max(0, Number(r.plan_qty) - Number(r.received_qty));
    return {
      ...r,
      remainQty: remain,
      canReceive: canReceive && remain > 0,
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
