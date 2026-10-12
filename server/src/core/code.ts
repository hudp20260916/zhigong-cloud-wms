import { db, nowIso, todayStr } from '../db/index.js';

/**
 * 单据编号生成器。
 * 需求 4.8：编号持续递增不重置，防止单号重复 —— 序列按单据类型全局递增，
 * 不随日期、不随系统初始化清零。
 *
 * 需求 29：前缀可在「系统参数 → 单据编号」里改，序号位数也可配。
 * 关键点：序列按 kind 定位而不是按 prefix，改前缀只换展示用的前缀，
 * 序号继续往后走（见 008 迁移），否则一改前缀序号就从 1 开始，必然撞历史单号。
 */

/** 系统默认前缀。管理员未修改时使用；也是老库回填 kind 的依据。 */
const PREFIXES = {
  purchaseOrder: 'PO',
  purchaseReceipt: 'PR',
  purchaseReturn: 'RT',
  workOrder: 'WO',
  issue: 'MI',
  materialReturn: 'MT',
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

/** 单据类型中文名，供系统参数页展示 */
export const CODE_KIND_LABELS: Record<CodeKind, string> = {
  purchaseOrder: '采购订单',
  purchaseReceipt: '采购入库单',
  purchaseReturn: '采购退货单',
  workOrder: '生产工单',
  issue: '生产领料单',
  materialReturn: '生产退料单',
  productReceipt: '成品入库单',
  saleOrder: '销售开单',
  saleDelivery: '销售出库单',
  saleReturn: '销售退货单',
  stockCheck: '库存盘点单',
  materialSale: '物料销售单',
  defectiveOut: '不良品出库单',
  simulate: '排产模拟单',
  settlement: '付款单',
};

export const CODE_KINDS = Object.keys(PREFIXES) as CodeKind[];

export const DEFAULT_PREFIXES = PREFIXES;

/** 前缀配置项 key，与 settings.ts 的定义保持一致 */
export function prefixSettingKey(kind: CodeKind): string {
  return `code.prefix.${kind}`;
}

function setting(key: string): string {
  try {
    const row = db.prepare(`SELECT value FROM app_settings WHERE key = ?`).get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? '';
  } catch {
    // app_settings 在极早期迁移未完成时尚不可读，退回默认前缀
    return '';
  }
}

/** 单据前缀：读系统参数，未配置或配置为空白时用默认值；自动转大写并去掉非法字符 */
export function codePrefix(kind: CodeKind): string {
  const raw = setting(prefixSettingKey(kind)).trim().toUpperCase();
  const cleaned = raw.replace(/[^A-Z0-9_-]/g, '');
  return cleaned || PREFIXES[kind];
}

/** 序号位数：默认 4 位（补零），范围 3–8 */
export function seqWidth(): number {
  const n = Number(setting('code.seqWidth'));
  return Number.isFinite(n) && n >= 3 && n <= 8 ? Math.floor(n) : 4;
}

/** 当前序号。三级兜底：按类型 → 老库按默认前缀 → 全表最大值（宁可跳号也不倒退） */
function currentSeq(kind: CodeKind): number {
  const byKind = db.prepare(`SELECT current FROM code_sequences WHERE kind = ?`).get(kind) as
    | { current: number }
    | undefined;
  if (byKind) return Number(byKind.current) || 0;

  const byPrefix = db
    .prepare(`SELECT current FROM code_sequences WHERE prefix = ? AND kind IS NULL`)
    .get(PREFIXES[kind]) as { current: number } | undefined;
  if (byPrefix) return Number(byPrefix.current) || 0;

  const max = db.prepare(`SELECT IFNULL(MAX(current), 0) AS c FROM code_sequences`).get() as {
    c: number;
  };
  return Number(max?.c) || 0;
}

/**
 * 写回序号。同一 kind 始终只有一行记录：
 * 改前缀时更新那一行的 prefix，而不是新开一行，序号因此不会清零。
 */
function bumpSeq(kind: CodeKind, prefix: string, seq: number): void {
  const now = nowIso();

  const byKind = db
    .prepare(`UPDATE code_sequences SET current = ?, prefix = ?, updated_at = ? WHERE kind = ?`)
    .run(seq, prefix, now, kind);
  if (byKind.changes > 0) return;

  // 老库遗留行（kind 为空）按默认前缀认领
  const legacy = db
    .prepare(
      `UPDATE code_sequences SET kind = ?, current = ?, prefix = ?, updated_at = ?
        WHERE prefix = ? AND kind IS NULL`,
    )
    .run(kind, seq, prefix, now, PREFIXES[kind]);
  if (legacy.changes > 0) return;

  // prefix 是主键：同前缀的占位行要先让位，否则插入会冲突
  db.prepare(`DELETE FROM code_sequences WHERE prefix = ?`).run(prefix);
  db.prepare(
    `INSERT INTO code_sequences (prefix, kind, current, updated_at) VALUES (?,?,?,?)`,
  ).run(prefix, kind, seq, now);
}

export function nextCode(kind: CodeKind, date = todayStr()): string {
  const prefix = codePrefix(kind);
  const seq = currentSeq(kind) + 1;
  bumpSeq(kind, prefix, seq);
  return `${prefix}${date.replace(/-/g, '')}-${String(seq).padStart(seqWidth(), '0')}`;
}

/** 预览某个类型下一张单号长什么样（系统参数页展示用，不消耗序号） */
export function previewCode(kind: CodeKind, date = todayStr()): string {
  const prefix = codePrefix(kind);
  return `${prefix}${date.replace(/-/g, '')}-${String(currentSeq(kind) + 1).padStart(seqWidth(), '0')}`;
}
