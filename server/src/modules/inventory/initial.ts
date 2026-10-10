import type { ItemType } from '../../../../shared/enums.js';
import { BIZ_TYPE } from '../../../../shared/enums.js';
import { db } from '../../db/index.js';
import { Err } from '../../core/errors.js';
import { applyStock } from '../../core/ledger.js';

/**
 * 期初库存「设定」（不是累加）。
 *
 * 拆出来是为了让「期初库存页面录入」与「Excel 批量导入」共用同一套语义，
 * 避免两处各写一遍导致台账与 current_stock 不一致。
 *
 * 做法：先把该对象已有的期初流水按反方向回滚并删除，再写入新的期初流水。
 * 这样台账中期初合计恒等于录入值，库存余额也同步。
 */
export function setInitialStock(
  itemType: ItemType,
  itemId: number,
  qty: number,
  price: number | undefined,
  operatorId: number,
): void {
  const table = itemType === 'material' ? 'materials' : 'products';
  const label = itemType === 'material' ? '物料' : '成品';

  const row = db.prepare(`SELECT current_stock FROM ${table} WHERE id = ?`).get(itemId) as
    | { current_stock: number }
    | undefined;
  if (!row) throw Err.notFound(`${label}档案不存在`);

  let stock = Number(row.current_stock);

  const olds = db
    .prepare(
      `SELECT * FROM stock_ledger
        WHERE item_type = ? AND item_id = ? AND biz_type = ? AND status = '有效' AND is_reversal = 0`,
    )
    .all(itemType, itemId, BIZ_TYPE.INITIAL) as any[];

  for (const old of olds) {
    const back = old.direction === 'in' ? -Number(old.qty) : Number(old.qty);
    stock += back;
  }
  db.prepare(`DELETE FROM stock_ledger WHERE item_type = ? AND item_id = ? AND biz_type = ?`).run(
    itemType,
    itemId,
    BIZ_TYPE.INITIAL,
  );
  db.prepare(`UPDATE ${table} SET current_stock = ? WHERE id = ?`).run(stock, itemId);

  if (qty > 0) {
    applyStock([
      {
        itemType,
        itemId,
        direction: 'in',
        qty,
        bizType: BIZ_TYPE.INITIAL,
        unitPrice: price ?? 0,
        operatorId,
        allowNegative: true,
      },
    ]);
    if (itemType === 'material' && (price ?? 0) > 0) {
      db.prepare(`UPDATE materials SET avg_cost = ? WHERE id = ?`).run(price, itemId);
    }
  }
}
