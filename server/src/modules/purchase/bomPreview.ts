import { Router } from 'express';
import { db } from '../../db/index.js';
import { Err } from '../../core/errors.js';
import { expandBomDeep } from '../../core/bom.js';
import { requirePerm } from '../../middleware/auth.js';
import { ok } from '../../shared/http.js';

/**
 * 采购订单「按主产品 BOM 采购」的物料需求测算（只读）。
 *
 * 一条公式贯穿全接口：
 *   需求量 requireQty   = 单位用量 qtyPerUnit × 计划产量 planQty
 *   已占用量 occupiedQty = 未完工工单**未领料部分**对该物料的需求（已许给工单，不能再算可用）
 *   可用库存 availableQty = max(0, 现有库存 − 已占用量)
 *   缺料数量 shortageQty = max(0, 需求量 − 可用库存)      ← 库存充足时为 0，不会出负数
 *   采购数量 purchaseQty = 取整(缺料数量)                  ← 由前端在点击「计算」后回填
 *
 * 为什么「已占用量」不含采购在途：在途采购是**补充**项，把它算成占用会让可用库存变小、
 * 从而重复下单。所以 inTransitQty 单独返回，只做展示，不进公式。
 */

export const purchaseBomPreviewRouter = Router();

/** 离散计量单位：采购数量向上取整到整数（不能买 3.2 个）；其余保留 2 位小数 */
const DISCRETE_UNITS = new Set([
  '个', '件', '只', '支', '块', '台', '套', '张', '根', '条', '把', '片', 'pcs', 'PCS', 'PC', 'EA',
]);

/** 采购数量取整规则：离散单位向上取整到整数，其余按 2 位小数四舍五入 */
export function purchaseQtyOf(shortage: number, unit: string): number {
  if (!Number.isFinite(shortage) || shortage <= 0) return 0;
  if (DISCRETE_UNITS.has(String(unit ?? '').trim())) return Math.ceil(shortage - 1e-9);
  return Math.round(shortage * 100) / 100;
}

function round2(n: number): number {
  return Math.round((Number.isFinite(n) ? n : 0) * 100) / 100;
}

/**
 * 已占用量：未完工工单尚未领料的部分对各物料的需求量。
 *
 * 口径：工单已领的料（issued_qty）已经出库、已体现在「现有库存」里，不能重复占用；
 * 只有「计划量 − 已领量」这部分还没出库、但已经许给这张工单，才叫占用。
 */
function occupiedQtyMap(): Map<number, number> {
  const acc = new Map<number, number>();
  const wos = db
    .prepare(
      `SELECT id, product_id, plan_qty, issued_qty, status
         FROM work_orders
        WHERE status <> '已完工'`,
    )
    .all() as { id: number; product_id: number; plan_qty: number; issued_qty: number; status: string }[];

  for (const wo of wos) {
    const remain = Number(wo.plan_qty ?? 0) - Number(wo.issued_qty ?? 0);
    if (remain <= 0) continue;
    try {
      // 与需求量同口径（都走多级展开），避免「需求按原材料、占用按半成品」对不上账
      for (const [mid, qty] of expandBomDeep(wo.product_id, remain)) {
        acc.set(mid, (acc.get(mid) ?? 0) + qty);
      }
    } catch {
      // 个别工单的 BOM 有循环引用时，跳过它、不影响整单测算（占用少算比整体报错好）
    }
  }
  return acc;
}

/** 采购在途未入库：按物料汇总（qty − received_qty），仅展示用 */
function inTransitQtyMap(): Map<number, number> {
  const acc = new Map<number, number>();
  const rows = db
    .prepare(
      `SELECT i.material_id, i.qty, i.received_qty
         FROM purchase_order_items i
         JOIN purchase_orders o ON o.id = i.order_id
        WHERE o.status NOT IN ('已完成', '已撤销', '已关闭')`,
    )
    .all() as { material_id: number; qty: number; received_qty: number }[];
  for (const r of rows) {
    const left = Number(r.qty ?? 0) - Number(r.received_qty ?? 0);
    if (left <= 0) continue;
    acc.set(r.material_id, (acc.get(r.material_id) ?? 0) + left);
  }
  return acc;
}

/**
 * GET /purchase/orders/bom-preview?productId=&planQty=
 *
 * 必填 productId；planQty 允许为空 / 0（此时只返回 BOM 结构与单位用量，需求量与采购数量均为 0），
 * 这样前端「先选品、后填产量」的顺序也能正常展示。
 */
purchaseBomPreviewRouter.get('/', requirePerm('purchase.order.view'), (req, res) => {
  const productId = Number(req.query.productId);
  if (!productId) throw Err.badRequest('请先选择主产品');

  const product = db.prepare(`SELECT * FROM products WHERE id = ?`).get(productId) as any;
  if (!product) throw Err.notFound('成品档案不存在');

  const rawQty = Number(req.query.planQty);
  // 边界：计划产量为空 / 0 / 负数 / 非数字 → 一律按 0 处理，需求量与采购数量为 0，但 BOM 行照样展开
  const planQty = Number.isFinite(rawQty) && rawQty > 0 ? rawQty : 0;

  // 单位用量：按 1 台成品展开（多级 + 虚拟件穿透 + 同物料跨层级累加合并）
  let unitUsage: Map<number, number>;
  let bomError: string | null = null;
  try {
    unitUsage = expandBomDeep(productId, 1);
  } catch (e: any) {
    unitUsage = new Map();
    bomError = e?.message ?? 'BOM 展开失败';
  }

  // 外箱耗材：与生产领料同口径（按装箱规格向上取整数箱），非线性，必须用真实产量算
  const cartonMaterialId = product.carton_material_id ? Number(product.carton_material_id) : 0;
  let cartonQty = 0;
  if (cartonMaterialId && planQty > 0) {
    const per = parsePerCartonLocal(product.packing_spec);
    if (per > 0) cartonQty = Math.ceil(planQty / per);
  }

  // 是否真的发生了跨级下钻：展开结果里出现了「不在顶层 BOM 行里」的物料，
  // 说明至少有一层子件被继续展开过（否则只是单层 BOM，前端没必要打「多级」标记）。
  let deepExpanded = false;
  try {
    const direct = new Set(
      (
        db.prepare(`SELECT material_id FROM bom_items WHERE product_id = ?`).all(productId) as {
          material_id: number;
        }[]
      ).map((r) => Number(r.material_id)),
    );
    for (const mid of unitUsage.keys()) {
      if (!direct.has(mid)) {
        deepExpanded = true;
        break;
      }
    }
  } catch {
    /* 查不到顶层行就算单级，不影响测算结果 */
  }

  const occupied = occupiedQtyMap();
  const inTransit = inTransitQtyMap();
  const stockOf = db.prepare(`SELECT code, name, spec, unit, current_stock, avg_cost FROM materials WHERE id = ?`);

  const ids = new Set<number>([...unitUsage.keys()]);
  if (cartonQty > 0 && cartonMaterialId) ids.add(cartonMaterialId);

  const items = [...ids].map((materialId) => {
    const m = stockOf.get(materialId) as any;
    const unit = String(m?.unit ?? '');
    const qtyPerUnit = round2(unitUsage.get(materialId) ?? 0);
    const requireQty = round2(qtyPerUnit * planQty + (materialId === cartonMaterialId ? cartonQty : 0));
    const stock = round2(Number(m?.current_stock ?? 0));
    const occupiedQty = round2(occupied.get(materialId) ?? 0);
    // 可用库存不允许为负：库存被占超了就是 0，不会出现「负可用」把缺料算多的情况
    const availableQty = round2(Math.max(0, stock - occupiedQty));
    const shortageQty = round2(Math.max(0, requireQty - availableQty));
    return {
      materialId,
      materialCode: m?.code ?? '',
      materialName: m?.name ?? `#${materialId}`,
      spec: m?.spec ?? '',
      unit,
      /** 单件成品耗用量（多级展开汇总后） */
      qtyPerUnit,
      /** 是否为外箱耗材行（非线性取整，不能按单位用量线性换算） */
      isCarton: materialId === cartonMaterialId && cartonQty > 0,
      requireQty,
      stock,
      occupiedQty,
      availableQty,
      shortageQty,
      /** 建议采购数量：取整后的缺料数量（前端点「计算」后回填到采购数量） */
      purchaseQty: purchaseQtyOf(shortageQty, unit),
      /** 采购在途：仅展示，不参与上面的任何计算 */
      inTransitQty: round2(inTransit.get(materialId) ?? 0),
      price: round2(Number(m?.avg_cost ?? 0)),
      enough: shortageQty <= 0,
    };
  });

  items.sort((a, b) => String(a.materialCode).localeCompare(String(b.materialCode), 'zh-CN'));

  ok(res, {
    productId,
    productCode: product.code ?? '',
    productName: product.name ?? '',
    productUnit: product.unit ?? '',
    bomVersion: product.bom_version ?? '',
    planQty,
    /** 该 BOM 是否发生了跨级下钻（子件本身是成品且有 BOM，被继续展开到最底层） */
    deepExpanded,
    bomMissing: unitUsage.size === 0 && !cartonQty,
    bomError,
    cartonQty,
    items,
    shortageCount: items.filter((i) => !i.enough).length,
  });
});

/** 装箱规格解析（与生产侧一致）："20台/箱" / "20" → 20 */
function parsePerCartonLocal(spec: any): number {
  if (spec == null) return 0;
  const m = /(\d+(?:\.\d+)?)/.exec(String(spec));
  return m ? Number(m[1]) : 0;
}
