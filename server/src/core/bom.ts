import { db } from '../db/index.js';
import { BizError } from './errors.js';

/**
 * BOM 展开。
 * 需求 5.7 / 3.5.2：虚拟件需穿透到实阶物料，
 * 即虚拟件本身不参与库存扣减，展开为其构成的子物料。
 */

export interface BomLine {
  materialId: number;
  materialCode: string;
  materialName: string;
  spec?: string;
  unit: string;
  qtyPerUnit: number;
  requireQty: number;
  isVirtual: boolean;
}

const MAX_DEPTH = 8;

/** 展开成品 BOM 到实阶物料，按物料合并需求量 */
export function expandBom(
  productId: number,
  planQty: number,
  opts: { includeVirtual?: boolean } = {},
): Map<number, number> {
  const result = new Map<number, number>();
  walk(productId, planQty, 1, result, new Set(), opts.includeVirtual ?? false);
  return result;
}

function walk(
  productId: number,
  qty: number,
  depth: number,
  acc: Map<number, number>,
  visited: Set<string>,
  includeVirtual: boolean,
): void {
  if (depth > MAX_DEPTH) throw new BizError(400, 'BOM_TOO_DEEP', 'BOM 层级过深，请检查虚拟件配置是否存在循环引用');

  const lines = db
    .prepare(
      `SELECT b.material_id, b.qty_per_unit, m.is_virtual
         FROM bom_items b JOIN materials m ON m.id = b.material_id
        WHERE b.product_id = ?`,
    )
    .all(productId) as { material_id: number; qty_per_unit: number; is_virtual: number }[];

  for (const line of lines) {
    const need = line.qty_per_unit * qty;
    if (line.is_virtual === 1 && !includeVirtual) {
      const key = `v${line.material_id}`;
      if (visited.has(key)) {
        throw new BizError(400, 'BOM_CYCLE', '虚拟件配置存在循环引用，无法展开');
      }
      visited.add(key);
      walkVirtual(line.material_id, need, depth + 1, acc, visited);
      visited.delete(key);
    } else {
      acc.set(line.material_id, (acc.get(line.material_id) ?? 0) + need);
    }
  }
}

function walkVirtual(
  materialId: number,
  qty: number,
  depth: number,
  acc: Map<number, number>,
  visited: Set<string>,
): void {
  if (depth > MAX_DEPTH) throw new BizError(400, 'BOM_TOO_DEEP', '虚拟件层级过深，请检查是否存在循环引用');

  const children = db
    .prepare(
      `SELECT v.child_material_id, v.qty_per_unit, m.is_virtual
         FROM virtual_bom_items v JOIN materials m ON m.id = v.child_material_id
        WHERE v.parent_material_id = ?`,
    )
    .all(materialId) as { child_material_id: number; qty_per_unit: number; is_virtual: number }[];

  if (children.length === 0) {
    // 未配置构成的虚拟件直接按自身扣减，避免静默丢失需求
    acc.set(materialId, (acc.get(materialId) ?? 0) + qty);
    return;
  }

  for (const child of children) {
    const need = child.qty_per_unit * qty;
    if (child.is_virtual === 1) {
      const key = `v${child.child_material_id}`;
      if (visited.has(key)) throw new BizError(400, 'BOM_CYCLE', '虚拟件配置存在循环引用，无法展开');
      visited.add(key);
      walkVirtual(child.child_material_id, need, depth + 1, acc, visited);
      visited.delete(key);
    } else {
      acc.set(child.child_material_id, (acc.get(child.child_material_id) ?? 0) + need);
    }
  }
}

/* ============================================================
   多级 BOM 递归展开（采购测算专用，expandBomDeep）
   ============================================================ */

/** 「物料编码 == 成品编码」即视为同一件东西：用于把半成品子件继续往下展开 */
const productIdByCodeCache = new Map<string, number | null>();

function subProductIdOf(materialId: number): number | null {
  const row = db
    .prepare(`SELECT m.code FROM materials m WHERE m.id = ?`)
    .get(materialId) as { code: string } | undefined;
  if (!row?.code) return null;
  const code = row.code;
  if (productIdByCodeCache.has(code)) return productIdByCodeCache.get(code) ?? null;
  const p = db.prepare(`SELECT id FROM products WHERE code = ?`).get(code) as { id: number } | undefined;
  const v = p?.id ?? null;
  productIdByCodeCache.set(code, v);
  return v;
}

function hasBomLines(productId: number): boolean {
  const r = db
    .prepare(`SELECT COUNT(*) AS c FROM bom_items WHERE product_id = ?`)
    .get(productId) as { c: number };
  return Number(r?.c ?? 0) > 0;
}

/** 清缓存：档案改了编码或 BOM 后，下一次测算要重新匹配（避免算到旧的层级关系） */
export function clearBomDeepCache(): void {
  productIdByCodeCache.clear();
}

function consumeMaterial(
  materialId: number,
  need: number,
  isVirtual: boolean,
  depth: number,
  acc: Map<number, number>,
  visited: Set<string>,
): void {
  // 虚拟件：穿透为构成物料；没配构成的虚拟件按自身计入，避免需求静默丢失
  if (isVirtual) {
    const key = `v${materialId}`;
    if (visited.has(key)) throw new BizError(400, 'BOM_CYCLE', '虚拟件配置存在循环引用，无法展开');
    visited.add(key);
    const children = db
      .prepare(
        `SELECT v.child_material_id, v.qty_per_unit, m.is_virtual
           FROM virtual_bom_items v JOIN materials m ON m.id = v.child_material_id
          WHERE v.parent_material_id = ?`,
      )
      .all(materialId) as { child_material_id: number; qty_per_unit: number; is_virtual: number }[];

    if (children.length === 0) {
      acc.set(materialId, (acc.get(materialId) ?? 0) + need);
    } else {
      for (const c of children) {
        consumeMaterial(c.child_material_id, c.qty_per_unit * need, c.is_virtual === 1, depth + 1, acc, visited);
      }
    }
    visited.delete(key);
    return;
  }

  // 普通子件：若它本身还是个成品且其下有 BOM，就继续往下钻到最底层原材料
  const sub = subProductIdOf(materialId);
  if (sub && hasBomLines(sub)) {
    const key = `p${sub}`;
    if (visited.has(key)) throw new BizError(400, 'BOM_CYCLE', 'BOM 配置存在循环引用（子件递归引用了自身），无法展开');
    visited.add(key);
    walkDeep(sub, need, depth + 1, acc, visited);
    visited.delete(key);
    return;
  }

  acc.set(materialId, (acc.get(materialId) ?? 0) + need);
}

function walkDeep(
  productId: number,
  qty: number,
  depth: number,
  acc: Map<number, number>,
  visited: Set<string>,
): void {
  if (depth > MAX_DEPTH) throw new BizError(400, 'BOM_TOO_DEEP', 'BOM 层级过深，请检查是否存在循环引用');

  const lines = db
    .prepare(
      `SELECT b.material_id, b.qty_per_unit, m.is_virtual
         FROM bom_items b JOIN materials m ON m.id = b.material_id
        WHERE b.product_id = ?`,
    )
    .all(productId) as { material_id: number; qty_per_unit: number; is_virtual: number }[];

  for (const line of lines) {
    consumeMaterial(line.material_id, line.qty_per_unit * qty, line.is_virtual === 1, depth, acc, visited);
  }
}

/**
 * 多级 BOM 展开（采购测算用）。
 *
 * 与 `expandBom` 的分工：
 * - `expandBom` 只穿透虚拟件，是**生产领料 / 直接扣料的库存口径**，任何改动都会影响已发生业务的账，
 *   因此保持不变、继续只服务生产。
 * - `expandBomDeep` 在虚拟件之外，再把「子件本身也是成品（物料编码 == 成品编码且其下还有 BOM）」
 *   继续往下钻到最底层原材料 —— 采购要按原材料下单，不能把半成品当原料买回来。
 *
 * ⚠️ products 与 materials 是两套独立主键、没有外键，这里按**编码相同**判定同一件东西。
 *    匹配不到就当叶子物料处理，不会报错也不会改变结果。
 *
 * 同一物料在多层级 / 多父件下重复出现时，在 acc 里**累加合并**（acc 按 materialId 聚合），
 * 所以返回的 Map 天然是「汇总后」的单位用量。
 *
 * @returns Map<materialId, 折算到 1 个根成品的用量>（qty 传 1 即为单位用量）
 */
export function expandBomDeep(productId: number, qty = 1): Map<number, number> {
  const acc = new Map<number, number>();
  walkDeep(productId, qty, 1, acc, new Set());
  return acc;
}

/** 取成品 BOM 明细（含虚拟件标记），用于档案维护界面展示 */
export function bomLinesOf(productId: number): BomLine[] {
  const rows = db
    .prepare(
      `SELECT b.material_id, b.qty_per_unit, m.code, m.name, m.spec, m.unit, m.is_virtual
         FROM bom_items b JOIN materials m ON m.id = b.material_id
        WHERE b.product_id = ? ORDER BY b.id`,
    )
    .all(productId) as any[];

  return rows.map((r) => ({
    materialId: r.material_id,
    materialCode: r.code,
    materialName: r.name,
    spec: r.spec,
    unit: r.unit,
    qtyPerUnit: r.qty_per_unit,
    requireQty: r.qty_per_unit,
    isVirtual: r.is_virtual === 1,
  }));
}

export function replaceBom(productId: number, lines: { materialId: number; qty: number }[]): void {
  db.prepare(`DELETE FROM bom_items WHERE product_id = ?`).run(productId);
  const ins = db.prepare(
    `INSERT INTO bom_items (product_id, material_id, qty_per_unit) VALUES (?, ?, ?)`,
  );
  for (const l of lines) ins.run(productId, l.materialId, l.qty);
  // BOM 变了，采购测算的「编码→成品」缓存可能失效（新增/改编码/拆层级），这里统一清掉
  clearBomDeepCache();
}
