import type { ItemType } from '../../../shared/enums.js';
import { db, nowIso } from '../db/index.js';
import { BizError } from './errors.js';

/**
 * 仓库领域服务 —— 多仓库改造后，所有「按仓」的读写都收口在这里。
 *
 * 三条口径（与平哥确认）：
 *  1. 真·分仓库存：每个对象在每个仓独立记数量（stock_warehouse），
 *     总库存仍放在 materials/products.current_stock，二者恒等；
 *  2. 仓与品类绑定：material 仓只收物料、product 仓只收成品、main（主仓库）两类都收；
 *  3. 向后兼容：任何地方没传 warehouseId，都按「该品类的默认仓」兜底，
 *     老单据 / 老流水 / 老接口调用方一行都不用改。
 */

export type WarehouseKind = 'main' | 'material' | 'product';

export interface WarehouseRow {
  id: number;
  code: string;
  name: string;
  kind: WarehouseKind;
  is_default: number;
  status: string;
  remark: string | null;
}

/** 品类 → 能容纳它的仓库类型 */
function acceptedKinds(itemType: ItemType): WarehouseKind[] {
  return itemType === 'material' ? ['material', 'main'] : ['product', 'main'];
}

export function kindFits(itemType: ItemType, kind: string): boolean {
  return acceptedKinds(itemType).includes(kind as WarehouseKind);
}

/**
 * 该品类的默认仓。
 * 优先取「品类完全匹配且 is_default=1」的仓（物料→物料库、成品→成品库），
 * 找不到再退到 main 仓，最后才是任意一个能容纳它的启用仓。
 */
export function defaultWarehouseOf(itemType: ItemType): number | null {
  const kinds = acceptedKinds(itemType);
  const rows = db
    .prepare(
      `SELECT id, kind, is_default FROM warehouses
        WHERE status = '启用' AND kind IN (${kinds.map(() => '?').join(',')})
        ORDER BY is_default DESC, id ASC`,
    )
    .all(...kinds) as { id: number; kind: WarehouseKind; is_default: number }[];

  if (rows.length === 0) return null;
  const exact = rows.find((r) => r.kind === (itemType === 'material' ? 'material' : 'product'));
  const pick = exact ?? rows.find((r) => r.is_default === 1) ?? rows[0];
  return pick.id;
}

/** 取仓库并校验存在 / 启用（不校验品类，供「先确认仓能用于是单据」的场景用） */
export function requireWarehouse(warehouseId: number): {
  id: number;
  name: string;
  kind: WarehouseKind;
  status: string;
} {
  const w = db
    .prepare(`SELECT id, name, kind, status FROM warehouses WHERE id = ?`)
    .get(Number(warehouseId)) as
    | { id: number; name: string; kind: WarehouseKind; status: string }
    | undefined;

  if (!w) throw new BizError(404, 'WAREHOUSE_NOT_FOUND', '仓库不存在，请刷新后重试');
  if (w.status !== '启用') throw new BizError(409, 'WAREHOUSE_DISABLED', `仓库「${w.name}」已停用`);
  return w;
}

/**
 * 解析并校验仓库。
 * 未传 → 用该品类默认仓；传了则校验存在、启用、品类匹配。
 */
export function resolveWarehouse(itemType: ItemType, warehouseId?: number | null): number {
  if (warehouseId == null || Number.isNaN(Number(warehouseId)) || Number(warehouseId) === 0) {
    const def = defaultWarehouseOf(itemType);
    if (!def) {
      throw new BizError(
        400,
        'NO_WAREHOUSE',
        `尚未配置可容纳该${itemType === 'material' ? '物料' : '成品'}的仓库，请先在库存查询页新增仓库`,
      );
    }
    return def;
  }

  const w = requireWarehouse(warehouseId);
  if (!kindFits(itemType, w.kind)) {
    throw new BizError(
      409,
      'WAREHOUSE_KIND_MISMATCH',
      `仓库「${w.name}」不能存放${itemType === 'material' ? '物料' : '成品'}，请选择对应仓库`,
    );
  }
  return w.id;
}

/** 仓库名称（用于报错文案，取不到就给个占位） */
export function warehouseName(warehouseId: number): string {
  const row = db.prepare(`SELECT name FROM warehouses WHERE id = ?`).get(warehouseId) as
    | { name: string }
    | undefined;
  return row?.name ?? '未知仓库';
}

/** 某对象在某仓的现存数量（没记录就是 0） */
export function stockOfWarehouse(
  itemType: ItemType,
  itemId: number,
  warehouseId: number,
): number {
  const row = db
    .prepare(
      `SELECT qty FROM stock_warehouse WHERE item_type = ? AND item_id = ? AND warehouse_id = ?`,
    )
    .get(itemType, itemId, warehouseId) as { qty: number } | undefined;
  return Number(row?.qty ?? 0);
}

/** 某对象在各仓的存量（含 qty=0 的仓不返回） */
export function stockByWarehouse(itemType: ItemType, itemId: number): { warehouseId: number; qty: number }[] {
  return (
    db
      .prepare(
        `SELECT warehouse_id AS warehouseId, qty FROM stock_warehouse
          WHERE item_type = ? AND item_id = ? AND qty <> 0`,
      )
      .all(itemType, itemId) as { warehouseId: number; qty: number }[]
  ).map((r) => ({ warehouseId: r.warehouseId, qty: Number(r.qty) }));
}

/**
 * 按仓增减库存，同时同步总库存。
 *
 * 两个表必须在同一个事务里一起改 —— 这是「总库存 = 各仓之和」的唯一保证点，
 * 所以除了 applyStock 之外任何地方都不许直接调它。
 */
export function addWarehouseStock(
  itemType: ItemType,
  itemId: number,
  warehouseId: number,
  delta: number,
): number {
  const before = stockOfWarehouse(itemType, itemId, warehouseId);
  const after = round(before + delta);

  db.prepare(
    `INSERT INTO stock_warehouse (item_type, item_id, warehouse_id, qty, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (item_type, item_id, warehouse_id)
     DO UPDATE SET qty = excluded.qty, updated_at = excluded.updated_at`,
  ).run(itemType, itemId, warehouseId, after, nowIso());

  // 总库存：与分仓同增同减
  const table = itemType === 'material' ? 'materials' : 'products';
  db.prepare(`UPDATE ${table} SET current_stock = ROUND(current_stock + ?, 2) WHERE id = ?`).run(
    delta,
    itemId,
  );

  return after;
}

/**
 * 一致性体检：总库存是否等于各仓之和。
 * 供系统初始化 / 排障用，正常情况下差值恒为 0。
 */
export function stockConsistencyIssues(): {
  itemType: ItemType;
  itemId: number;
  code: string;
  name: string;
  total: number;
  sumByWarehouse: number;
  diff: number;
}[] {
  const out: any[] = [];
  for (const itemType of ['material', 'product'] as ItemType[]) {
    const table = itemType === 'material' ? 'materials' : 'products';
    const rows = db
      .prepare(
        `SELECT t.id, t.code, t.name, t.current_stock AS total,
                COALESCE((SELECT SUM(s.qty) FROM stock_warehouse s
                           WHERE s.item_type = ? AND s.item_id = t.id), 0) AS sumWh
           FROM ${table} t`,
      )
      .all(itemType) as any[];
    for (const r of rows) {
      const total = Number(r.total ?? 0);
      const sumWh = Number(r.sumWh ?? 0);
      const diff = round(sumWh - total);
      if (Math.abs(diff) > 0.0001) {
        out.push({ itemType, itemId: r.id, code: r.code, name: r.name, total, sumByWarehouse: sumWh, diff });
      }
    }
  }
  return out;
}

function round(n: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round((Number(n) + Number.EPSILON) * f) / f;
}
