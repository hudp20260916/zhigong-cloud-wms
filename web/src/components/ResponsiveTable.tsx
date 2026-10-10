import type { ReactNode } from 'react';
import { Empty, Pagination, Spin, Table } from 'antd';
import type { TableColumnType, TablePaginationConfig, TableProps } from 'antd';
import { useIsMobile } from '../hooks/useIsMobile';

export interface ResponsiveTableProps extends Omit<TableProps<any>, 'columns'> {
  columns: TableColumnType<any>[];
  /** 卡片模式下作为标题的列（不传则取第一列） */
  titleKey?: string;
  /** 卡片模式下作为副标题的列 */
  subtitleKey?: string;
  /** 空态文案 */
  emptyText?: string;
}

function isOperationColumn(c: TableColumnType<any>): boolean {
  return c.title === '操作' || c.key === 'operation';
}

/**
 * 响应式表格。
 *
 * 桌面端就是原生 antd Table（视觉与交互完全不变）；
 * ≤768px 自动降级为卡片列表 —— 这是「小屏不出现横向滚动」的关键：
 * 进销存单据列普遍有 8~12 列，靠横滚看数据在手机上几乎不可用，
 * 改成「标题 + 副标题 + 字段对 + 底部操作」的卡片后单列纵向滚动即可浏览。
 *
 * 使用方式与 antd Table 完全一致，因此各业务页面只需把 <Table> 换成 <ResponsiveTable>。
 */
export function ResponsiveTable({
  columns,
  dataSource,
  rowKey = 'id',
  titleKey,
  subtitleKey,
  emptyText = '暂无数据',
  ...rest
}: ResponsiveTableProps) {
  const isMobile = useIsMobile();

  if (!isMobile) {
    return <Table columns={columns} dataSource={dataSource} rowKey={rowKey} {...rest} />;
  }

  const rows = (dataSource ?? []) as any[];
  // 卡片模式下 Table 的 pagination / loading 配置不会自动生效，这里单独渲染，
  // 否则手机上会「只能看第一页」而无法翻页
  const pagination: TablePaginationConfig | false | undefined = rest.pagination;
  const pager =
    pagination && typeof pagination === 'object' ? (
      <Pagination
        style={{ marginTop: 12, textAlign: 'center' }}
        size="small"
        current={pagination.current}
        pageSize={pagination.pageSize}
        total={pagination.total ?? rows.length}
        showSizeChanger={false}
        onChange={(page, pageSize) => pagination.onChange?.(page, pageSize)}
      />
    ) : null;

  if (rest.loading) {
    return (
      <div style={{ textAlign: 'center', padding: '32px 0' }}>
        <Spin />
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <>
        <Empty description={emptyText} style={{ padding: '24px 0' }} />
        {pager}
      </>
    );
  }

  const dataColumns = columns.filter((c) => !isOperationColumn(c));
  const actionColumn = columns.find(isOperationColumn);

  const titleCol =
    (titleKey ? dataColumns.find((c) => c.dataIndex === titleKey) : undefined) ?? dataColumns[0];
  const subCol =
    (subtitleKey ? dataColumns.find((c) => c.dataIndex === subtitleKey) : undefined) ??
    dataColumns[1];
  const restCols = dataColumns.filter((c) => c !== titleCol && c !== subCol);

  return (
    <>
      <div className="mobile-card-list">
        {rows.map((row, idx) => {
        const key =
          typeof rowKey === 'function' ? (rowKey as any)(row) : (row as any)[rowKey as string];
        const titleNode = renderCell(titleCol, row, idx);
        const subNode = subCol ? renderCell(subCol, row, idx) : null;

        return (
          <div className="mobile-card" key={key ?? idx}>
            {notEmpty(titleNode) && <div className="mobile-card__title">{titleNode}</div>}
            {notEmpty(subNode) && <div className="mobile-card__sub">{subNode}</div>}

            <div className="mobile-card__fields">
              {restCols.map((c, i) => {
                const v = renderCell(c, row, i);
                if (!notEmpty(v)) return null;
                return (
                  <div
                    key={String(c.key ?? c.dataIndex ?? i)}
                    style={{ display: 'contents' }}
                  >
                    <div className="mobile-card__label">{c.title as ReactNode}</div>
                    <div className="mobile-card__value">{v}</div>
                  </div>
                );
              })}
            </div>

            {actionColumn && (
              <div className="mobile-card__actions">
                {actionColumn.render
                  ? actionColumn.render(row, row, idx)
                  : actionColumn.dataIndex
                    ? row[actionColumn.dataIndex]
                    : null}
              </div>
            )}
          </div>
        );
        })}
      </div>
      {pager}
    </>
  );
}

function renderCell(col: TableColumnType<any> | undefined, row: any, idx: number): ReactNode {
  if (!col) return null;
  const raw = col.dataIndex ? row[col.dataIndex as string] : undefined;
  if (!col.render) return raw as ReactNode;
  // antd 的 render 可能返回 RenderedCell（含 colSpan 等），这里只取 children
  const out: any = col.render(raw, row, idx);
  return out && typeof out === 'object' && 'children' in out ? (out.children as ReactNode) : (out as ReactNode);
}

function notEmpty(v: ReactNode): boolean {
  return v !== null && v !== undefined && v !== '' && v !== false;
}

export default ResponsiveTable;
