import { summarize } from '../../../../shared/enums.js';
import { PO_STATUS, type PoStatus } from '../../../../shared/enums.js';
import { db } from '../../db/index.js';

export interface PendingItem {
  materialId: number;
  materialCode: string;
  materialName: string;
  spec?: string;
  unit: string;
  orderQty: number;
  receivedQty: number;
  pendingQty: number;
  price: number;
}

/** 订单未入库明细，供「去入库」预填（需求 4.1 参数透传） */
export function pendingItemsOf(orderId: number): PendingItem[] {
  const rows = db
    .prepare(
      `SELECT i.material_id, i.qty, i.received_qty, i.price,
              m.code, m.name, m.spec, m.unit
         FROM purchase_order_items i JOIN materials m ON m.id = i.material_id
        WHERE i.order_id = ?`,
    )
    .all(orderId) as any[];

  return rows
    .map((r) => ({
      materialId: r.material_id,
      materialCode: r.code,
      materialName: r.name,
      spec: r.spec,
      unit: r.unit,
      orderQty: Number(r.qty),
      receivedQty: Number(r.received_qty),
      pendingQty: Math.max(0, Number(r.qty) - Number(r.received_qty)),
      price: Number(r.price ?? 0),
    }))
    .filter((r) => r.pendingQty > 0);
}

export function hasPending(orderId: number): boolean {
  return pendingItemsOf(orderId).length > 0;
}

/** 采购摘要：多项时统一为「A、B等N项」（需求 4.4） */
export function buildSummary(names: string[]): string {
  return summarize(names);
}

export function materialNames(ids: number[]): string[] {
  if (ids.length === 0) return [];
  const ph = ids.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT id, name FROM materials WHERE id IN (${ph}) ORDER BY id`)
    .all(...ids) as { id: number; name: string }[];
  const map = new Map(rows.map((r) => [r.id, r.name]));
  return ids.map((id) => map.get(id) ?? `未知物料#${id}`);
}

/** 刷新订单状态：明细全部入库 -> 已完成；否则进行中 */
export function refreshOrderStatus(orderId: number): PoStatus {
  const order = db.prepare(`SELECT * FROM purchase_orders WHERE id = ?`).get(orderId) as any;
  if (!order) return PO_STATUS.ONGOING;
  if (order.status === PO_STATUS.CANCELLED || order.status === PO_STATUS.CLOSED) {
    return order.status as PoStatus;
  }

  const row = db
    .prepare(
      `SELECT COALESCE(SUM(qty),0) AS total, COALESCE(SUM(received_qty),0) AS done
         FROM purchase_order_items WHERE order_id = ?`,
    )
    .get(orderId) as { total: number; done: number };

  const next: PoStatus =
    row.total > 0 && row.done >= row.total ? PO_STATUS.DONE : PO_STATUS.ONGOING;
  db.prepare(`UPDATE purchase_orders SET status = ?, updated_at = ? WHERE id = ?`).run(
    next,
    new Date().toISOString(),
    orderId,
  );
  return next;
}

/**
 * 父单状态由子单聚合。
 * 全部完成 -> 已完成；全部撤销 -> 已撤销；否则进行中。
 */
export function syncParentStatus(parentOrderNo: string): void {
  if (!parentOrderNo) return;
  const parent = db
    .prepare(`SELECT id FROM purchase_orders WHERE order_no = ?`)
    .get(parentOrderNo) as any;
  if (!parent) return;

  const children = db
    .prepare(`SELECT status FROM purchase_orders WHERE parent_order_no = ?`)
    .all(parentOrderNo) as { status: string }[];
  if (children.length === 0) return;

  let next: PoStatus = PO_STATUS.ONGOING;
  if (children.every((c) => c.status === PO_STATUS.DONE)) next = PO_STATUS.DONE;
  else if (children.every((c) => c.status === PO_STATUS.CANCELLED)) next = PO_STATUS.CANCELLED;

  db.prepare(`UPDATE purchase_orders SET status = ?, updated_at = ? WHERE id = ?`).run(
    next,
    new Date().toISOString(),
    parent.id,
  );
}
