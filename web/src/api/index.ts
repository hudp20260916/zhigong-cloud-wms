import { api, downloadFile, getToken, API_BASE, type ListResult } from './client';

export interface UserInfo {
  id: number;
  username: string;
  displayName: string;
  role: string;
  permissions: string[];
}

export const authApi = {
  login: (username: string, password: string) =>
    api.post<{ token: string; user: UserInfo; permissions: string[] }>('/auth/login', {
      username,
      password,
    }),
  me: () => api.get<{ id: number; username: string; displayName: string; role: string; permissions: string[] }>('/auth/me'),
};

export const dashboardApi = {
  summary: () => api.get<any>('/dashboard/summary'),
};

export const archiveApi = {
  materials: (p?: any) => api.get<ListResult<any>>('/archive/materials', p),
  materialOptions: () => api.get<any[]>('/archive/materials/options'),
  createMaterial: (b: any) => api.post<{ id: number }>('/archive/materials', b),
  updateMaterial: (id: number, b: any) => api.put<{ id: number }>(`/archive/materials/${id}`, b),
  deleteMaterial: (id: number) => api.del<{ id: number }>(`/archive/materials/${id}`),

  products: (p?: any) => api.get<ListResult<any>>('/archive/products', p),
  productOptions: () => api.get<any[]>('/archive/products/options'),
  productDetail: (id: number) => api.get<any>(`/archive/products/${id}`),
  createProduct: (b: any) => api.post<{ id: number }>('/archive/products', b),
  updateProduct: (id: number, b: any) => api.put<{ id: number }>(`/archive/products/${id}`, b),
  deleteProduct: (id: number) => api.del<{ id: number }>(`/archive/products/${id}`),

  suppliers: (p?: any) => api.get<ListResult<any>>('/archive/suppliers', p),
  supplierOptions: () => api.get<any[]>('/archive/suppliers/options'),
  createSupplier: (b: any) => api.post<{ id: number }>('/archive/suppliers', b),
  updateSupplier: (id: number, b: any) => api.put<{ id: number }>(`/archive/suppliers/${id}`, b),
  deleteSupplier: (id: number) => api.del<{ id: number }>(`/archive/suppliers/${id}`),

  customers: (p?: any) => api.get<ListResult<any>>('/archive/customers', p),
  createCustomer: (b: any) => api.post<{ id: number }>('/archive/customers', b),
  updateCustomer: (id: number, b: any) => api.put<{ id: number }>(`/archive/customers/${id}`, b),
  deleteCustomer: (id: number) => api.del<{ id: number }>(`/archive/customers/${id}`),
};

export const inventoryApi = {
  materials: (p?: any) => api.get<ListResult<any>>('/inventory/materials', p),
  products: (p?: any) => api.get<ListResult<any>>('/inventory/products', p),
  detail: (p: any) => api.get<any>('/inventory/detail', p),
  initial: (items: any[]) => api.post<any>('/inventory/initial', { items }),
  // 需求 20：期初库存列表（只读，用于筛选 / 导出）
  initialList: (p?: any) => api.get<ListResult<any>>('/inventory/initial', p),
  ledger: (p?: any) => api.get<ListResult<any>>('/inventory/ledger', p),
  // ---- 多仓库 ----
  warehouses: (p?: any) => api.get<ListResult<any>>('/inventory/warehouses', p),
  warehouseOptions: (itemType?: 'material' | 'product') =>
    api.get<any[]>('/inventory/warehouses/options', itemType ? { itemType } : undefined),
  createWarehouse: (b: any) => api.post<{ id: number }>('/inventory/warehouses', b),
  updateWarehouse: (id: number, b: any) => api.put<{ id: number }>(`/inventory/warehouses/${id}`, b),
  setWarehouseStatus: (id: number, status: '启用' | '停用') =>
    api.post<{ id: number }>(`/inventory/warehouses/${id}/status`, { status }),
  deleteWarehouse: (id: number) => api.del<{ id: number }>(`/inventory/warehouses/${id}`),
  transfers: (p?: any) => api.get<ListResult<any>>('/inventory/transfers', p),
  transferDetail: (id: number) => api.get<any>(`/inventory/transfers/${id}`),
  createTransfer: (b: any) => api.post<{ id: number }>('/inventory/transfers', b),
  undoTransfer: (id: number) => api.post<{ id: number }>(`/inventory/transfers/${id}/undo`),
};

export const purchaseApi = {
  orders: (p?: any) => api.get<ListResult<any>>('/purchase/orders', p),
  orderDetail: (id: number) => api.get<any>(`/purchase/orders/${id}`),
  pending: (id: number) => api.get<any>(`/purchase/orders/${id}/pending`),
  createOrder: (b: any) => api.post<any>('/purchase/orders', b),
  updateOrder: (id: number, b: any) => api.put<{ id: number }>(`/purchase/orders/${id}`, b),
  deleteOrder: (id: number) => api.del<{ id: number }>(`/purchase/orders/${id}`),
  /**
   * 「按主产品 BOM 采购」的物料需求测算（只读）。
   * 服务端做多级 BOM 展开与已占用量计算，前端只负责展示与回填，
   * 避免「前端按单层 BOM 算、服务端按多级扣料」两套口径对不上账。
   */
  bomPreview: (p: { productId: number; planQty?: number }) =>
    api.get<any>('/purchase/orders/bom-preview', p),

  receipts: (p?: any) => api.get<ListResult<any>>('/purchase/receipts', p),
  receiptDetail: (id: number) => api.get<any>(`/purchase/receipts/${id}`),
  createReceipt: (b: any) => api.post<{ id: number }>('/purchase/receipts', b),
  undoReceipt: (id: number) => api.post<{ id: number }>(`/purchase/receipts/${id}/undo`),
  // 物料单价允许填 0 + 价格后补：补录/修改已入库单据单价
  repriceReceipt: (id: number, prices: { materialId: number; price: number }[]) =>
    api.post<{ id: number; totalAmount: number }>(`/purchase/receipts/${id}/reprice`, { prices }),

  returns: (p?: any) => api.get<ListResult<any>>('/purchase/returns', p),
  createReturn: (b: any) => api.post<{ id: number }>('/purchase/returns', b),
  undoReturn: (id: number) => api.post<{ id: number }>(`/purchase/returns/${id}/undo`),

  arrivals: (p?: any) => api.get<ListResult<any>>('/purchase/arrivals', p),

  // OCR 建单（P6）：识别结果只是草稿，确认后仍走 receipts 建单
  ocrRecognize: (b: { fileName: string; mimeType: string; contentBase64: string }) =>
    api.post<{ requestId: string; result: any; durationMs: number }>('/purchase/ocr/recognize', b),
  ocrLogs: () => api.get<any[]>('/purchase/ocr/logs'),
  ocrStats: () => api.get<any>('/purchase/ocr/stats'),
};

export const productionApi = {
  workOrders: (p?: any) => api.get<ListResult<any>>('/production/work-orders', p),
  workOrderOptions: () => api.get<any[]>('/production/work-orders/options'),
  workOrderDetail: (id: number) => api.get<any>(`/production/work-orders/${id}`),
  forReceiptByWo: (id: number) => api.get<any>(`/production/work-orders/${id}/for-receipt`),
  /** 新建 / 复制工单时的物料需求预览（只读展示，不参与校验拦截） */
  bomPreview: (productId: number, planQty: number) =>
    api.get<any>(`/production/work-orders/bom-preview`, { productId, planQty }),
  createWorkOrder: (b: any) => api.post<{ id: number }>('/production/work-orders', b),
  updateWorkOrder: (id: number, b: any) => api.put<{ id: number }>(`/production/work-orders/${id}`, b),
  deleteWorkOrder: (id: number) => api.del<{ id: number }>(`/production/work-orders/${id}`),

  issues: (p?: any) => api.get<ListResult<any>>('/production/issues', p),
  issueDetail: (id: number) => api.get<any>(`/production/issues/${id}`),
  forReceiptByIssue: (id: number) => api.get<any>(`/production/issues/${id}/for-receipt`),
  createIssue: (b: any) => api.post<{ id: number }>('/production/issues', b),
  issueCeiling: (woId: number) =>
    api.get<{ woId: number; planQty: number; issuedNet: number; ceiling: number }>(
      `/production/issues/ceiling/${woId}`,
    ),
  undoIssue: (id: number) => api.post<{ id: number }>(`/production/issues/${id}/undo`),

  // 生产退料：按原领料单原量退回（计划 100 实产 98 场景）
  materialReturns: (p?: any) => api.get<ListResult<any>>('/production/returns', p),
  materialReturnDetail: (id: number) => api.get<any>(`/production/returns/${id}`),
  returnableOf: (issueId: number) => api.get<any>(`/production/returns/returnable/${issueId}`),
  createMaterialReturn: (b: any) => api.post<{ id: number }>('/production/returns', b),
  undoMaterialReturn: (id: number) => api.post<{ id: number }>(`/production/returns/${id}/undo`),

  receipts: (p?: any) => api.get<ListResult<any>>('/production/receipts', p),
  receiptDetail: (id: number) => api.get<any>(`/production/receipts/${id}`),
  createReceipt: (b: any) => api.post<{ id: number }>('/production/receipts', b),
  undoReceipt: (id: number) => api.post<{ id: number }>(`/production/receipts/${id}/undo`),
};

export const saleApi = {
  orders: (p?: any) => api.get<ListResult<any>>('/sale/orders', p),
  orderDetail: (id: number) => api.get<any>(`/sale/orders/${id}`),
  createOrder: (b: any) => api.post<{ id: number }>('/sale/orders', b),

  deliveries: (p?: any) => api.get<ListResult<any>>('/sale/deliveries', p),
  deliveryDetail: (id: number) => api.get<any>(`/sale/deliveries/${id}`),
  createDelivery: (b: any) => api.post<{ id: number }>('/sale/deliveries', b),
  undoDelivery: (id: number) => api.post<{ id: number }>(`/sale/deliveries/${id}/undo`),

  returns: (p?: any) => api.get<ListResult<any>>('/sale/returns', p),
  createReturn: (b: any) => api.post<{ id: number }>('/sale/returns', b),
  undoReturn: (id: number) => api.post<{ id: number }>(`/sale/returns/${id}/undo`),
};

export const warehouseApi = {
  materialSales: (p?: any) => api.get<ListResult<any>>('/warehouse/material-sales', p),
  createMaterialSale: (b: any) => api.post<{ id: number }>('/warehouse/material-sales', b),
  undoMaterialSale: (id: number) => api.post<{ id: number }>(`/warehouse/material-sales/${id}/undo`),

  defectives: (p?: any) => api.get<ListResult<any>>('/warehouse/defectives', p),
  createDefective: (b: any) => api.post<{ id: number }>('/warehouse/defectives', b),
  undoDefective: (id: number) => api.post<{ id: number }>(`/warehouse/defectives/${id}/undo`),

  checks: (p?: any) => api.get<ListResult<any>>('/warehouse/checks', p),
  checkDetail: (id: number) => api.get<any>(`/warehouse/checks/${id}`),
  createCheck: (b: any) => api.post<{ id: number }>('/warehouse/checks', b),
  auditCheck: (id: number) => api.post<{ id: number }>(`/warehouse/checks/${id}/audit`),
  undoCheck: (id: number) => api.post<{ id: number }>(`/warehouse/checks/${id}/undo`),

  simulate: (items: any[]) => api.post<any>('/warehouse/simulate', { items }),
  simulateToWorkOrders: (items: any[]) => api.post<any>('/warehouse/simulate/to-work-orders', { items }),

  alarm: (p?: any) => api.get<any>('/warehouse/alarm', p),
};

export const financeApi = {
  payables: () => api.get<any[]>('/finance/payables'),
  payableDocs: (supplierId: number) =>
    api.get<{ supplier: any; docs: any[] }>(`/finance/payables/${supplierId}/docs`),
  previewSettle: (b: any) => api.post<any>('/finance/settlements/preview', b),
  settlements: (p?: any) => api.get<ListResult<any>>('/finance/settlements', p),
  settlementDetail: (id: number) =>
    api.get<{ settlement: any; items: any[] }>(`/finance/settlements/${id}`),
  createSettlement: (b: any) => api.post<{ id: number }>('/finance/settlements', b),
  undoSettlement: (id: number) => api.post<{ id: number }>(`/finance/settlements/${id}/undo`),
};

export const reportApi = {
  meta: () => api.get<any[]>('/reports/meta'),
  data: (p: any) => api.get<{ columns: any[]; rows: any[]; meta: any }>('/reports/data', p),
};

export const backupApi = {
  // 需求 30：备份所有模块数据
  tables: () => api.get<any>('/system/backup/tables'),
  exportAll: () => api.get<any>('/system/backup/export'),
  downloadDb: () => downloadFile('/system/backup/db', `数据备份.db`),
};

export const printApi = {
  templates: () => api.get<any[]>('/system/print/templates'),
  template: (docType: string) => api.get<any>(`/system/print/templates/${docType}`),
  saveTemplate: (docType: string, b: any) => api.put<any>(`/system/print/templates/${docType}`, b),
  resetTemplate: (docType: string) => api.post<any>(`/system/print/templates/${docType}/reset`),
  fields: (docType: string) => api.get<any>(`/system/print/fields/${docType}`),
  preview: (b: any) => api.post<{ html: string }>('/system/print/preview', b),
  /** 打印页地址：返回完整 HTML，直接用 window.open 打开再调 print() */
  renderUrl: (docType: string, id: number) =>
    `${API_BASE}/system/print/render/${docType}/${id}?token=${encodeURIComponent(getToken() ?? '')}`,
};

export const importApi = {
  kinds: () => api.get<any[]>('/system/import/kinds'),
  preview: (b: any) => api.post<{ total: number; errors: any[] }>('/system/import/preview', b),
  execute: (b: any) =>
    api.post<{ total: number; success: number; failed: number; errors: any[] }>(
      '/system/import/execute',
      b,
    ),
  logs: () => api.get<any[]>('/system/import/logs'),
};

export const systemApi = {
  users: (p?: any) => api.get<ListResult<any>>('/system/users', p),
  createUser: (b: any) => api.post<{ id: number }>('/system/users', b),
  updateUser: (id: number, b: any) => api.put<{ id: number }>(`/system/users/${id}`, b),
  changePassword: (id: number, newPassword: string, confirmPassword: string) =>
    api.post<{ id: number; kicked: boolean }>(`/system/users/${id}/password`, {
      newPassword,
      confirmPassword,
    }),
  logs: (p?: any) => api.get<ListResult<any>>('/system/logs', p),
  roles: () => api.get<{ value: string; label: string }[]>('/system/roles'),
};
