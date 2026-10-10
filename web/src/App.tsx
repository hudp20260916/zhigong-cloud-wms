import { lazy, Suspense, useEffect } from 'react';
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Spin } from 'antd';
import { useAuthStore } from './stores/auth';
import MainLayout from './layouts/MainLayout';
import LoginPage from './features/auth/LoginPage';
import DashboardPage from './features/dashboard/DashboardPage';
import MaterialPage from './features/archive/MaterialPage';
import ProductPage from './features/archive/ProductPage';
import PartnerPage from './features/archive/PartnerPage';
import StockPage from './features/inventory/StockPage';
import InitialStockPage from './features/inventory/InitialStockPage';
import LedgerPage from './features/inventory/LedgerPage';
import WorkOrderPage from './features/production/WorkOrderPage';
import IssuePage from './features/production/IssuePage';
import ProductReceiptPage from './features/production/ProductReceiptPage';
import PurchaseOrderPage from './features/purchase/PurchaseOrderPage';
import PurchaseReceiptPage from './features/purchase/PurchaseReceiptPage';
import PurchaseReturnPage from './features/purchase/PurchaseReturnPage';
import ArrivalPage from './features/purchase/ArrivalPage';
import SaleOrderPage from './features/sale/SaleOrderPage';
import SaleDeliveryPage from './features/sale/SaleDeliveryPage';
import SaleReturnPage from './features/sale/SaleReturnPage';
import MaterialSalePage from './features/warehouse/MaterialSalePage';
import DefectivePage from './features/warehouse/DefectivePage';
import StockCheckPage from './features/warehouse/StockCheckPage';
import SimulatePage from './features/warehouse/SimulatePage';
import AlarmPage from './features/warehouse/AlarmPage';
import UserPage from './features/system/UserPage';
import LogPage from './features/system/LogPage';
import SettlementPage from './features/finance/SettlementPage';
import ReportPage from './features/finance/ReportPage';
import PrintTemplatePage from './features/system/PrintTemplatePage';
import SettingsPage from './features/system/SettingsPage';
import SystemInitPage from './features/system/SystemInitPage';

/**
 * Excel 导入页依赖 SheetJS（约 500KB），只对「系统管理 - 批量导入」这一个入口有用，
 * 因此做路由级懒加载，避免拖慢主包。
 */
const ImportPage = lazy(() => import('./features/system/ImportPage'));

function PageLoading() {
  return (
    <div style={{ height: '100%', display: 'grid', placeItems: 'center' }}>
      <Spin />
    </div>
  );
}

export default function App() {
  const ready = useAuthStore((s) => s.ready);
  const token = useAuthStore((s) => s.token);
  const init = useAuthStore((s) => s.init);

  useEffect(() => {
    init();
  }, [init]);

  if (!ready) {
    return (
      <div style={{ height: '100%', display: 'grid', placeItems: 'center' }}>
        <Spin size="large" tip="加载中" />
      </div>
    );
  }

  return (
    <HashRouter>
      <Routes>
        <Route path="/login" element={token ? <Navigate to="/dashboard" replace /> : <LoginPage />} />
        <Route
          path="/"
          element={
            token ? (
              <Suspense fallback={<PageLoading />}>
                <MainLayout />
              </Suspense>
            ) : (
              <Navigate to="/login" replace />
            )
          }
        >
          <Route index element={<Navigate to="/dashboard" replace />} />
          <Route path="dashboard" element={<DashboardPage />} />
          <Route path="archive/materials" element={<MaterialPage />} />
          <Route path="archive/products" element={<ProductPage />} />
          <Route path="archive/suppliers" element={<PartnerPage kind="supplier" />} />
          <Route path="archive/customers" element={<PartnerPage kind="customer" />} />
          <Route path="inventory/stock" element={<StockPage />} />
          <Route path="inventory/initial" element={<InitialStockPage />} />
          <Route path="inventory/ledger" element={<LedgerPage />} />
          <Route path="production/work-orders" element={<WorkOrderPage />} />
          <Route path="production/issues" element={<IssuePage />} />
          <Route path="production/receipts" element={<ProductReceiptPage />} />
          <Route path="purchase/orders" element={<PurchaseOrderPage />} />
          <Route path="purchase/receipts" element={<PurchaseReceiptPage />} />
          <Route path="purchase/arrivals" element={<ArrivalPage />} />
          <Route path="purchase/returns" element={<PurchaseReturnPage />} />
          <Route path="sale/orders" element={<SaleOrderPage />} />
          <Route path="sale/deliveries" element={<SaleDeliveryPage />} />
          <Route path="sale/returns" element={<SaleReturnPage />} />
          <Route path="warehouse/material-sales" element={<MaterialSalePage />} />
          <Route path="warehouse/defectives" element={<DefectivePage />} />
          <Route path="warehouse/checks" element={<StockCheckPage />} />
          <Route path="warehouse/simulate" element={<SimulatePage />} />
          <Route path="warehouse/alarm" element={<AlarmPage />} />
          <Route path="system/users" element={<UserPage />} />
          <Route path="system/logs" element={<LogPage />} />
          <Route path="system/print" element={<PrintTemplatePage />} />
          <Route path="system/import" element={<ImportPage />} />
          <Route path="system/settings" element={<SettingsPage />} />
          <Route path="system/init" element={<SystemInitPage />} />
          <Route path="finance/settlements" element={<SettlementPage />} />
          <Route path="reports" element={<ReportPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
    </HashRouter>
  );
}
