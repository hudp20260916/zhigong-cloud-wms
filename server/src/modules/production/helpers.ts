import { db } from '../../db/index.js';
import { BizError } from '../../core/errors.js';
import { expandBom } from '../../core/bom.js';

/** 装箱规格解析：「6台/箱」-> 6；无法解析时按 1 处理 */
export function parsePerCarton(packingSpec?: string | null): number {
  if (!packingSpec) return 0;
  const m = String(packingSpec).match(/(\d+(?:\.\d+)?)/);
  const n = m ? Number(m[1]) : 0;
  return n > 0 ? n : 0;
}

/** 外箱需求量：按装箱规格向上取整 */
export function cartonQtyOf(product: any, qty: number): number {
  if (!product?.carton_material_id) return 0;
  const per = parsePerCarton(product.packing_spec);
  if (per <= 0) return 0;
  return Math.ceil(qty / per);
}

export interface ShortageDetail {
  materialId: number;
  materialName: string;
  unit: string;
  need: number;
  available: number;
  shortage: number;
}

export interface ProductShortage {
  productId: number;
  productName: string;
  details: ShortageDetail[];
}

/**
 * 按成品 BOM 计算子物料需求并逐个校验库存。
 * 多品同时入库时按成品独立判定，缺料的成品单独收集，不影响其他成品（需求 4.7）
 */
export function checkProductMaterials(
  productId: number,
  qty: number,
  cartonQty: number,
): { ok: true; requirements: Map<number, number> } | { ok: false; shortage: ProductShortage } {
  const product = db.prepare(`SELECT * FROM products WHERE id = ?`).get(productId) as any;
  if (!product) throw new BizError(404, 'PRODUCT_NOT_FOUND', '成品档案不存在');

  const requirements = expandBom(productId, qty);
  if (cartonQty > 0 && product.carton_material_id) {
    requirements.set(
      product.carton_material_id,
      (requirements.get(product.carton_material_id) ?? 0) + cartonQty,
    );
  }

  const details: ShortageDetail[] = [];
  for (const [materialId, need] of requirements) {
    const m = db.prepare(`SELECT name, unit, current_stock FROM materials WHERE id = ?`).get(materialId) as
      | { name: string; unit: string; current_stock: number }
      | undefined;
    const available = m?.current_stock ?? 0;
    if (available < need) {
      details.push({
        materialId,
        materialName: m?.name ?? `#${materialId}`,
        unit: m?.unit ?? '',
        need: round(need),
        available: round(available),
        shortage: round(need - available),
      });
    }
  }

  if (details.length > 0) {
    return { ok: false, shortage: { productId, productName: product.name, details } };
  }
  return { ok: true, requirements };
}

/** 工单可入库余量 = 累计有效领料产量 - 已入库量（需求 3.5.2） */
export function availableToReceive(woId: number): number {
  const wo = db.prepare(`SELECT * FROM work_orders WHERE id = ?`).get(woId) as any;
  if (!wo) return 0;
  return Math.max(0, Number(wo.issued_qty) - Number(wo.received_qty));
}

/** 累计有效领料产量 */
export function issuedQtyOf(woId: number): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(produce_qty), 0) AS s FROM material_issues
        WHERE wo_id = ? AND status = '有效'`,
    )
    .get(woId) as { s: number };
  return Number(row.s);
}

/** 重算工单领料/入库合计与状态 */
export function refreshWorkOrder(woId: number): void {
  const wo = db.prepare(`SELECT * FROM work_orders WHERE id = ?`).get(woId) as any;
  if (!wo) return;

  const issued = issuedQtyOf(woId);
  const receivedRow = db
    .prepare(
      `SELECT COALESCE(SUM(i.qty), 0) AS s
         FROM product_receipt_items i
         JOIN product_receipts r ON r.id = i.receipt_id
        WHERE r.wo_id = ? AND r.status = '有效' AND i.product_id = ?`,
    )
    .get(woId, wo.product_id) as { s: number };
  const received = Number(receivedRow.s);

  const loss = Math.max(0, issued - received);
  const status =
    received >= Number(wo.plan_qty) && Number(wo.plan_qty) > 0
      ? '已完工'
      : issued > 0
        ? '生产中'
        : received > 0
          ? '生产中'
          : '未开工';

  db.prepare(
    `UPDATE work_orders SET issued_qty = ?, received_qty = ?, loss_qty = ?, status = ?, updated_at = ?
      WHERE id = ?`,
  ).run(issued, received, loss, status, new Date().toISOString(), woId);
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

export { round };
