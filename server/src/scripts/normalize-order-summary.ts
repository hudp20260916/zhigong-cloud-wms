/**
 * 一次性数据迁移：统一历史采购订单的「采购摘要」格式。
 *
 * 背景：摘要格式是「A、B」/「A、B等N项」（见 shared/enums.ts 的 summarize）。
 * 早期数据可能直接存了完整罗列或空值，导致列表里新旧数据长得不一样。
 * 这里用与新增/编辑**同一个函数**重算，保证格式 100% 一致；幂等，可反复执行。
 *
 * 注意：拆单产生的父单本身没有明细行，它的摘要是建单时按全部物料算出来的汇总，
 * 这类订单跳过，避免把摘要清空。
 *
 * 执行：npx tsx server/src/scripts/normalize-order-summary.ts
 */
import { db, tx } from '../db/index.js';
import { summarize } from '../../../shared/enums.js';

const orders = db
  .prepare(`SELECT id, order_no, summary FROM purchase_orders ORDER BY id`)
  .all() as { id: number; order_no: string; summary: string | null }[];

const itemStmt = db.prepare(
  `SELECT i.material_id FROM purchase_order_items i WHERE i.order_id = ? ORDER BY i.id`,
);
const nameStmt = db.prepare(`SELECT name FROM materials WHERE id = ?`);

let changed = 0;
let skipped = 0;
let same = 0;

tx(() => {
  const upd = db.prepare(`UPDATE purchase_orders SET summary = ?, updated_at = updated_at WHERE id = ?`);
  for (const o of orders) {
    const rows = itemStmt.all(o.id) as { material_id: number }[];
    if (rows.length === 0) {
      // 父单（无明细）：保留原摘要
      skipped++;
      continue;
    }
    const names = rows.map((r) => {
      const m = nameStmt.get(r.material_id) as { name: string } | undefined;
      return m?.name ?? `未知物料#${r.material_id}`;
    });
    const next = summarize(names);
    if ((o.summary ?? '') === next) {
      same++;
      continue;
    }
    upd.run(next, o.id);
    changed++;
    console.log(`  ${o.order_no}: "${o.summary ?? ''}"  ->  "${next}"`);
  }
});

console.log(
  `[摘要统一] 共 ${orders.length} 张订单：更新 ${changed} 张，格式已一致 ${same} 张，父单跳过 ${skipped} 张`,
);
