import { Router } from 'express';
import { z } from 'zod';
import { db, nowIso, tx } from '../../db/index.js';
import { Err } from '../../core/errors.js';
import { writeLog } from '../../core/log.js';
import { requirePerm } from '../../middleware/auth.js';
import { countRows, nameOrderSql, normalizeDir, parsePage } from '../../shared/query.js';
import { ok, okList } from '../../shared/http.js';
import { kindFits } from '../../core/warehouse.js';
import type { ItemType } from '../../../../shared/enums.js';

/**
 * 仓库档案。
 *
 * 三条口径（与平哥确认）：
 *  1. 仓与品类绑定 —— main（主仓库）成品物料都能放，material 只放物料，product 只放成品；
 *  2. 新增表单默认选中「主仓库」，仓库名称可编辑；
 *  3. 名称 / 编码全库唯一，重名直接 409，前端保存后要刷新列表与筛选下拉。
 */

export const warehouseRouter = Router();

export const WAREHOUSE_KINDS = ['main', 'material', 'product'] as const;
export const KIND_LABEL: Record<(typeof WAREHOUSE_KINDS)[number], string> = {
  main: '主仓库',
  material: '物料库',
  product: '成品库',
};

const schema = z.object({
  // 编码留空由服务端按 W + 序号 生成
  code: z.string().trim().max(20, '仓库编码不能超过 20 个字符').optional().default(''),
  name: z
    .string()
    .trim()
    .min(1, '仓库名称不能为空')
    .max(50, '仓库名称不能超过 50 个字'),
  kind: z.enum(WAREHOUSE_KINDS),
  isDefault: z.boolean().optional().default(false),
  status: z.enum(['启用', '停用']).optional().default('启用'),
  remark: z.string().trim().max(200).optional().default(''),
});

function nextCode(): string {
  let seq = 1;
  for (let i = 0; i < 50; i += 1) {
    const code = `W${String(seq).padStart(2, '0')}`;
    const dup = db.prepare(`SELECT id FROM warehouses WHERE code = ?`).get(code);
    if (!dup) return code;
    seq += 1;
  }
  return `W${Date.now() % 100000}`;
}

/** 设为默认仓时，同品类的其它仓要取消默认，否则「未选仓兜底」会有歧义 */
function applyDefault(id: number, kind: string, isDefault: boolean): void {
  if (!isDefault) {
    db.prepare(`UPDATE warehouses SET is_default = 0, updated_at = ? WHERE id = ?`).run(
      nowIso(),
      id,
    );
    return;
  }
  db.prepare(`UPDATE warehouses SET is_default = 0, updated_at = ? WHERE kind = ?`).run(
    nowIso(),
    kind,
  );
  db.prepare(`UPDATE warehouses SET is_default = 1, updated_at = ? WHERE id = ?`).run(nowIso(), id);
}

function assertNameFree(name: string, excludeId?: number): void {
  const dup = excludeId
    ? db.prepare(`SELECT id FROM warehouses WHERE name = ? AND id <> ?`).get(name, excludeId)
    : db.prepare(`SELECT id FROM warehouses WHERE name = ?`).get(name);
  if (dup) throw Err.conflict(`仓库名称【${name}】已存在，请重新输入`);
}

function assertCodeFree(code: string, excludeId?: number): void {
  const dup = excludeId
    ? db.prepare(`SELECT id FROM warehouses WHERE code = ? AND id <> ?`).get(code, excludeId)
    : db.prepare(`SELECT id FROM warehouses WHERE code = ?`).get(code);
  if (dup) throw Err.conflict(`仓库编码【${code}】已存在，请重新输入`);
}

/** 该仓的占用情况：有库存或有流水就不许删，只能停用 */
export function usageOf(id: number): { stockRows: number; ledgerRows: number; qty: number } {
  const stock = db
    .prepare(
      `SELECT COUNT(*) AS c, COALESCE(SUM(qty), 0) AS q FROM stock_warehouse WHERE warehouse_id = ?`,
    )
    .get(id) as { c: number; q: number };
  const ledger = db
    .prepare(`SELECT COUNT(*) AS c FROM stock_ledger WHERE warehouse_id = ?`)
    .get(id) as { c: number };
  return { stockRows: Number(stock.c), ledgerRows: Number(ledger.c), qty: Number(stock.q) };
}

/** 列表：带每仓的物料/成品占用，方便判断能不能停用或删除 */
warehouseRouter.get('/', requirePerm('stock.warehouse.view'), (req, res) => {
  const { page, pageSize, offset, keyword } = parsePage(req);
  const order = nameOrderSql('w.name', normalizeDir(req.query.sortDir));
  const kind = String(req.query.kind ?? '').trim();

  const cond: string[] = ['1=1'];
  const params: any[] = [];
  if (keyword) {
    cond.push(`(w.code LIKE ? OR w.name LIKE ?)`);
    params.push(`%${keyword}%`, `%${keyword}%`);
  }
  if (kind && (WAREHOUSE_KINDS as readonly string[]).includes(kind)) {
    cond.push(`w.kind = ?`);
    params.push(kind);
  }
  const where = cond.join(' AND ');

  const rows = db
    .prepare(
      `SELECT w.*,
              (SELECT COUNT(*) FROM stock_warehouse s WHERE s.warehouse_id = w.id AND s.item_type='material') AS material_skus,
              (SELECT COALESCE(SUM(s.qty),0) FROM stock_warehouse s WHERE s.warehouse_id = w.id AND s.item_type='material') AS material_qty,
              (SELECT COUNT(*) FROM stock_warehouse s WHERE s.warehouse_id = w.id AND s.item_type='product') AS product_skus,
              (SELECT COALESCE(SUM(s.qty),0) FROM stock_warehouse s WHERE s.warehouse_id = w.id AND s.item_type='product') AS product_qty,
              (SELECT COUNT(*) FROM stock_ledger l WHERE l.warehouse_id = w.id) AS ledger_rows
         FROM warehouses w
        WHERE ${where}
        ORDER BY ${order}
        LIMIT ? OFFSET ?`,
    )
    .all(...params, pageSize, offset) as any[];

  const total = countRows(`warehouses w`, where, params);

  okList(
    res,
    rows.map((r: any) => ({ ...r, kindLabel: KIND_LABEL[r.kind as keyof typeof KIND_LABEL] ?? r.kind })),
    total,
  );
});

/**
 * 下拉选项：出入库表单用它渲染「选择仓库」。
 * 传 itemType 时只返回能容纳该品类的仓（物料不会出现在成品仓选项里）。
 */
warehouseRouter.get('/options', requirePerm('stock.warehouse.view'), (req, res) => {
  const itemType = String(req.query.itemType ?? '').trim() as ItemType | '';
  const rows = db
    .prepare(`SELECT id, code, name, kind, is_default, status FROM warehouses ORDER BY is_default DESC, id ASC`)
    .all() as any[];

  const list = rows
    .filter((r) => !itemType || (itemType === 'material' || itemType === 'product' ? kindFits(itemType, r.kind) : true))
    .map((r: any) => ({
      id: r.id,
      code: r.code,
      name: r.name,
      kind: r.kind,
      kindLabel: KIND_LABEL[r.kind as keyof typeof KIND_LABEL] ?? r.kind,
      isDefault: Number(r.is_default) === 1,
      status: r.status,
    }));

  ok(res, list);
});

/** 新增：默认选中「主仓库」，名称可编辑，编码留空自动生成 */
warehouseRouter.post('/', requirePerm('stock.warehouse.manage'), (req, res) => {
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) throw Err.badRequest(parsed.error.issues[0].message);
  const d = parsed.data;

  const id = tx(() => {
    assertNameFree(d.name);
    const code = d.code || nextCode();
    assertCodeFree(code);

    const info = db
      .prepare(
        `INSERT INTO warehouses (code, name, kind, is_default, status, remark, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(code, d.name, d.kind, d.isDefault ? 1 : 0, d.status, d.remark, nowIso(), nowIso());
    const newId = Number(info.lastInsertRowid);
    if (d.isDefault) applyDefault(newId, d.kind, true);

    writeLog({
      operatorId: req.ctx!.userId,
      action: '新增仓库',
      targetType: 'warehouse',
      targetId: newId,
      detail: { code, name: d.name, kind: d.kind },
    });
    return newId;
  });

  ok(res, { id, at: nowIso() });
});

warehouseRouter.put('/:id', requirePerm('stock.warehouse.manage'), (req, res) => {
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) throw Err.badRequest(parsed.error.issues[0].message);
  const d = parsed.data;
  const id = Number(req.params.id);

  tx(() => {
    const old = db.prepare(`SELECT * FROM warehouses WHERE id = ?`).get(id) as any;
    if (!old) throw Err.notFound('仓库不存在或已被删除');

    assertNameFree(d.name, id);
    if (d.code) assertCodeFree(d.code, id);

    db.prepare(
      `UPDATE warehouses SET name=?, kind=?, status=?, remark=?, updated_at=? WHERE id=?`,
    ).run(d.name, d.kind, d.status, d.remark, nowIso(), id);
    if (d.code) db.prepare(`UPDATE warehouses SET code=? WHERE id=?`).run(d.code, id);
    applyDefault(id, d.kind, d.isDefault);

    writeLog({
      operatorId: req.ctx!.userId,
      action: '修改仓库',
      targetType: 'warehouse',
      targetId: id,
      detail: { name: d.name, kind: d.kind },
    });
  });

  ok(res, { id, at: nowIso() });
});

/** 停用 / 启用：停用后不能再作为出入库目标仓 */
warehouseRouter.post('/:id/status', requirePerm('stock.warehouse.manage'), (req, res) => {
  const id = Number(req.params.id);
  const status = String(req.body?.status ?? '').trim() === '停用' ? '停用' : '启用';

  tx(() => {
    const old = db.prepare(`SELECT id, name, kind, is_default FROM warehouses WHERE id = ?`).get(id) as any;
    if (!old) throw Err.notFound('仓库不存在或已被删除');

    if (status === '停用') {
      // 停用会改变「未选仓兜底」的结果，最后一个可容纳该品类的启用仓不允许停用
      const remain = db
        .prepare(
          `SELECT COUNT(*) AS c FROM warehouses
            WHERE status='启用' AND id <> ? AND kind IN ('main', ?)`,
        )
        .get(id, old.kind === 'main' ? 'main' : old.kind) as { c: number };
      if (Number(remain.c) === 0) {
        throw Err.conflict(`「${old.name}」是最后一个可用仓库，停用后出入库将无处可去，请先新增其它仓库`);
      }
      db.prepare(`UPDATE warehouses SET status='停用', is_default=0, updated_at=? WHERE id=?`).run(
        nowIso(),
        id,
      );
    } else {
      db.prepare(`UPDATE warehouses SET status='启用', updated_at=? WHERE id=?`).run(nowIso(), id);
    }

    writeLog({
      operatorId: req.ctx!.userId,
      action: status === '停用' ? '停用仓库' : '启用仓库',
      targetType: 'warehouse',
      targetId: id,
    });
  });

  ok(res, { id, at: nowIso() });
});

warehouseRouter.delete('/:id', requirePerm('stock.warehouse.manage'), (req, res) => {
  const id = Number(req.params.id);

  tx(() => {
    const old = db.prepare(`SELECT id, name, kind FROM warehouses WHERE id = ?`).get(id) as any;
    if (!old) throw Err.notFound('仓库不存在或已被删除');

    const usage = usageOf(id);
    if (usage.stockRows > 0 || usage.ledgerRows > 0) {
      throw Err.conflict(
        `「${old.name}」已有 ${usage.stockRows} 条库存记录与 ${usage.ledgerRows} 条出入库流水，不能删除；如不再使用请改为停用`,
      );
    }
    db.prepare(`DELETE FROM warehouses WHERE id = ?`).run(id);

    writeLog({
      operatorId: req.ctx!.userId,
      action: '删除仓库',
      targetType: 'warehouse',
      targetId: id,
      detail: { name: old.name },
    });
  });

  ok(res, { id, at: nowIso() });
});
