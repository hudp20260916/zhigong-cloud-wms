import { Router } from 'express';
import { z } from 'zod';
import type { ItemType } from '../../../../shared/enums.js';
import { BIZ_TYPE } from '../../../../shared/enums.js';
import { db, nowIso, tx } from '../../db/index.js';
import { nextCode } from '../../core/code.js';
import { Err } from '../../core/errors.js';
import { applyStock, reverseStock } from '../../core/ledger.js';
import { writeLog } from '../../core/log.js';
import { requireWarehouse, resolveWarehouse, warehouseName } from '../../core/warehouse.js';
import { requirePerm } from '../../middleware/auth.js';
import { countRows, parsePage } from '../../shared/query.js';
import { ok, okList } from '../../shared/http.js';

/**
 * 仓库调拨 —— 同一件东西在两个仓之间搬。
 *
 * 库存口径：
 *   * 调出仓出库 −qty、调入仓入库 +qty，**总库存不变**（两个仓一减一加）；
 *   * 两个仓各写一条流水（调拨出库 / 调拨入库），biz_id 都是调拨单 ID，
 *     撤销时两条一起反向对冲，库存原路退回；
 *   * 调拨不挪金额：入库侧按调出时的成本价入账，移动加权成本保持不动。
 *
 * 校验：调出调入不能同一个仓、仓库必须启用、品类必须匹配（物料不能进成品库）、
 *      调出仓该批次余量不足直接 409（按仓校验，不是按总库存）。
 */

export const transferRouter = Router();

const itemSchema = z.object({
  itemType: z.enum(['material', 'product']),
  itemId: z.number().int().positive('调拨对象不正确'),
  batchNo: z.string().trim().max(50).optional().default(''),
  qty: z.number().gt(0, '调拨数量必须大于 0'),
  remark: z.string().trim().max(200).optional().default(''),
});

const createSchema = z.object({
  fromWarehouseId: z.number().int().positive('请选择调出仓库'),
  toWarehouseId: z.number().int().positive('请选择调入仓库'),
  transferDate: z.string().trim().min(1, '请选择调拨日期'),
  remark: z.string().trim().max(200).optional().default(''),
  items: z.array(itemSchema).min(1, '请至少添加一条调拨明细'),
});

function tableOf(itemType: ItemType): 'materials' | 'products' {
  return itemType === 'material' ? 'materials' : 'products';
}

function nameOf(itemType: ItemType, itemId: number): { name: string; code: string; unit: string } {
  const row = db
    .prepare(`SELECT code, name, unit FROM ${tableOf(itemType)} WHERE id = ?`)
    .get(itemId) as { code: string; name: string; unit: string } | undefined;
  if (!row) throw Err.notFound('调拨对象不存在，请刷新后重试');
  return row;
}

/** 调拨单列表 */
transferRouter.get('/', requirePerm('stock.transfer.view'), (req, res) => {
  const { page, pageSize, offset, keyword } = parsePage(req);
  const fromWh = Number(req.query.fromWarehouseId ?? 0) || 0;
  const toWh = Number(req.query.toWarehouseId ?? 0) || 0;
  const status = String(req.query.status ?? '').trim();

  const cond: string[] = ['1=1'];
  const params: any[] = [];
  if (keyword) {
    cond.push(`(t.transfer_no LIKE ? OR IFNULL(t.remark,'') LIKE ?)`);
    params.push(`%${keyword}%`, `%${keyword}%`);
  }
  if (fromWh) {
    cond.push(`t.from_warehouse_id = ?`);
    params.push(fromWh);
  }
  if (toWh) {
    cond.push(`t.to_warehouse_id = ?`);
    params.push(toWh);
  }
  if (status) {
    cond.push(`t.status = ?`);
    params.push(status);
  }
  const where = cond.join(' AND ');

  const rows = db
    .prepare(
      `SELECT t.*,
              fw.name AS from_warehouse_name, fw.code AS from_warehouse_code,
              tw.name AS to_warehouse_name,   tw.code AS to_warehouse_code,
              u.display_name AS operator_name,
              (SELECT COUNT(*) FROM warehouse_transfer_items i WHERE i.transfer_id = t.id) AS item_count,
              (SELECT COALESCE(SUM(i.qty), 0) FROM warehouse_transfer_items i WHERE i.transfer_id = t.id) AS total_qty
         FROM warehouse_transfers t
         JOIN warehouses fw ON fw.id = t.from_warehouse_id
         JOIN warehouses tw ON tw.id = t.to_warehouse_id
         LEFT JOIN users u ON u.id = t.operator_id
        WHERE ${where}
        ORDER BY t.id DESC
        LIMIT ? OFFSET ?`,
    )
    .all(...params, pageSize, offset) as any[];

  const total = countRows(
    `warehouse_transfers t
       JOIN warehouses fw ON fw.id = t.from_warehouse_id
       JOIN warehouses tw ON tw.id = t.to_warehouse_id`,
    where,
    params,
  );

  okList(res, rows, total);
});

/** 调拨单明细 */
transferRouter.get('/:id', requirePerm('stock.transfer.view'), (req, res) => {
  const id = Number(req.params.id);
  const head = db
    .prepare(
      `SELECT t.*, fw.name AS from_warehouse_name, tw.name AS to_warehouse_name,
              u.display_name AS operator_name
         FROM warehouse_transfers t
         JOIN warehouses fw ON fw.id = t.from_warehouse_id
         JOIN warehouses tw ON tw.id = t.to_warehouse_id
         LEFT JOIN users u ON u.id = t.operator_id
        WHERE t.id = ?`,
    )
    .get(id) as any;
  if (!head) throw Err.notFound('调拨单不存在');

  const items = db
    .prepare(
      `SELECT i.*,
              CASE WHEN i.item_type = 'material'
                   THEN (SELECT m.name FROM materials m WHERE m.id = i.item_id)
                   ELSE (SELECT p.name FROM products  p WHERE p.id = i.item_id) END AS item_name,
              CASE WHEN i.item_type = 'material'
                   THEN (SELECT m.code FROM materials m WHERE m.id = i.item_id)
                   ELSE (SELECT p.code FROM products  p WHERE p.id = i.item_id) END AS item_code,
              CASE WHEN i.item_type = 'material'
                   THEN (SELECT m.unit FROM materials m WHERE m.id = i.item_id)
                   ELSE (SELECT p.unit FROM products  p WHERE p.id = i.item_id) END AS unit
         FROM warehouse_transfer_items i
        WHERE i.transfer_id = ?
        ORDER BY i.id`,
    )
    .all(id) as any[];

  ok(res, { ...head, items });
});

/** 新建调拨单：调出仓减、调入仓加，各写一条流水 */
transferRouter.post('/', requirePerm('stock.transfer.create'), (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) throw Err.badRequest(parsed.error.issues[0].message);
  const d = parsed.data;

  if (d.fromWarehouseId === d.toWarehouseId) {
    throw Err.badRequest('调出仓库与调入仓库不能相同');
  }

  const id = tx(() => {
    // 先确认两个仓存在且启用；品类是否匹配由每条明细的 itemType 逐个判断
    const from = requireWarehouse(d.fromWarehouseId);
    const to = requireWarehouse(d.toWarehouseId);
    if (from.id === to.id) throw Err.badRequest('调出仓库与调入仓库不能相同');
    const fromId = from.id;

    // 明细去重：同一对象 + 同一批次合并数量，避免重复行把库存算两遍
    const merged = new Map<string, { itemType: ItemType; itemId: number; batchNo: string; qty: number; remark: string }>();
    for (const it of d.items) {
      const key = `${it.itemType}|${it.itemId}|${it.batchNo ?? ''}`;
      const hit = merged.get(key);
      if (hit) hit.qty = Number((hit.qty + it.qty).toFixed(4));
      else
        merged.set(key, {
          itemType: it.itemType,
          itemId: it.itemId,
          batchNo: it.batchNo ?? '',
          qty: it.qty,
          remark: it.remark ?? '',
        });
    }
    const lines = [...merged.values()];
    for (const l of lines) {
      if (l.qty <= 0) throw Err.badRequest('调拨数量必须大于 0');
      nameOf(l.itemType, l.itemId); // 顺带校验对象存在
      resolveWarehouse(l.itemType, fromId); // 调出仓能否放该品类
      resolveWarehouse(l.itemType, to.id); // 调入仓能否放该品类
    }

    const transferNo = nextCode('transfer', d.transferDate);
    const info = db
      .prepare(
        `INSERT INTO warehouse_transfers
           (transfer_no, from_warehouse_id, to_warehouse_id, transfer_date, operator_id, status, remark, created_at)
         VALUES (?,?,?,?,?, '有效', ?,?)`,
      )
      .run(
        transferNo,
        fromId,
        to.id,
        d.transferDate,
        req.ctx!.userId ?? null,
        d.remark,
        nowIso(),
      );
    const transferId = Number(info.lastInsertRowid);

    const insItem = db.prepare(
      `INSERT INTO warehouse_transfer_items (transfer_id, item_type, item_id, batch_no, qty, unit_price, remark)
       VALUES (?,?,?,?,?,?,?)`,
    );

    const entries = [];
    for (const l of lines) {
      const cost =
        l.itemType === 'material'
          ? Number(
              (db.prepare(`SELECT avg_cost FROM materials WHERE id = ?`).get(l.itemId) as any)
                ?.avg_cost ?? 0,
            )
          : 0;
      insItem.run(transferId, l.itemType, l.itemId, l.batchNo, l.qty, cost, l.remark);

      // 调出仓出库
      entries.push({
        itemType: l.itemType,
        itemId: l.itemId,
        direction: 'out' as const,
        qty: l.qty,
        bizType: BIZ_TYPE.TRANSFER_OUT,
        bizId: transferId,
        unitPrice: cost,
        operatorId: req.ctx!.userId,
        warehouseId: fromId,
      });
      // 调入仓入库（成本价照搬，调拨不挪金额）
      entries.push({
        itemType: l.itemType,
        itemId: l.itemId,
        direction: 'in' as const,
        qty: l.qty,
        bizType: BIZ_TYPE.TRANSFER_IN,
        bizId: transferId,
        unitPrice: cost,
        operatorId: req.ctx!.userId,
        warehouseId: to.id,
      });
    }

    // 先出后入：出库侧的按仓不足校验会在这里抛 409，整单回滚
    applyStock(entries);

    writeLog({
      operatorId: req.ctx!.userId,
      action: '新增仓库调拨单',
      targetType: 'warehouse_transfer',
      targetId: transferId,
      detail: {
        transferNo,
        from: warehouseName(fromId),
        to: to.name,
        lines: lines.length,
      },
    });

    return transferId;
  });

  ok(res, { id, at: nowIso() });
});

/** 撤销调拨单：两个仓的流水一起反向对冲，库存原路退回 */
transferRouter.post('/:id/undo', requirePerm('stock.transfer.undo'), (req, res) => {
  const id = Number(req.params.id);

  tx(() => {
    const head = db
      .prepare(`SELECT * FROM warehouse_transfers WHERE id = ?`)
      .get(id) as any;
    if (!head) throw Err.notFound('调拨单不存在');
    if (head.status === '已撤销') throw Err.conflict('该调拨单已撤销，请勿重复操作');

    // 两个方向都要反向：调出仓的「调拨出库」对冲成入库，调入仓的「调拨入库」对冲成出库
    reverseStock(BIZ_TYPE.TRANSFER_OUT, id, req.ctx!.userId);
    reverseStock(BIZ_TYPE.TRANSFER_IN, id, req.ctx!.userId);
    db.prepare(`UPDATE warehouse_transfers SET status = '已撤销' WHERE id = ?`).run(id);

    writeLog({
      operatorId: req.ctx!.userId,
      action: '撤销仓库调拨单',
      targetType: 'warehouse_transfer',
      targetId: id,
      detail: { transferNo: head.transfer_no },
    });
  });

  ok(res, { id, at: nowIso() });
});
