import { MASK } from '../../../shared/enums.js';

/**
 * 出口层统一脱敏与字段裁剪。
 *
 * 两个硬需求落在这里，而不是散落在各页面里改：
 *  1. 需求 4.5：入库单号在列表 / 导出 / 打印 / 弹窗一律不可见；
 *  2. 需求 4.9：仓库管理员与普通查询人员看到的单价、金额一律为 ***。
 */

const RECEIPT_NO_KEYS = ['receiptNo', 'receipt_no', 'productReceiptNo'];

const PRICE_KEYS = [
  'price',
  'unitPrice',
  'unit_price',
  'amount',
  'totalAmount',
  'total_amount',
  'avgCost',
  'avg_cost',
  'cost',
];

export interface SerializeCtx {
  canViewPrice: boolean;
}

/** 移除入库单号等内部追溯字段 */
export function stripInternal<T extends Record<string, any>>(row: T): T {
  const out = { ...row } as Record<string, any>;
  for (const k of RECEIPT_NO_KEYS) delete out[k];
  return out as T;
}

/** 价格脱敏：无价格查看权限时替换为 *** */
export function maskPrices<T extends Record<string, any>>(row: T, ctx: SerializeCtx): T {
  if (ctx.canViewPrice) return stripInternal(row);
  const out = { ...row } as Record<string, any>;
  for (const k of PRICE_KEYS) {
    if (k in out && out[k] !== null && out[k] !== undefined) out[k] = MASK;
  }
  return stripInternal(out) as T;
}

export function maskList<T extends Record<string, any>>(rows: T[], ctx: SerializeCtx): T[] {
  return rows.map((r) => maskPrices(r, ctx));
}

/** 导出专用：无价格权限时直接剔除价格列，而不是填 ***（需求 5 库管导出剔除列） */
export function dropPriceColumns<T extends Record<string, any>>(rows: T[], canViewPrice: boolean): T[] {
  if (canViewPrice) return rows.map(stripInternal);
  return rows.map((r) => {
    const out = { ...r } as Record<string, any>;
    for (const k of PRICE_KEYS) delete out[k];
    return stripInternal(out) as T;
  });
}
