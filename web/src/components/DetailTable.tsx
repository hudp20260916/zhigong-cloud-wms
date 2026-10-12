import { Alert, Spin, Table } from 'antd';
import type { TableColumnType } from 'antd';

/**
 * 列表行展开区里的明细小表（需求 5/6/10/12/13）。
 *
 * 统一用「无分页 + size=small + 灰底」的样式，让展开区看起来是主行的附属信息，
 * 而不是又一张独立表格。列定义由调用方给，因为不同单据的明细字段差别很大。
 */
export function DetailTable({
  loading,
  items,
  columns,
  emptyText = '该单据没有明细',
  error,
}: {
  loading?: boolean;
  items?: any[];
  columns: TableColumnType<any>[];
  emptyText?: string;
  error?: string;
}) {
  if (loading) {
    return (
      <div style={{ padding: '18px 0', textAlign: 'center' }}>
        <Spin size="small" />
      </div>
    );
  }

  if (error) return <Alert type="error" showIcon message={error} style={{ margin: 8 }} />;

  if (!items || items.length === 0) {
    return <div style={{ padding: '10px 12px', color: '#8c8c8c', fontSize: 12 }}>{emptyText}</div>;
  }

  return (
    <div style={{ background: 'var(--bg-elevated, #fafafa)', borderRadius: 8, padding: '8px 10px', margin: '4px 0' }}>
      <Table
        size="small"
        rowKey={(_r, i) => String(i)}
        dataSource={items}
        pagination={false}
        columns={columns}
      />
    </div>
  );
}

export default DetailTable;
