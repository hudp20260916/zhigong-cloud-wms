import { db, todayStr } from '../db/index.js';

/**
 * 单据编号生成器。
 * 需求 4.8：编号持续递增不重置，防止单号重复 —— 序列按前缀全局递增，
 * 不随日期、不随系统初始化清零。
 */
const PREFIXES = {
  purchaseOrder: 'PO',
  purchaseReceipt: 'PR',
  purchaseReturn: 'RT',
  workOrder: 'WO',
  issue: 'MI',
  productReceipt: 'FG',
  saleOrder: 'SO',
  saleDelivery: 'SD',
  saleReturn: 'SR',
  stockCheck: 'SC',
  materialSale: 'MS',
  defectiveOut: 'DO',
  simulate: 'SM',
  settlement: 'ST',
} as const;

export type CodeKind = keyof typeof PREFIXES;

export function nextCode(kind: CodeKind, date = todayStr()): string {
  const prefix = PREFIXES[kind];
  const row = db.prepare(`SELECT current FROM code_sequences WHERE prefix = ?`).get(prefix) as
    | { current: number }
    | undefined;

  const seq = (row?.current ?? 0) + 1;
  db.prepare(
    `INSERT INTO code_sequences (prefix, current, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(prefix) DO UPDATE SET current = excluded.current, updated_at = excluded.updated_at`,
  ).run(prefix, seq, new Date().toISOString());

  return `${prefix}${date.replace(/-/g, '')}-${String(seq).padStart(4, '0')}`;
}
