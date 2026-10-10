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
}
