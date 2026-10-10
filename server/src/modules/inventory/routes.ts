import { Router } from 'express';
import { z } from 'zod';
import type { ItemType } from '../../../../shared/enums.js';
import { db, nowIso, tx } from '../../db/index.js';
import { Err } from '../../core/errors.js';
import { stockSummary } from '../../core/ledger.js';
import { writeLog } from '../../core/log.js';
import { setInitialStock } from './initial.js';
import { maskList } from '../../core/serializer.js';
import { requirePerm } from '../../middleware/auth.js';
import { canExport, canViewPrice } from '../../middleware/context.js';
import { countRows, nameOrderSql, normalizeDir, parsePage } from '../../shared/query.js';
import { ok, okList } from '../../shared/http.js';

export const inventoryRouter = Router();

const ITEM_SQL: Record<ItemType, { table: string; label: string }> = {
  material: { table: 'materials', label: '物料' },
  product: { table: 'products', label: '成品' },
};

/** 物料/成品库存列表：支持表头全局排序，低库存标记用于「去采购 / 去创建工单」入口 */
function stockList(itemType: ItemType) {
  return (req: any, res: any) => {
    const { page, pageSize, offset, keyword } = parsePage(req);
    const order = nameOrderSql('t.name', normalizeDir(req.query.sortDir));
    const { table } = ITEM_SQL[itemType];

    const where = keyword
      ? `(t.code LIKE @kw OR t.name LIKE @kw OR IFNULL(t.pinyin,'') LIKE @kw OR IFNULL(t.spec,'') LIKE @kw)`
      : '1=1';
    // countRows 用位置参数，另备一份 ? 版本，否则参数个数对不上
    const wherePos = keyword
      ? `(t.code LIKE ? OR t.name LIKE ? OR IFNULL(t.pinyin,'') LIKE ? OR IFNULL(t.spec,'') LIKE ?)`
      : '1=1';
    const params = keyword
      ? { kw: `%${keyword}%`, limit: pageSize, offset }
      : { limit: pageSize, offset };

    const lowOnly = String(req.query.lowOnly ?? '') === '1';
    const lowCond = lowOnly ? `AND t.current_stock < t.safety_stock` : '';

    // 只有物料有默认供应商，成品不能左连该列
    const supplierJoin =
      itemType === 'material'
        ? `LEFT JOIN suppliers s ON s.id = t.default_supplier_id`
        : '';
    const supplierCol = itemType === 'material' ? `, s.name AS default_supplier_name` : '';

    const rows = db
      .prepare(
        `SELECT t.*${supplierCol}
           FROM ${table} t
           ${supplierJoin}
          WHERE ${where} ${lowCond}
          ORDER BY ${order}
          LIMIT @limit OFFSET @offset`,
      )
      .all(params) as any[];

    const total = countRows(
      `${table} t`,
      `${wherePos} ${lowCond}`,
      keyword ? [`%${keyword}%`, `%${keyword}%`, `%${keyword}%`, `%${keyword}%`] : [],
    );

    const ctx = { canViewPrice: canViewPrice(req.ctx!) };
    const list = maskList(rows, ctx).map((r: any) => ({
      ...r,
      isLow: Number(r.current_stock) < Number(r.safety_stock),
    }));
    okList(res, list, total);
  };
}

inventoryRouter.get('/materials', requirePerm('stock.view'), stockList('material'));
inventoryRouter.get('/products', requirePerm('stock.view'), stockList('product'));

/** 出入库详情：明细流水 + 净额统计（撤销记录不计入，需求 4.8） */
inventoryRouter.get('/detail', requirePerm('stock.detail.view'), (req, res) => {
  const itemType = String(req.query.itemType ?? 'material') as ItemType;
  const itemId = Number(req.query.itemId);
  if (!itemId) throw Err.badRequest('缺少库存对象');
  if (!ITEM_SQL[itemType]) throw Err.badRequest('库存对象类型不正确');

  const direction = String(req.query.direction ?? '').trim();
  const from = String(req.query.from ?? '').trim();
  const to = String(req.query.to ?? '').trim();

  const cond: string[] = [`l.item_type = ?`, `l.item_id = ?`];
  const params: any[] = [itemType, itemId];
  if (direction === 'in' || direction === 'out') {
    cond.push(`l.direction = ?`);
    params.push(direction);
  }
  if (from) {
    cond.push(`l.created_at >= ?`);
    params.push(`${from}T00:00:00.000Z`);
  }
  if (to) {
    cond.push(`l.created_at <= ?`);
    params.push(`${to}T23:59:59.999Z`);
  }

  const rows = db
    .prepare(
      `SELECT l.*, u.display_name AS operator_name
         FROM stock_ledger l LEFT JOIN users u ON u.id = l.operator_id
        WHERE ${cond.join(' AND ')}
        ORDER BY l.created_at DESC, l.id DESC
        LIMIT 500`,
    )
    .all(...params) as any[];

  const ctx = { canViewPrice: canViewPrice(req.ctx!) };
  const summary = stockSummary(itemType, itemId, { from: from || undefined, to: to || undefined });

  ok(res, {
    summary,
    list: maskList(rows, ctx),
    canExport: canExport(req.ctx!),
  });
});

/** 详情导出：库管剔除价格列，普通查询人员直接拒绝（需求 5） */
inventoryRouter.get('/detail/export', requirePerm('stock.detail.view'), (req, res) => {
  if (!canExport(req.ctx!)) throw Err.forbidden('无数据导出权限');
  const itemType = String(req.query.itemType ?? 'material') as ItemType;
  const itemId = Number(req.query.itemId);
  const rows = db
    .prepare(
      `SELECT l.* FROM stock_ledger l
        WHERE l.item_type = ? AND l.item_id = ? ORDER BY l.created_at DESC`,
    )
    .all(itemType, itemId) as any[];
  const ctx = { canViewPrice: canViewPrice(req.ctx!) };
  ok(res, { list: maskList(rows, ctx) });
});

const initialSchema = z.object({
  itemType: z.enum(['material', 'product']),
  itemId: z.number().int().positive(),
  qty: z.number().min(0, '期初数量不能为负数'),
  price: z.number().min(0).optional(),
});

const initialBatchSchema = z.object({
  items: z.array(initialSchema).min(1, '请至少录入一条期初库存'),
});

/**
 * 期初库存录入。
 * 采用「设定」而非「累加」：先回滚该对象已有的期初流水，再写入新的，
 * 保证流水台账里的期初合计始终等于录入值，且 current_stock 与台账一致。
 */
inventoryRouter.post('/initial', requirePerm('stock.initial.manage'), (req, res) => {
  const parsed = initialBatchSchema.safeParse(req.body);
  if (!parsed.success) throw Err.badRequest(parsed.error.issues[0].message);

  const affected = tx(() => {
    for (const item of parsed.data.items) {
      setInitialStock(item.itemType, item.itemId, item.qty, item.price, req.ctx!.userId);
    }

    writeLog({
      operatorId: req.ctx!.userId,
      action: '录入期初库存',
      targetType: 'stock',
      detail: { count: parsed.data.items.length },
    });
    return parsed.data.items.length;
  });

  ok(res, { affected, at: nowIso() });
});

/** 库存流水台账（只读，不含入库单号） */
inventoryRouter.get('/ledger', requirePerm('stock.view'), (req, res) => {
  const { page, pageSize, offset } = parsePage(req);
  const itemType = String(req.query.itemType ?? '').trim();
  const bizType = String(req.query.bizType ?? '').trim();

  const cond: string[] = ['1=1'];
  const params: any[] = [];
  if (itemType) {
    cond.push('l.item_type = ?');
    params.push(itemType);
  }
  if (bizType) {
    cond.push('l.biz_type = ?');
    params.push(bizType);
  }

  const rows = db
    .prepare(
      `SELECT l.*, u.display_name AS operator_name,
              CASE WHEN l.item_type = 'material'
                   THEN (SELECT name FROM materials m WHERE m.id = l.item_id)
                   ELSE (SELECT name FROM products p WHERE p.id = l.item_id) END AS item_name
         FROM stock_ledger l LEFT JOIN users u ON u.id = l.operator_id
        WHERE ${cond.join(' AND ')}
        ORDER BY l.created_at DESC, l.id DESC
        LIMIT ? OFFSET ?`,
    )
    .all(...params, pageSize, offset) as any[];

  const total = countRows(`stock_ledger l`, cond.join(' AND '), params);
  okList(res, maskList(rows, { canViewPrice: canViewPrice(req.ctx!) }), total);
});
