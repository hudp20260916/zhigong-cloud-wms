import type { Direction, ItemType } from '../../../shared/enums.js';
import { db, nowIso } from '../db/index.js';
import { BizError } from './errors.js';
import { addWarehouseStock, resolveWarehouse, stockOfWarehouse, warehouseName } from './warehouse.js';

/**
 * 库存引擎 —— 全系统唯一允许变更库存的入口。
 *
 * 设计约束（需求 4.8 / 4.5）：
 *  1. 任何业务模块不得直接 UPDATE current_stock，必须调用 applyStock；
 *  2. 每次变动都会落一条原子流水，撤销 = 反向对冲，而不是删除记录；
 *  3. 汇总口径统一为 status='有效' AND is_reversal=0，
 *     因此被撤销的单据与撤销对冲行都不计入出入库净额；
 *  4. 入库类单据的 biz_no 一律留空，前端全链路看不到入库单号；
 *  5. 多仓库：每条流水都绑定一个仓（warehouse_id），
 *     数量校验与结存都按「该仓」计算，总库存由各仓相加得到。
 *     不传 warehouseId 时按品类默认仓兜底（物料→物料库、成品→成品库），老调用方无需改动。
 */

export interface LedgerEntry {
  itemType: ItemType;
  itemId: number;
  direction: Direction;
  qty: number;
  bizType: string;
  bizId?: number;
  /** 入库类单据禁止传入单号；出库类可传销售单号等 */
  bizNo?: string;
  unitPrice?: number;
  operatorId?: number;
  /**
   * 仓库 ID。不传 = 该品类的默认仓（物料→物料库、成品→成品库），
   * 老调用方一行都不用改即可向后兼容。
   */
  warehouseId?: number | null;
  /** 默认禁止负库存，个别场景（盘点调整）可显式放开 */
  allowNegative?: boolean;
  isReversal?: boolean;
  reversedLedgerId?: number;
  /** 盘点审核自身产生的调整流水需要放行，避免被盘点锁拦截 */
  allowDuringCheck?: boolean;
}

function tableOf(itemType: ItemType): 'materials' | 'products' {
  return itemType === 'material' ? 'materials' : 'products';
}

export function currentStockOf(itemType: ItemType, itemId: number): number {
  const row = db
    .prepare(`SELECT current_stock FROM ${tableOf(itemType)} WHERE id = ?`)
    .get(itemId) as { current_stock: number } | undefined;
  return row?.current_stock ?? 0;
}

/** 存在待审核盘点单时，被盘点对象禁止出入库 */
function assertNotChecking(itemType: ItemType, itemId: number): void {
  const hit = db
    .prepare(
      `SELECT 1 FROM stock_check_items ci
         JOIN stock_checks c ON c.id = ci.check_id
        WHERE c.status = '待审核' AND ci.item_type = ? AND ci.item_id = ?
        LIMIT 1`,
    )
    .get(itemType, itemId);
  if (hit) {
    throw new BizError(409, 'STOCK_CHECKING', '该物料/成品正在盘点中，出入库已锁定，请等待盘点审核完成');
  }
}

/** 批量应用库存变动，返回生成的流水 ID 列表。必须在事务内调用。 */
export function applyStock(entries: LedgerEntry[]): number[] {
  const ids: number[] = [];

  for (const e of entries) {
    if (!Number.isFinite(e.qty) || e.qty <= 0) {
      throw new BizError(400, 'BAD_QTY', `流水数量必须大于 0（${e.bizType}）`);
    }

    const table = tableOf(e.itemType);
    // 只有物料维护移动加权成本，成品不核算成本价
    const isMaterial = e.itemType === 'material';
    const row = db
      .prepare(`SELECT current_stock${isMaterial ? ', avg_cost' : ''} FROM ${table} WHERE id = ?`)
      .get(e.itemId) as { current_stock: number; avg_cost?: number } | undefined;

    if (!row) throw new BizError(404, 'ITEM_NOT_FOUND', '库存对象不存在，请检查档案');

    // 需求 3.7.2：盘点中锁定该对象的出入库
    if (!e.allowDuringCheck) assertNotChecking(e.itemType, e.itemId);

    // 仓库：不传就用该品类的默认仓，传了就校验存在 / 启用 / 品类匹配
    const whId = resolveWarehouse(e.itemType, e.warehouseId);

    // 数量校验与结存按「该仓」算；加权成本仍按对象总库存算（成本不随仓走）
    const before = stockOfWarehouse(e.itemType, e.itemId, whId);
    const totalBefore = Number(row.current_stock ?? 0);
    const avgCost = row.avg_cost ?? 0;
    const delta = e.direction === 'in' ? e.qty : -e.qty;
    const after = round(before + delta);

    if (after < 0 && !e.allowNegative) {
      throw new BizError(
        409,
        'STOCK_SHORTAGE',
        `仓库「${warehouseName(whId)}」库存不足：当前可用 ${round(before)}，本次需出库 ${round(e.qty)}`,
        {
          itemType: e.itemType,
          itemId: e.itemId,
          warehouseId: whId,
          available: round(before),
          required: e.qty,
        },
      );
    }

    // 单价与移动加权成本：只有物料维护加权成本，成品暂不核算成本
    let unitPrice = e.unitPrice ?? 0;
    let amount = 0;

    if (e.direction === 'in') {
      if (unitPrice <= 0 && !e.isReversal) unitPrice = 0;
      amount = round(unitPrice * e.qty);
      if (isMaterial && !e.isReversal && unitPrice > 0) {
        const newAvg =
          totalBefore + e.qty > 0
            ? (totalBefore * avgCost + e.qty * unitPrice) / (totalBefore + e.qty)
            : unitPrice;
        db.prepare(`UPDATE ${table} SET avg_cost = ? WHERE id = ?`).run(round(newAvg, 4), e.itemId);
      }
    } else {
      // 出库按当前加权成本计价，不改动加权成本
      if (unitPrice <= 0) unitPrice = avgCost;
      amount = round(unitPrice * e.qty);
    }

    // 分仓库存与总库存一起动 —— 全系统唯一入口
    addWarehouseStock(e.itemType, e.itemId, whId, delta);

    const info = db
      .prepare(
        `INSERT INTO stock_ledger
           (item_type, item_id, direction, qty, biz_type, biz_id, biz_no,
            unit_price, amount, balance_after, status, is_reversal, reversed_ledger_id,
            operator_id, warehouse_id, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        e.itemType,
        e.itemId,
        e.direction,
        e.qty,
        e.bizType,
        e.bizId ?? null,
        e.bizNo ?? null,
        round(unitPrice, 4),
        amount,
        after,
        '有效',
        e.isReversal ? 1 : 0,
        e.reversedLedgerId ?? null,
        e.operatorId ?? null,
        whId,
        nowIso(),
      );

    ids.push(Number(info.lastInsertRowid));
  }

  return ids;
}

/**
 * 撤销某笔业务产生的全部库存影响。
 * 原流水标记「已撤销」，另写一条反向对冲流水（is_reversal=1），库存回到变动前。
 */
export function reverseStock(bizType: string, bizId: number, operatorId?: number): number {
  const rows = db
    .prepare(
      `SELECT * FROM stock_ledger
        WHERE biz_type = ? AND biz_id = ? AND status = '有效' AND is_reversal = 0`,
    )
    .all(bizType, bizId) as any[];

  if (rows.length === 0) return 0;

  const entries: LedgerEntry[] = rows.map((r) => ({
    itemType: r.item_type as ItemType,
    itemId: r.item_id,
    direction: (r.direction === 'in' ? 'out' : 'in') as Direction,
    qty: r.qty,
    bizType: `撤销-${bizType}`,
    bizId: r.biz_id,
    bizNo: undefined,
    unitPrice: r.unit_price,
    operatorId,
    // 撤销必须回到原流水所在的仓，否则会把库存挪到默认仓去
    warehouseId: r.warehouse_id ?? null,
    allowNegative: true, // 撤销是回滚，理论上不会造成负库存
    isReversal: true,
    reversedLedgerId: r.id,
  }));

  const ids = applyStock(entries);

  const mark = db.prepare(`UPDATE stock_ledger SET status = '已撤销' WHERE id = ?`);
  for (const r of rows) mark.run(r.id);

  return ids.length;
}

export interface StockSummary {
  initialQty: number;
  inQty: number;
  outQty: number;
  balanceQty: number;
}

/**
 * 出入库净额统计。撤销记录不计入汇总（需求 4.8）。
 * 当前结存 = 期初库存 + 入库合计 - 出库合计
 */
export function stockSummary(
  itemType: ItemType,
  itemId: number,
  range?: { from?: string; to?: string; warehouseId?: number | null },
): StockSummary {
  const where: string[] = [
    `item_type = ?`,
    `item_id = ?`,
    `status = '有效'`,
    `is_reversal = 0`,
  ];
  const params: any[] = [itemType, itemId];

  // 传了仓库就只统计这个仓的流水（老流水 warehouse_id 已回填，不会漏）
  if (range?.warehouseId) {
    where.push(`IFNULL(warehouse_id, 0) = ?`);
    params.push(Number(range.warehouseId));
  }
  if (range?.from) {
    where.push(`created_at >= ?`);
    params.push(`${range.from}T00:00:00.000Z`);
  }
  if (range?.to) {
    where.push(`created_at <= ?`);
    params.push(`${range.to}T23:59:59.999Z`);
  }
  const cond = where.join(' AND ');

  const agg = (extra: string) => {
    const row = db
      .prepare(`SELECT COALESCE(SUM(qty), 0) AS s FROM stock_ledger WHERE ${cond} ${extra}`)
      .get(...params) as { s: number };
    return row.s;
  };

  const initialWhSql = range?.warehouseId ? `AND IFNULL(warehouse_id, 0) = ?` : '';
  const initialParams: any[] = [itemType, itemId];
  if (range?.warehouseId) initialParams.push(Number(range.warehouseId));

  const initial = db
    .prepare(
      `SELECT COALESCE(SUM(qty), 0) AS s FROM stock_ledger
        WHERE item_type = ? AND item_id = ? AND biz_type = '期初库存'
          AND status = '有效' AND is_reversal = 0 ${initialWhSql}`,
    )
    .get(...initialParams) as { s: number };

  const inQty = agg(`AND direction = 'in' AND biz_type <> '期初库存'`);
  const outQty = agg(`AND direction = 'out'`);

  return {
    initialQty: round(initial.s),
    inQty: round(inQty),
    outQty: round(outQty),
    balanceQty: round(initial.s + inQty - outQty),
  };
}

function round(n: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round((Number(n) + Number.EPSILON) * f) / f;
}

export { round };
