import { Router } from 'express';
import { z } from 'zod';
import { DOC_STATUS } from '../../../../shared/enums.js';
import { db, nowIso, tx } from '../../db/index.js';
import { Err } from '../../core/errors.js';
import { nextCode } from '../../core/code.js';
import { applyStock, reverseStock } from '../../core/ledger.js';
import { expandBom } from '../../core/bom.js';
import { writeLog } from '../../core/log.js';
import { maskList } from '../../core/serializer.js';
import { requirePerm } from '../../middleware/auth.js';
import { canViewPrice } from '../../middleware/context.js';
import { countRows, parsePage } from '../../shared/query.js';
import { ok, okList } from '../../shared/http.js';
import { cartonQtyOf } from '../production/helpers.js';
import { alertConfig } from '../system/settings.js';

export const warehouseRouter = Router();

const materialItem = z.object({
  materialId: z.number().int().positive(),
  qty: z.number().positive('数量必须大于 0'),
  price: z.number().min(0).default(0),
  reason: z.string().trim().optional().default(''),
});

// ---------------- 物料销售 ----------------

warehouseRouter.get('/material-sales', requirePerm('warehouse.materialSale.view'), (req, res) => {
  const { page, pageSize, offset } = parsePage(req);
  const rows = db
    .prepare(
      `SELECT s.*, u.display_name AS operator_name,
              (SELECT IFNULL(GROUP_CONCAT(m.name || '×' || i.qty, '、'), '')
                 FROM material_sale_items i JOIN materials m ON m.id = i.material_id
                WHERE i.sale_id = s.id) AS content
         FROM material_sales s LEFT JOIN users u ON u.id = s.operator_id
        ORDER BY s.id DESC LIMIT ? OFFSET ?`,
    )
    .all(pageSize, offset) as any[];
  const ctx = req.ctx!;
  okList(
    res,
    maskList(rows, { canViewPrice: canViewPrice(ctx) }).map((r: any) => ({
      ...r,
      canUndo: ctx.permissions.includes('warehouse.materialSale.create') && r.status === DOC_STATUS.VALID,
    })),
    countRows('material_sales'),
  );
});

warehouseRouter.post('/material-sales', requirePerm('warehouse.materialSale.create'), (req, res) => {
  const parsed = z
    .object({
      customerId: z.number().int().nullable().optional(),
      saleDate: z.string().min(1, '请选择销售日期'),
      items: z.array(materialItem).min(1, '请至少录入一条明细'),
      remark: z.string().trim().optional().default(''),
    })
    .safeParse(req.body);
  if (!parsed.success) throw Err.badRequest(parsed.error.issues[0].message);
  const d = parsed.data;

  const id = tx(() => {
    const saleNo = nextCode('materialSale', d.saleDate);
    const totalAmount = d.items.reduce((s, i) => s + i.qty * i.price, 0);
    const info = db
      .prepare(
        `INSERT INTO material_sales (sale_no, customer_id, sale_date, status, total_amount, operator_id, remark, created_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(saleNo, d.customerId ?? null, d.saleDate, DOC_STATUS.VALID, totalAmount, req.ctx!.userId, d.remark, nowIso());
    const saleId = Number(info.lastInsertRowid);
    const ins = db.prepare(`INSERT INTO material_sale_items (sale_id, material_id, qty, price) VALUES (?,?,?,?)`);
    for (const it of d.items) ins.run(saleId, it.materialId, it.qty, it.price);

    applyStock(
      d.items.map((it) => ({
        itemType: 'material' as const,
        itemId: it.materialId,
        direction: 'out' as const,
        qty: it.qty,
        bizType: '物料销售',
        bizId: saleId,
        bizNo: saleNo,
        unitPrice: it.price,
        operatorId: req.ctx!.userId,
      })),
    );
    writeLog({
      operatorId: req.ctx!.userId,
      action: '物料销售出库',
      targetType: 'material_sale',
      targetId: saleId,
      detail: { saleNo },
    });
    return saleId;
  });
  ok(res, { id });
});

warehouseRouter.post('/material-sales/:id/undo', requirePerm('warehouse.materialSale.create'), (req, res) => {
  const id = Number(req.params.id);
  tx(() => {
    const s = db.prepare(`SELECT * FROM material_sales WHERE id = ?`).get(id) as any;
    if (!s) throw Err.notFound('物料销售单不存在');
    if (s.status !== DOC_STATUS.VALID) throw Err.conflict('该单据已撤销');
    reverseStock('物料销售', id, req.ctx!.userId);
    db.prepare(`UPDATE material_sales SET status = ? WHERE id = ?`).run(DOC_STATUS.CANCELLED, id);
    writeLog({ operatorId: req.ctx!.userId, action: '撤销物料销售', targetType: 'material_sale', targetId: id });
  });
  ok(res, { id });
});

// ---------------- 不良品出库 ----------------

warehouseRouter.get('/defectives', requirePerm('warehouse.defective.view'), (req, res) => {
  const { page, pageSize, offset } = parsePage(req);
  const rows = db
    .prepare(
      `SELECT d.*, u.display_name AS operator_name,
              (SELECT IFNULL(GROUP_CONCAT(m.name || '×' || i.qty, '、'), '')
                 FROM defective_out_items i JOIN materials m ON m.id = i.material_id
                WHERE i.out_id = d.id) AS content
         FROM defective_outs d LEFT JOIN users u ON u.id = d.operator_id
        ORDER BY d.id DESC LIMIT ? OFFSET ?`,
    )
    .all(pageSize, offset) as any[];
  const ctx = req.ctx!;
  okList(
    res,
    maskList(rows, { canViewPrice: canViewPrice(ctx) }).map((r: any) => ({
      ...r,
      canUndo: ctx.permissions.includes('warehouse.defective.create') && r.status === DOC_STATUS.VALID,
    })),
    countRows('defective_outs'),
  );
});

warehouseRouter.post('/defectives', requirePerm('warehouse.defective.create'), (req, res) => {
  const parsed = z
    .object({
      outDate: z.string().min(1, '请选择出库日期'),
      items: z.array(materialItem).min(1, '请至少录入一条不良品明细'),
      remark: z.string().trim().optional().default(''),
    })
    .safeParse(req.body);
  if (!parsed.success) throw Err.badRequest(parsed.error.issues[0].message);
  const d = parsed.data;

  const id = tx(() => {
    const outNo = nextCode('defectiveOut', d.outDate);
    const info = db
      .prepare(
        `INSERT INTO defective_outs (out_no, out_date, status, operator_id, remark, created_at) VALUES (?,?,?,?,?,?)`,
      )
      .run(outNo, d.outDate, DOC_STATUS.VALID, req.ctx!.userId, d.remark, nowIso());
    const outId = Number(info.lastInsertRowid);
    const ins = db.prepare(`INSERT INTO defective_out_items (out_id, material_id, qty, reason) VALUES (?,?,?,?)`);
    for (const it of d.items) ins.run(outId, it.materialId, it.qty, it.reason);

    applyStock(
      d.items.map((it) => ({
        itemType: 'material' as const,
        itemId: it.materialId,
        direction: 'out' as const,
        qty: it.qty,
        bizType: '不良品出库',
        bizId: outId,
        bizNo: outNo,
        operatorId: req.ctx!.userId,
      })),
    );
    writeLog({
      operatorId: req.ctx!.userId,
      action: '不良品出库',
      targetType: 'defective_out',
      targetId: outId,
      detail: { outNo, count: d.items.length },
    });
    return outId;
  });
  ok(res, { id });
});

warehouseRouter.post('/defectives/:id/undo', requirePerm('warehouse.defective.create'), (req, res) => {
  const id = Number(req.params.id);
  tx(() => {
    const d = db.prepare(`SELECT * FROM defective_outs WHERE id = ?`).get(id) as any;
    if (!d) throw Err.notFound('不良品出库单不存在');
    if (d.status !== DOC_STATUS.VALID) throw Err.conflict('该单据已撤销');
    reverseStock('不良品出库', id, req.ctx!.userId);
    db.prepare(`UPDATE defective_outs SET status = ? WHERE id = ?`).run(DOC_STATUS.CANCELLED, id);
    writeLog({ operatorId: req.ctx!.userId, action: '撤销不良品出库', targetType: 'defective_out', targetId: id });
  });
  ok(res, { id });
});

// ---------------- 库存盘点 ----------------

warehouseRouter.get('/checks', requirePerm('warehouse.check.view'), (req, res) => {
  const { page, pageSize, offset } = parsePage(req);
  const rows = db
    .prepare(
      `SELECT c.*, u.display_name AS operator_name, a.display_name AS auditor_name,
              (SELECT COUNT(*) FROM stock_check_items i WHERE i.check_id = c.id) AS item_count
         FROM stock_checks c
         LEFT JOIN users u ON u.id = c.operator_id
         LEFT JOIN users a ON a.id = c.auditor_id
        ORDER BY c.id DESC LIMIT ? OFFSET ?`,
    )
    .all(pageSize, offset) as any[];
  const ctx = req.ctx!;
  okList(
    res,
    rows.map((r: any) => ({
      ...r,
      canAudit: ctx.permissions.includes('warehouse.check.audit') && r.status === '待审核',
      canUndo: ctx.permissions.includes('warehouse.check.audit') && r.status === '已审核',
    })),
    countRows('stock_checks'),
  );
});

warehouseRouter.get('/checks/:id', requirePerm('warehouse.check.view'), (req, res) => {
  const id = Number(req.params.id);
  const check = db.prepare(`SELECT * FROM stock_checks WHERE id = ?`).get(id) as any;
  if (!check) throw Err.notFound('盘点单不存在');
  const items = db
    .prepare(
      `SELECT i.*, CASE WHEN i.item_type = 'material'
                        THEN (SELECT name FROM materials m WHERE m.id = i.item_id)
                        ELSE (SELECT name FROM products p WHERE p.id = i.item_id) END AS item_name,
              CASE WHEN i.item_type = 'material'
                        THEN (SELECT code FROM materials m WHERE m.id = i.item_id)
                        ELSE (SELECT code FROM products p WHERE p.id = i.item_id) END AS item_code
         FROM stock_check_items i WHERE i.check_id = ?`,
    )
    .all(id);
  ok(res, { check, items });
});

/** 录入实盘数据：生成待审核盘点单，此时该对象的出入库被锁定 */
warehouseRouter.post('/checks', requirePerm('warehouse.check.create'), (req, res) => {
  const parsed = z
    .object({
      checkDate: z.string().min(1, '请选择盘点日期'),
      items: z
        .array(
          z.object({
            itemType: z.enum(['material', 'product']),
            itemId: z.number().int().positive(),
            actualQty: z.number().min(0, '实盘数量不能为负'),
          }),
        )
        .min(1, '请至少录入一条实盘数据'),
      remark: z.string().trim().optional().default(''),
    })
    .safeParse(req.body);
  if (!parsed.success) throw Err.badRequest(parsed.error.issues[0].message);
  const d = parsed.data;

  const id = tx(() => {
    const checkNo = nextCode('stockCheck', d.checkDate);
    const info = db
      .prepare(
        `INSERT INTO stock_checks (check_no, check_date, status, operator_id, remark, created_at)
         VALUES (?,?, '待审核',?,?,?)`,
      )
      .run(checkNo, d.checkDate, req.ctx!.userId, d.remark, nowIso());
    const checkId = Number(info.lastInsertRowid);

    const ins = db.prepare(
      `INSERT INTO stock_check_items (check_id, item_type, item_id, book_qty, actual_qty, diff_qty) VALUES (?,?,?,?,?,?)`,
    );
    for (const it of d.items) {
      const table = it.itemType === 'material' ? 'materials' : 'products';
      const row = db.prepare(`SELECT current_stock FROM ${table} WHERE id = ?`).get(it.itemId) as any;
      if (!row) throw Err.notFound('盘点对象不存在');
      const book = Number(row.current_stock);
      ins.run(checkId, it.itemType, it.itemId, book, it.actualQty, it.actualQty - book);
    }

    writeLog({
      operatorId: req.ctx!.userId,
      action: '录入库存盘点',
      targetType: 'stock_check',
      targetId: checkId,
      detail: { checkNo, count: d.items.length },
    });
    return checkId;
  });
  ok(res, { id });
});

/** 审核：按差异生成调整流水（需求 3.7.2） */
warehouseRouter.post('/checks/:id/audit', requirePerm('warehouse.check.audit'), (req, res) => {
  const id = Number(req.params.id);
  tx(() => {
    const check = db.prepare(`SELECT * FROM stock_checks WHERE id = ?`).get(id) as any;
    if (!check) throw Err.notFound('盘点单不存在');
    if (check.status !== '待审核') throw Err.conflict('该盘点单已审核或已撤销');

    const items = db.prepare(`SELECT * FROM stock_check_items WHERE check_id = ?`).all(id) as any[];

    // 先置为已审核，避免调整流水被盘点锁拦截
    db.prepare(`UPDATE stock_checks SET status = '已审核', auditor_id = ?, remark = ? WHERE id = ?`).run(
      req.ctx!.userId,
      check.remark,
      id,
    );

    const entries = items
      .filter((it) => Math.abs(Number(it.diff_qty)) > 1e-9)
      .map((it) => ({
        itemType: it.item_type as 'material' | 'product',
        itemId: it.item_id,
        direction: (Number(it.diff_qty) > 0 ? 'in' : 'out') as 'in' | 'out',
        qty: Math.abs(Number(it.diff_qty)),
        bizType: '盘点调整',
        bizId: id,
        bizNo: check.check_no,
        operatorId: req.ctx!.userId,
        allowDuringCheck: true,
        allowNegative: true,
      }));

    if (entries.length > 0) applyStock(entries);

    writeLog({
      operatorId: req.ctx!.userId,
      action: '审核库存盘点',
      targetType: 'stock_check',
      targetId: id,
      detail: { checkNo: check.check_no, adjusted: entries.length },
    });
  });
  ok(res, { id });
});

warehouseRouter.post('/checks/:id/undo', requirePerm('warehouse.check.audit'), (req, res) => {
  const id = Number(req.params.id);
  tx(() => {
    const check = db.prepare(`SELECT * FROM stock_checks WHERE id = ?`).get(id) as any;
    if (!check) throw Err.notFound('盘点单不存在');
    if (check.status === '已撤销') throw Err.conflict('该盘点单已撤销');
    if (check.status === '已审核') {
      reverseStock('盘点调整', id, req.ctx!.userId);
    }
    db.prepare(`UPDATE stock_checks SET status = '已撤销' WHERE id = ?`).run(id);
    writeLog({ operatorId: req.ctx!.userId, action: '撤销库存盘点', targetType: 'stock_check', targetId: id });
  });
  ok(res, { id });
});

// ---------------- 模拟出货与排产建议 ----------------

/**
 * 模拟出货：比对成品库存，按缺口展开 BOM 计算子物料需求与缺口（需求 3.7.3）
 * 不写业务单据，只做测算，可一键转生产工单或跳转采购。
 */
warehouseRouter.post('/simulate', requirePerm('warehouse.simulate.view'), (req, res) => {
  const parsed = z
    .object({
      items: z
        .array(z.object({ productId: z.number().int().positive(), qty: z.number().positive() }))
        .min(1, '请至少录入一条出货需求'),
      remark: z.string().trim().optional().default(''),
    })
    .safeParse(req.body);
  if (!parsed.success) throw Err.badRequest(parsed.error.issues[0].message);
  const d = parsed.data;

  const productRows = d.items.map((it) => {
    const p = db.prepare(`SELECT * FROM products WHERE id = ?`).get(it.productId) as any;
    if (!p) throw Err.notFound(`成品 #${it.productId} 不存在`);
    const stock = Number(p.current_stock);
    const needProduce = Math.max(0, it.qty - stock);
    return { productId: it.productId, code: p.code, name: p.name, unit: p.unit, requireQty: it.qty, stock, needProduce };
  });

  // 仅对缺口部分展开 BOM（已有成品库存无需再生产）
  const materialNeed = new Map<number, number>();
  for (const row of productRows) {
    if (row.needProduce <= 0) continue;
    const p = db.prepare(`SELECT * FROM products WHERE id = ?`).get(row.productId) as any;
    for (const [mid, qty] of expandBom(row.productId, row.needProduce)) {
      materialNeed.set(mid, (materialNeed.get(mid) ?? 0) + qty);
    }
    const carton = cartonQtyOf(p, row.needProduce);
    if (carton > 0 && p.carton_material_id) {
      materialNeed.set(p.carton_material_id, (materialNeed.get(p.carton_material_id) ?? 0) + carton);
    }
  }

  const materialRows = [...materialNeed].map(([materialId, need]) => {
    const m = db.prepare(`SELECT code, name, spec, unit, current_stock FROM materials WHERE id = ?`).get(materialId) as any;
    const stock = Number(m?.current_stock ?? 0);
    return {
      materialId,
      code: m?.code ?? '',
      name: m?.name ?? `#${materialId}`,
      spec: m?.spec ?? '',
      unit: m?.unit ?? '',
      needQty: round(need),
      stock,
      gapQty: round(Math.max(0, need - stock)),
    };
  });

  ok(res, {
    products: productRows,
    materials: materialRows,
    summary: {
      productKinds: productRows.length,
      needProduceKinds: productRows.filter((p) => p.needProduce > 0).length,
      materialKinds: materialRows.length,
      shortageKinds: materialRows.filter((m) => m.gapQty > 0).length,
    },
  });
});

/** 一键按缺口批量生成生产工单（需求 3.7.3） */
warehouseRouter.post('/simulate/to-work-orders', requirePerm('production.wo.create'), (req, res) => {
  const parsed = z
    .object({
      items: z
        .array(z.object({ productId: z.number().int().positive(), planQty: z.number().positive() }))
        .min(1, '没有需要排产的成品'),
    })
    .safeParse(req.body);
  if (!parsed.success) throw Err.badRequest(parsed.error.issues[0].message);

  const created = tx(() => {
    const out: number[] = [];
    for (const it of parsed.data.items) {
      const p = db.prepare(`SELECT bom_version FROM products WHERE id = ?`).get(it.productId) as any;
      if (!p) continue;
      const woNo = nextCode('workOrder');
      const info = db
        .prepare(
          `INSERT INTO work_orders (wo_no, product_id, plan_qty, bom_version, status, created_by, created_at, updated_at)
           VALUES (?,?,?,?, '未开工',?,?,?)`,
        )
        .run(woNo, it.productId, it.planQty, p.bom_version ?? 'V1.0', req.ctx!.userId, nowIso(), nowIso());
      out.push(Number(info.lastInsertRowid));
    }
    writeLog({
      operatorId: req.ctx!.userId,
      action: '模拟出货转生产工单',
      targetType: 'work_order',
      detail: { count: out.length },
    });
    return out;
  });

  ok(res, { ids: created, count: created.length });
});

// ---------------- 库存预警看板 ----------------

/** 四级卡片：安全库存告警 / 严重缺货 / 超储预警 / 呆滞库存（需求 3.7.4） */
warehouseRouter.get('/alarm', requirePerm('warehouse.alarm.view'), (req, res) => {
  const itemType = String(req.query.itemType ?? 'material') as 'material' | 'product';
  const level = String(req.query.level ?? '').trim();
  const table = itemType === 'material' ? 'materials' : 'products';
  const codeCol = itemType === 'material' ? 'code' : 'code';

  const rows = db
    .prepare(
      `SELECT id, ${codeCol} AS code, name, spec, unit, current_stock, safety_stock,
              avg_cost, updated_at
         FROM ${table} ORDER BY name COLLATE NOCASE`,
    )
    .all() as any[];

  // 阈值改为读系统参数（P5），管理员可在「系统设置」中调整，不再写死
  const cfg = alertConfig();
  const cutoff = new Date(Date.now() - cfg.idleDays * 86400000).toISOString();

  const detailed = rows.map((r) => {
    const stock = Number(r.current_stock);
    const safety = Number(r.safety_stock);
    let lvl = '';
    if (safety > 0) {
      if (stock < safety * cfg.severeRatio) lvl = '严重缺货';
      else if (stock < safety * cfg.safetyRatio) lvl = '安全库存告警';
      else if (stock > safety * cfg.overStockRatio) lvl = '超储预警';
    }
    if (!lvl && stock > 0) {
      // 呆滞：有库存但近 90 天无出库流水
      const out = db
        .prepare(
          `SELECT 1 FROM stock_ledger
            WHERE item_type = ? AND item_id = ? AND direction = 'out'
              AND status = '有效' AND is_reversal = 0 AND created_at >= ?
            LIMIT 1`,
        )
        .get(itemType, r.id, cutoff);
      if (!out) lvl = '呆滞库存';
    }
    return { ...r, level: lvl, itemType };
  });

  const alerts = detailed.filter((r) => r.level && (!level || r.level === level));

  const cards = {
    安全库存告警: detailed.filter((r) => r.level === '安全库存告警').length,
    严重缺货: detailed.filter((r) => r.level === '严重缺货').length,
    超储预警: detailed.filter((r) => r.level === '超储预警').length,
    呆滞库存: detailed.filter((r) => r.level === '呆滞库存').length,
  };

  ok(res, { cards, list: maskList(alerts, { canViewPrice: canViewPrice(req.ctx!) }) });
});

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
