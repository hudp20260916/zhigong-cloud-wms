/**
 * 权限点与角色矩阵 —— 前后端共享的唯一来源。
 * 修改此文件会同时影响服务端鉴权与前端按钮显隐，请勿在两端各写一份。
 */

export type Role =
  | 'admin'
  | 'finance'
  | 'purchaser'
  | 'producer'
  | 'sales'
  | 'warehouse'
  | 'viewer';

export const ROLE_LABEL: Record<Role, string> = {
  admin: '管理员',
  finance: '财务人员',
  purchaser: '采购人员',
  producer: '生产人员',
  sales: '销售人员',
  warehouse: '仓库管理员',
  viewer: '普通查询人员',
};

/** 权限点：模块.对象.动作 */
export type Permission =
  | 'dashboard.view'
  | 'archive.material.view'
  | 'archive.material.manage'
  | 'archive.product.view'
  | 'archive.product.manage'
  | 'archive.partner.view'
  | 'archive.partner.manage'
  | 'stock.view'
  | 'stock.initial.manage'
  | 'stock.detail.view'
  | 'stock.warehouse.view'
  | 'stock.warehouse.manage'
  | 'stock.transfer.view'
  | 'stock.transfer.create'
  | 'stock.transfer.undo'
  | 'purchase.order.view'
  | 'purchase.order.create'
  | 'purchase.order.update'
  | 'purchase.order.delete'
  | 'purchase.receipt.view'
  | 'purchase.receipt.create'
  | 'purchase.receipt.undo'
  | 'purchase.arrival.view'
  | 'purchase.return.view'
  | 'purchase.return.create'
  | 'production.wo.view'
  | 'production.wo.create'
  | 'production.wo.update'
  | 'production.issue.view'
  | 'production.issue.create'
  | 'production.receipt.view'
  | 'production.receipt.create'
  | 'production.receipt.undo'
  | 'sale.order.view'
  | 'sale.order.create'
  | 'sale.delivery.view'
  | 'sale.delivery.create'
  | 'sale.return.view'
  | 'sale.return.create'
  | 'warehouse.materialSale.view'
  | 'warehouse.materialSale.create'
  | 'warehouse.defective.view'
  | 'warehouse.defective.create'
  | 'warehouse.check.view'
  | 'warehouse.check.create'
  | 'warehouse.check.audit'
  | 'warehouse.simulate.view'
  | 'warehouse.simulate.create'
  | 'warehouse.alarm.view'
  | 'finance.settle.view'
  | 'finance.settle.audit'
  | 'report.view'
  | 'system.view'
  | 'system.user.manage'
  | 'system.user.init'
  | 'system.backup.manage'
  | 'system.init.execute'
  | 'system.print.manage'
  | 'system.import.execute'
  | 'price.view'
  | 'export.data';

const ALL: Permission[] = [
  'dashboard.view',
  'archive.material.view',
  'archive.material.manage',
  'archive.product.view',
  'archive.product.manage',
  'archive.partner.view',
  'archive.partner.manage',
  'stock.view',
  'stock.initial.manage',
  'stock.detail.view',
  'stock.warehouse.view',
  'stock.warehouse.manage',
  'stock.transfer.view',
  'stock.transfer.create',
  'stock.transfer.undo',
  'purchase.order.view',
  'purchase.order.create',
  'purchase.order.update',
  'purchase.order.delete',
  'purchase.receipt.view',
  'purchase.receipt.create',
  'purchase.receipt.undo',
  'purchase.arrival.view',
  'purchase.return.view',
  'purchase.return.create',
  'production.wo.view',
  'production.wo.create',
  'production.wo.update',
  'production.issue.view',
  'production.issue.create',
  'production.receipt.view',
  'production.receipt.create',
  'production.receipt.undo',
  'sale.order.view',
  'sale.order.create',
  'sale.delivery.view',
  'sale.delivery.create',
  'sale.return.view',
  'sale.return.create',
  'warehouse.materialSale.view',
  'warehouse.materialSale.create',
  'warehouse.defective.view',
  'warehouse.defective.create',
  'warehouse.check.view',
  'warehouse.check.create',
  'warehouse.check.audit',
  'warehouse.simulate.view',
  'warehouse.simulate.create',
  'warehouse.alarm.view',
  'finance.settle.view',
  'finance.settle.audit',
  'report.view',
  'system.view',
  'system.user.manage',
  'system.user.init',
  'system.backup.manage',
  'system.init.execute',
  'system.print.manage',
  'system.import.execute',
  'price.view',
  'export.data',
];

export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  admin: ALL,
  finance: [
    'dashboard.view',
    'archive.material.view',
    'archive.product.view',
    'archive.partner.view',
    'stock.view',
    'stock.initial.manage',
    'stock.detail.view',
    'stock.warehouse.view',
    'stock.transfer.view',
    'purchase.order.view',
    'purchase.receipt.view',
    'purchase.arrival.view',
    'purchase.return.view',
    'finance.settle.view',
    'finance.settle.audit',
    'report.view',
    'price.view',
    'export.data',
  ],
  purchaser: [
    'dashboard.view',
    'archive.material.view',
    'archive.product.view',
    'archive.partner.view',
    'stock.view',
    'stock.detail.view',
    'stock.warehouse.view',
    'stock.transfer.view',
    'purchase.order.view',
    'purchase.order.create',
    'purchase.order.update',
    'purchase.order.delete',
    'purchase.receipt.view',
    'purchase.receipt.create',
    'purchase.arrival.view',
    'purchase.return.view',
    'purchase.return.create',
    'warehouse.alarm.view',
    'price.view',
    'export.data',
  ],
  producer: [
    'dashboard.view',
    'archive.material.view',
    'archive.product.view',
    'stock.view',
    'stock.detail.view',
    'stock.warehouse.view',
    'stock.transfer.view',
    'production.wo.view',
    'production.wo.create',
    'production.wo.update',
    'production.issue.view',
    'production.issue.create',
    'production.receipt.view',
    'production.receipt.create',
    'warehouse.simulate.view',
    'warehouse.simulate.create',
    'warehouse.alarm.view',
    'export.data',
  ],
  sales: [
    'dashboard.view',
    'archive.product.view',
    'archive.partner.view',
    'stock.view',
    'stock.warehouse.view',
    'stock.transfer.view',
    'sale.order.view',
    'sale.order.create',
    'sale.delivery.view',
    'sale.delivery.create',
    'sale.return.view',
    'sale.return.create',
    'warehouse.simulate.view',
    'price.view',
    'export.data',
  ],
  warehouse: [
    'dashboard.view',
    'archive.material.view',
    'archive.product.view',
    'stock.view',
    'stock.detail.view',
    'stock.warehouse.view',
    'stock.warehouse.manage',
    'stock.transfer.view',
    'stock.transfer.create',
    'stock.transfer.undo',
    'purchase.receipt.view',
    'purchase.receipt.create',
    'purchase.receipt.undo',
    'purchase.arrival.view',
    'production.receipt.view',
    'production.receipt.create',
    'production.receipt.undo',
    'sale.delivery.view',
    'sale.delivery.create',
    'warehouse.materialSale.view',
    'warehouse.materialSale.create',
    'warehouse.defective.view',
    'warehouse.defective.create',
    'warehouse.check.view',
    'warehouse.check.create',
    'warehouse.alarm.view',
    'export.data',
  ],
  viewer: [
    'dashboard.view',
    'archive.material.view',
    'archive.product.view',
    'stock.view',
    'stock.detail.view',
    'stock.warehouse.view',
    'stock.transfer.view',
  ],
};

export function permissionsOf(role: Role): Permission[] {
  return ROLE_PERMISSIONS[role] ?? [];
}

export function roleHas(role: Role, permission: Permission): boolean {
  return permissionsOf(role).includes(permission);
}
