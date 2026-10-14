import { Router } from 'express';
import { z } from 'zod';
import { DOC_STATUS } from '../../../../shared/enums.js';
import { db, nowIso, tx } from '../../db/index.js';
import { Err } from '../../core/errors.js';
import { nextCode } from '../../core/code.js';
import { applyStock, reverseStock } from '../../core/ledger.js';
import { resolveWarehouse, stockOfWarehouse } from '../../core/warehouse.js';
import { expandBom } from '../../core/bom.js';
import { writeLog } from '../../core/log.js';
import { maskList } from '../../core/serializer.js';
import { requirePerm } from '../../middleware/auth.js';
import { canViewPrice } from '../../middleware/context.js';
import { countRows, parsePage } from '../../shared/query.js';
import { ok, okList } from '../../shared/http.js';
import { cartonQtyOf, refreshWorkOrder } from '../production/helpers.js';
import { alertConfig } from '../system/settings.js';

export const warehouseRouter = Router();

const materialItem = z.object({
  materialId: z.number().int().positive(),
  qty: z.number().positive('数量必须大于 0'),
  price: z.number().min(0).default(0),
  reason: z.string().trim().optional().default(''),
});

/** 不良品出库来源：manual=手工拣选（原有）/ issue=生产领料后识别的不良品退回 */

// ---------------- 物料销售 ----------------

warehouseRouter.get('/material-sales', requirePerm('warehouse.materialSale.view'), (req, res) => {
  const { page, pageSize, offset, keyword } = parsePage(req);
  // 需求 25：按日期区间、客户、物料名称/编码包含字筛选
  const customerId = Number(req.query.customerId ?? 0) || 0;
  const materialKeyword = String(req.query.materialKeyword ?? '').trim();
  const dateFrom = String(req.query.dateFrom ?? '').trim();
  const dateTo = String(req.query.dateTo ?? '').trim();

  const cond: string[] = ['1=1'];
  const params: any[] = [];
  if (keyword) {
    cond.push(`(s.sale_no LIKE ?)`);
    params.push(`%${keyword}%`);
  }
  if (customerId) {
    cond.push('s.customer_id = ?');
    params.push(customerId);
  }
  if (dateFrom) {
    cond.push('s.sale_date >= ?');
    params.push(dateFrom);
  }
  if (dateTo) {
    cond.push('s.sale_date <= ?');
    params.push(dateTo);
  }
  if (materialKeyword) {
    cond.push(
      `EXISTS (SELECT 1 FROM material_sale_items i JOIN materials m ON m.id = i.material_id
                WHERE i.sale_id = s.id AND (m.name LIKE ? OR m.code LIKE ?))`,
    );
    params.push(`%${materialKeyword}%`, `%${materialKeyword}%`);
  }
  const where = cond.join(' AND ');

  const rows = db
    .prepare(
      `SELECT s.*, c.name AS customer_name, u.display_name AS operator_name,
              (SELECT IFNULL(GROUP_CONCAT(m.name || '×' || i.qty, '、'), '')
                 FROM material_sale_items i JOIN materials m ON m.id = i.material_id
                WHERE i.sale_id = s.id) AS content
         FROM material_sales s
         LEFT JOIN customers c ON c.id = s.customer_id
         LEFT JOIN users u ON u.id = s.operator_id
        WHERE ${where}
        ORDER BY s.id DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, pageSize, offset) as any[];
  const ctx = req.ctx!;
  okList(
    res,
    maskList(rows, { canViewPrice: canViewPrice(ctx) }).map((r: any) => ({
      ...r,
      canUndo: ctx.permissions.includes('warehouse.materialSale.create') && r.status === DOC_STATUS.VALID,
    })),
    countRows(
      `material_sales s LEFT JOIN customers c ON c.id = s.customer_id`,
      where,
      params,
    ),
  );
});

warehouseRouter.post('/material-sales', requirePerm('warehouse.materialSale.create'), (req, res) => {
  const parsed = z
    .object({
      customerId: z.number().int().nullable().optional(),
      saleDate: z.string().min(1, '请选择销售日期'),
      items: z.array(materialItem).min(1, '请至少录入一条明细'),
      /** 出库仓库：不传按物料默认仓（物料库） */
      warehouseId: z.number().int().positive().nullable().optional(),
      remark: z.string().trim().optional().default(''),
    })
    .safeParse(req.body);
  if (!parsed.success) throw Err.badRequest(parsed.error.issues[0].message);
  const d = parsed.data;

  const id = tx(() => {
    const saleNo = nextCode('materialSale', d.saleDate);
    const totalAmount = d.items.reduce((s, i) => s + i.qty * i.price, 0);
    const whId = resolveWarehouse('material', d.warehouseId ?? null);
    const info = db
      .prepare(
        `INSERT INTO material_sales (sale_no, customer_id, sale_date, status, total_amount, operator_id, remark, warehouse_id, created_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(saleNo, d.customerId ?? null, d.saleDate, DOC_STATUS.VALID, totalAmount, req.ctx!.userId, d.remark, whId, nowIso());
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
        warehouseId: whId,
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
  const { page, pageSize, offset, keyword } = parsePage(req);
  // 需求 26：按日期区间、物料名称/编码包含字筛选
  const materialKeyword = String(req.query.materialKeyword ?? '').trim();
  const dateFrom = String(req.query.dateFrom ?? '').trim();
  const dateTo = String(req.query.dateTo ?? '').trim();
  // 领料溯源筛选：sourceType='issue' 时按来源领料单 id 精确查
  const sourceType = String(req.query.sourceType ?? '').trim();
  const issueIdQ = Number(req.query.issueId ?? 0) || 0;

  const cond: string[] = ['1=1'];
  const params: any[] = [];
  if (keyword) {
    cond.push(`(d.out_no LIKE ?)`);
    params.push(`%${keyword}%`);
  }
  if (dateFrom) {
    cond.push('d.out_date >= ?');
    params.push(dateFrom);
  }
  if (dateTo) {
    cond.push('d.out_date <= ?');
    params.push(dateTo);
  }
  if (materialKeyword) {
    cond.push(
      `EXISTS (SELECT 1 FROM defective_out_items i JOIN materials m ON m.id = i.material_id
                WHERE i.out_id = d.id AND (m.name LIKE ? OR m.code LIKE ?))`,
    );
    params.push(`%${materialKeyword}%`, `%${materialKeyword}%`);
  }
  if (sourceType) {
    cond.push(`d.source_type = ?`);
    params.push(sourceType);
  }
  if (issueIdQ) {
    cond.push(`d.issue_id = ?`);
    params.push(issueIdQ);
  }
  const where = cond.join(' AND ');

  const rows = db
    .prepare(
      `SELECT d.*, i.issue_no AS source_issue_no, w.wo_no AS source_wo_no,
              u.display_name AS operator_name,
              (SELECT IFNULL(GROUP_CONCAT(m.name || '×' || i2.qty, '、'), '')
                 FROM defective_out_items i2 JOIN materials m ON m.id = i2.material_id
                WHERE i2.out_id = d.id) AS content
         FROM defective_outs d
         LEFT JOIN users u ON u.id = d.operator_id
         LEFT JOIN material_issues i ON i.id = d.issue_id
         LEFT JOIN work_orders w ON w.id = i.wo_id
        WHERE ${where}
        ORDER BY d.id DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, pageSize, offset) as any[];
  const ctx = req.ctx!;
  okList(
    res,
    maskList(rows, { canViewPrice: canViewPrice(ctx) }).map((r: any) => ({
      ...r,
      sourceLabel:
        r.source_type === 'issue' ? `领料来源 ${r.source_issue_no ?? ''} · ${r.source_wo_no ?? ''}` : '手工拣选',
      canUndo: ctx.permissions.includes('warehouse.defective.create') && r.status === DOC_STATUS.VALID,
    })),
    countRows(
      `defective_outs d LEFT JOIN users u ON u.id = d.operator_id`,
      where,
      params,
    ),
  );
});

warehouseRouter.post('/defectives', requirePerm('warehouse.defective.create'), (req, res) => {
  const parsed = z
    .object({
      outDate: z.string().min(1, '请选择出库日期'),
      sourceType: z.enum(['manual', 'issue']).default('manual'),
      issueId: z.number().int().positive('请选择来源领料单').optional(),
      /** 领料来源时：本单不良品对应的成品数量（台/件），从工单可入库余量中核减 */
      produceQty: z.number().min(0).default(0),
      items: z.array(materialItem).min(1, '请至少录入一条不良品明细'),
      /** 出库仓库：领料来源时不传则取原领料单所在仓，其次按物料默认仓（物料库） */
      warehouseId: z.number().int().positive().nullable().optional(),
      remark: z.string().trim().optional().default(''),
    })
    .safeParse(req.body);
  if (!parsed.success) throw Err.badRequest(parsed.error.issues[0].message);
  const d = parsed.data;

  // 领料来源校验：必须挂在有效领料单上，出库数量不得超过该物料在该领料单的可退量
  let issue: any = null;
  let issueReturnable: Map<number, { materialId: number; name: string; issuedQty: number; returnedQty: number; remainQty: number }> | null = null;
  if (d.sourceType === 'issue') {
    if (!d.issueId) throw Err.badRequest('选择「生产领料」来源时必须关联一张领料单');
    issue = db.prepare(`SELECT * FROM material_issues WHERE id = ?`).get(d.issueId) as any;
    if (!issue) throw Err.notFound('来源领料单不存在');
    if (issue.status !== DOC_STATUS.VALID) throw Err.conflict('来源领料单已撤销，不能作为不良品出库来源');

    // 可退量 = 原领料量 - 累计有效退料量（按源领料明细回溯）
    const rows = db
      .prepare(
        `SELECT ii.material_id, ii.qty AS issued_qty, m.name,
                IFNULL((SELECT SUM(ri.qty) FROM material_return_items ri
                          JOIN material_returns r ON r.id = ri.return_id
                         WHERE ri.src_item_id = ii.id AND r.status = '有效'), 0) AS returned_qty
           FROM material_issue_items ii
           JOIN materials m ON m.id = ii.material_id
          WHERE ii.issue_id = ?`,
      )
      .all(d.issueId) as any[];
    issueReturnable = new Map(
      rows.map((r: any) => [
        r.material_id,
        {
          materialId: r.material_id,
          name: r.name,
          issuedQty: Number(r.issued_qty),
          returnedQty: Number(r.returned_qty),
          remainQty: Number(r.issued_qty) - Number(r.returned_qty),
        },
      ]),
    );

    // 对应成品数量不得超过该领料单「剩余可退成品量」
    // = 领料产量 − 已退良品 − 已退不良 − 已入库（已入库是合格产出，不能再被不良品占走）
    const woForCap = db.prepare(`SELECT * FROM work_orders WHERE id = ?`).get(issue.wo_id) as any;
    const issuedThis = Number(issue.produce_qty);
    const alreadyReturned = Number(
      (db.prepare(`SELECT COALESCE(SUM(return_qty), 0) AS s FROM material_returns WHERE wo_id = ? AND status = '有效'`).get(issue.wo_id) as { s: number }).s,
    );
    const alreadyDefective = Number(
      (db.prepare(
        `SELECT COALESCE(SUM(do.produce_qty), 0) AS s FROM defective_outs do WHERE do.issue_id = ? AND do.source_type = 'issue' AND do.status = '有效'`,
      ).get(d.issueId) as { s: number }).s,
    );
    const alreadyReceived = Number(woForCap?.received_qty ?? 0);
    const maxProduce = Math.max(0, issuedThis - alreadyReturned - alreadyDefective - alreadyReceived);
    if (d.produceQty > maxProduce + 1e-6) {
      throw Err.conflict(
        `对应成品数量 ${d.produceQty} 超过该领料单剩余可退成品量 ${maxProduce}（领料 ${issuedThis} − 已退良品 ${alreadyReturned} − 已退不良 ${alreadyDefective} − 已入库 ${alreadyReceived}），请检查`,
      );
    }
  }

  const id = tx(() => {
    const outNo = nextCode('defectiveOut', d.outDate);

    // 领料来源：逐条校验数量 ≤ 可退量，且物料必须属于该领料单
    if (issue && issueReturnable) {
      for (const it of d.items) {
        const avail = issueReturnable.get(it.materialId);
        if (!avail) {
          throw Err.conflict(`物料 #${it.materialId} 不属于来源领料单，无法按领料来源出库`);
        }
        if (it.qty > avail.remainQty + 1e-6) {
          throw Err.conflict(
            `物料「${avail.name}」出库量 ${it.qty} 超过可退量 ${avail.remainQty}（原领 ${avail.issuedQty ?? '—'}，已退部分已扣除）`,
          );
        }
      }
    }

    const whId = resolveWarehouse('material', d.warehouseId ?? issue?.warehouse_id ?? null);
    const info = db
      .prepare(
        `INSERT INTO defective_outs (out_no, out_date, status, operator_id, remark, created_at, source_type, issue_id, produce_qty, warehouse_id)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        outNo,
        d.outDate,
        DOC_STATUS.VALID,
        req.ctx!.userId,
        d.remark,
        nowIso(),
        d.sourceType,
        d.sourceType === 'issue' ? d.issueId : null,
        d.sourceType === 'issue' ? d.produceQty : 0,
        whId,
      );
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
        warehouseId: whId,
      })),
    );

    // 领料来源：物料已扣出正常库存，对应成品数量需从工单可入库余量中核减
    if (d.sourceType === 'issue' && d.produceQty > 0 && issue) {
      refreshWorkOrder(issue.wo_id);
    }

    writeLog({
      operatorId: req.ctx!.userId,
      action: d.sourceType === 'issue' ? '不良品出库（领料来源）' : '不良品出库',
      targetType: 'defective_out',
      targetId: outId,
      detail: {
        outNo,
        sourceType: d.sourceType,
        issueId: d.sourceType === 'issue' ? d.issueId : null,
        produceQty: d.sourceType === 'issue' ? d.produceQty : 0,
        count: d.items.length,
      },
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
    // 领料来源撤销：物料库存回补后，该领料单对应工单的「可入库余量」随之恢复
    if (d.source_type === 'issue' && d.issue_id) {
      const iss = db.prepare(`SELECT wo_id FROM material_issues WHERE id = ?`).get(d.issue_id) as any;
      if (iss?.wo_id) refreshWorkOrder(iss.wo_id);
    }
    writeLog({ operatorId: req.ctx!.userId, action: '撤销不良品出库', targetType: 'defective_out', targetId: id });
  });
  ok(res, { id });
});

// ---------------- 库存盘点 ----------------

warehouseRouter.get('/checks', requirePerm('warehouse.check.view'), (req, res) => {
  const { page, pageSize, offset, keyword } = parsePage(req);
  // 需求 24：按日期区间、状态、盘点对象（物料/成品名称或编码）包含字筛选
  const status = String(req.query.status ?? '').trim();
  const itemKeyword = String(req.query.itemKeyword ?? '').trim();
  const dateFrom = String(req.query.dateFrom ?? '').trim();
  const dateTo = String(req.query.dateTo ?? '').trim();

  const cond: string[] = ['1=1'];
  const params: any[] = [];
  if (keyword) {
    cond.push('c.check_no LIKE ?');
    params.push(`%${keyword}%`);
  }
  if (status) {
    cond.push('c.status = ?');
    params.push(status);
  }
  if (dateFrom) {
    cond.push('c.check_date >= ?');
    params.push(dateFrom);
  }
  if (dateTo) {
    cond.push('c.check_date <= ?');
    params.push(dateTo);
  }
  if (itemKeyword) {
    cond.push(
      `EXISTS (SELECT 1 FROM stock_check_items i
                 LEFT JOIN materials m ON i.item_type = 'material' AND m.id = i.item_id
                 LEFT JOIN products p ON i.item_type = 'product' AND p.id = i.item_id
                WHERE i.check_id = c.id
                  AND (m.name LIKE ? OR m.code LIKE ? OR p.name LIKE ? OR p.code LIKE ?))`,
    );
    params.push(`%${itemKeyword}%`, `%${itemKeyword}%`, `%${itemKeyword}%`, `%${itemKeyword}%`);
  }
  const where = cond.join(' AND ');

  const rows = db
    .prepare(
      `SELECT c.*, u.display_name AS operator_name, a.display_name AS auditor_name,
              (SELECT COUNT(*) FROM stock_check_items i WHERE i.check_id = c.id) AS item_count
         FROM stock_checks c
         LEFT JOIN users u ON u.id = c.operator_id
         LEFT JOIN users a ON a.id = c.auditor_id
        WHERE ${where}
        ORDER BY c.id DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, pageSize, offset) as any[];
  const ctx = req.ctx!;
  okList(
    res,
    rows.map((r: any) => ({
      ...r,
      canAudit: ctx.permissions.includes('warehouse.check.audit') && r.status === '待审核',
      canUndo: ctx.permissions.includes('warehouse.check.audit') && r.status === '已审核',
    })),
    countRows(
      `stock_checks c
         LEFT JOIN users u ON u.id = c.operator_id
         LEFT JOIN users a ON a.id = c.auditor_id`,
      where,
      params,
    ),
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
      /** 盘点哪个仓：不传按首个盘点对象的品类默认仓（物料→物料库、成品→成品库） */
      warehouseId: z.number().int().positive().nullable().optional(),
      remark: z.string().trim().optional().default(''),
    })
    .safeParse(req.body);
  if (!parsed.success) throw Err.badRequest(parsed.error.issues[0].message);
  const d = parsed.data;

  const id = tx(() => {
    const checkNo = nextCode('stockCheck', d.checkDate);
    // 指定仓 → 全单必须都能放进该仓（物料库放不下成品，反之亦然），逐条校验；
    // 不指定 → warehouse_id 留 NULL，审核时各明细按自身品类归默认仓（兼容历史混合盘点单）。
    const whId = d.warehouseId ? resolveWarehouse(d.items[0].itemType, d.warehouseId) : null;
    if (whId) for (const it of d.items) resolveWarehouse(it.itemType, whId);

    const info = db
      .prepare(
        `INSERT INTO stock_checks (check_no, check_date, status, operator_id, remark, warehouse_id, created_at)
         VALUES (?,?, '待审核',?,?,?,?)`,
      )
      .run(checkNo, d.checkDate, req.ctx!.userId, d.remark, whId, nowIso());
    const checkId = Number(info.lastInsertRowid);

    const ins = db.prepare(
      `INSERT INTO stock_check_items (check_id, item_type, item_id, book_qty, actual_qty, diff_qty) VALUES (?,?,?,?,?,?)`,
    );
    for (const it of d.items) {
      const exists = db
        .prepare(`SELECT id FROM ${it.itemType === 'material' ? 'materials' : 'products'} WHERE id = ?`)
        .get(it.itemId) as any;
      if (!exists) throw Err.notFound('盘点对象不存在');
      // 账面数量按「该仓」的存量，盘的是这个仓；未指定仓则按该品类默认仓
      const book = stockOfWarehouse(it.itemType, it.itemId, resolveWarehouse(it.itemType, whId));
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
        warehouseId: check.warehouse_id ?? null,
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
