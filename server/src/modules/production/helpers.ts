import { db } from '../../db/index.js';
import { BizError } from '../../core/errors.js';
import { expandBom } from '../../core/bom.js';
import { stockOfWarehouse } from '../../core/warehouse.js';

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
  warehouseId?: number | null,
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
    // 传了仓就按该仓存量判缺料，没传按总库存（老调用方行为不变）
    const available = warehouseId
      ? stockOfWarehouse('material', materialId, Number(warehouseId))
      : Number(m?.current_stock ?? 0);
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

/**
 * 工单「可领上限」= 计划量 − 累计有效领料 − 累计有效退料 − 领料来源不良品出库。
 * 与可入库产能口径（refreshWorkOrder 的 issued）同源，三者都是「领了不会再变合格成品」的核减项。
 * 领料量累计不得超过计划量，超量领料会在源头被拦，从而杜绝 issued>plan、损耗虚高、入库报错。
 * 返回 ≤0 表示已领满 / 已超，不可再领。
 */
export function issuableCeiling(woId: number): number {
  const wo = db.prepare(`SELECT * FROM work_orders WHERE id = ?`).get(woId) as any;
  if (!wo) return 0;
  const plan = Number(wo.plan_qty) || 0;
  const issuedGross = issuedQtyOf(woId);
  const returned = returnedQtyOf(woId);
  const defectiveOut = defectiveOutQtyOf(woId);
  const issued = Math.max(0, issuedGross - returned - defectiveOut);
  return Math.max(0, plan - issued);
}

/** 累计有效退料产量（退回已领未用的部分，从领料产量中核减） */
export function returnedQtyOf(woId: number): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(return_qty), 0) AS s FROM material_returns
        WHERE wo_id = ? AND status = '有效'`,
    )
    .get(woId) as { s: number };
  return Number(row.s);
}

/**
 * 累计「领料来源」不良品出库量（按对应成品数量，从可入库产能中核减）。
 *
 * 口径说明：只有 source_type='issue' 的不良品出库才联动工单产能——
 * 它代表这批料已领、投产中识别为不良，不能计入合格产出；
 * 手工拣选（source_type='manual'）不联动，它本就是坏料移出库存。
 * 这样「领 100、退 0、不良 2」后可入库余量收敛到 98，账实一致。
 */
export function defectiveOutQtyOf(woId: number): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(do.produce_qty), 0) AS s
         FROM defective_outs do
         JOIN material_issues i ON i.id = do.issue_id
        WHERE i.wo_id = ? AND do.source_type = 'issue' AND do.status = '有效'`,
    )
    .get(woId) as { s: number };
  return Number(row.s);
}

/**
 * 重算工单领料/入库合计与状态。
 *
 * 可入库产能口径 = 累计有效领料 − 累计有效退料 − 领料来源不良品出库：
 *  - 退料：领了但没投产、已原路退回；
 *  - 领料来源不良品出库：投产后识别为不良，不能计入合格产出。
 * 两者都要从可入库产能中扣除，否则领 100、退 2（其中不良 1）后仍能入库 100，账实不符。
 */
export function refreshWorkOrder(woId: number): void {
  const wo = db.prepare(`SELECT * FROM work_orders WHERE id = ?`).get(woId) as any;
  if (!wo) return;

  const issuedGross = issuedQtyOf(woId);
  const returned = returnedQtyOf(woId);
  const defectiveOut = defectiveOutQtyOf(woId);
  const issued = Math.max(0, issuedGross - returned - defectiveOut);
  const receivedRow = db
    .prepare(
      `SELECT COALESCE(SUM(i.qty), 0) AS s
         FROM product_receipt_items i
         JOIN product_receipts r ON r.id = i.receipt_id
        WHERE r.wo_id = ? AND r.status = '有效' AND i.product_id = ?`,
    )
    .get(woId, wo.product_id) as { s: number };
  const received = Number(receivedRow.s);

  // 损耗 = 累计领料净量 − 累计入库量（投产损耗口径）。
  // 因领料入口已做「累计领料 ≤ 计划量」上限校验（issuableCeiling），
  // issued 永远 ≤ plan，超量领料无法进入本计算，损耗不会因超领虚高。
  const loss = Math.max(0, issued - received);
  // 完工判定：入库量 ≥ 计划量即判已完工（不要求领料；「直接扣料/不扣料」入库同样计满计划）。
  const status =
    Number(wo.plan_qty) > 0 && received >= Number(wo.plan_qty)
      ? '已完工'
      : issued > 0 || received > 0
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
