/** 前后端共享的枚举与字典定义 */

export type ItemType = 'material' | 'product';

export const ITEM_TYPE_LABEL: Record<ItemType, string> = {
  material: '物料',
  product: '成品',
};

/** 库存流水业务类型（biz_type） */
export const BIZ_TYPE = {
  INITIAL: '期初库存',
  PURCHASE_IN: '采购入库',
  PURCHASE_RETURN: '采购退货',
  MATERIAL_SALE: '物料销售',
  DEFECTIVE_OUT: '不良品出库',
  CHECK_ADJUST: '盘点调整',
  ISSUE: '生产领料',
  MATERIAL_RETURN: '生产退料',
  PRODUCT_IN: '成品入库',
  SALE_OUT: '销售出库',
  SALE_RETURN: '销售退货',
  TRANSFER_OUT: '调拨出库',
  TRANSFER_IN: '调拨入库',
} as const;

export type BizType = (typeof BIZ_TYPE)[keyof typeof BIZ_TYPE];

/** 采购订单状态 */
export const PO_STATUS = {
  ONGOING: '进行中',
  DONE: '已完成',
  CANCELLED: '已撤销',
  CLOSED: '已关闭',
} as const;
export type PoStatus = (typeof PO_STATUS)[keyof typeof PO_STATUS];

/** 采购模式 */
export const PURCHASE_MODE = {
  BOM: 'bom',
  DIRECT: 'direct',
} as const;
export type PurchaseMode = (typeof PURCHASE_MODE)[keyof typeof PURCHASE_MODE];

/** 单据有效状态 */
export const DOC_STATUS = {
  VALID: '有效',
  CANCELLED: '已撤销',
} as const;
export type DocStatus = (typeof DOC_STATUS)[keyof typeof DOC_STATUS];

export const DIRECTION = { IN: 'in', OUT: 'out' } as const;
export type Direction = (typeof DIRECTION)[keyof typeof DIRECTION];

/** 价格脱敏占位符 */
export const MASK = '***';

/**
 * 合并展示摘要：多项时格式化为「A、B等N项」
 * 需求 4.4：严禁仅展示首项
 */
export function summarize(names: string[], max = 2): string {
  const list = (names ?? []).filter(Boolean);
  if (list.length === 0) return '';
  if (list.length <= max) return list.join('、');
  return `${list.slice(0, max).join('、')}等${list.length}项`;
}
