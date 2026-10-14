import type { ReactNode } from 'react';
import { Button, Result, Space, Tag } from 'antd';
import { useAuthStore } from '../stores/auth';
import { PrintButton } from './PrintButton';
import { ResponsiveTable } from './ResponsiveTable';
import { DockAction } from './DockAction';
import ImportExcelModal from './ImportExcelModal';
import { CopyableCode } from './CopyableCode';
import { DetailTable } from './DetailTable';
import { FilterBar } from './FilterBar';
import { SearchableSelect } from './SearchableSelect';
import { ErrorBoundary } from './ErrorBoundary';
import { Modal } from './DraggableModal';
import { TopActionBar, RowActionButton, RowActionGate, useRowSelect } from './RowActions';
import {
  ColumnSettings,
  columnKeyOf,
  columnOptionsOf,
  visibleColumnsOf,
  useColumnHidden,
} from './ColumnSettings';
import {
  WarehouseSelect,
  useWarehouseOptions,
  clearWarehouseOptionsCache,
} from './WarehouseSelect';
import type { WarehouseOption } from './WarehouseSelect';

export {
  PrintButton,
  ResponsiveTable,
  DockAction,
  ImportExcelModal,
  CopyableCode,
  DetailTable,
  FilterBar,
  SearchableSelect,
  ErrorBoundary,
  // 全系统统一弹窗：用法与 antd Modal 完全一致，额外支持标题栏拖拽
  Modal,
  TopActionBar,
  RowActionButton,
  RowActionGate,
  useRowSelect,
  // 表格列显示设置（工具栏「设置」按钮 + 勾选面板）
  ColumnSettings,
  columnKeyOf,
  columnOptionsOf,
  visibleColumnsOf,
  useColumnHidden,
  // 多仓库：出入库表单的仓库选择与下拉数据源
  WarehouseSelect,
  useWarehouseOptions,
  clearWarehouseOptionsCache,
};
export type { WarehouseOption };

/** 按钮级权限控制：无权限时不渲染，避免出现「看得见点不动」 */
export function PermGate({
  permission,
  children,
  fallback = null,
}: {
  permission: string;
  children: ReactNode;
  fallback?: ReactNode;
}) {
  const has = useAuthStore((s) => s.has);
  return <>{has(permission) ? children : fallback}</>;
}

/** 页面级权限：无权限时展示统一提示 */
export function PermPage({ permission, children }: { permission: string; children: ReactNode }) {
  const has = useAuthStore((s) => s.has);
  if (!has(permission)) {
    return (
      <Result
        status="403"
        title="无访问权限"
        subTitle="当前角色没有该页面的访问权限，请联系管理员调整权限"
      />
    );
  }
  return <>{children}</>;
}

/** 价格脱敏展示：无价格权限显示 *** */
export function PriceText({ value, suffix = '' }: { value: any; suffix?: string }) {
  const has = useAuthStore((s) => s.has);
  if (!has('price.view')) return <span>***</span>;
  const n = Number(value ?? 0);
  return <span>{n.toFixed(2)}{suffix}</span>;
}

export function StatusTag({ status }: { status: string }) {
  const colorMap: Record<string, string> = {
    进行中: 'processing',
    已完成: 'success',
    已撤销: 'default',
    已关闭: 'default',
    有效: 'success',
    已到齐: 'success',
    部分到货: 'warning',
    未到货: 'default',
  };
  return <Tag color={colorMap[status] ?? 'default'}>{status}</Tag>;
}

export function ActionBar({ children }: { children: ReactNode }) {
  return (
    <Space wrap style={{ marginBottom: 12 }}>
      {children}
    </Space>
  );
}

export function DangerButton({ children, ...rest }: any) {
  return (
    <Button danger size="small" type="link" {...rest}>
      {children}
    </Button>
  );
}
