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
  /**
   * 「点行任意位置即选中」回调（桌面端表格行 + ≤768px 卡片**同时生效**）。
   *
   * 之前只有卡片模式实现了它，桌面端必须点行首的单选圆点才能选中，
   * 造成同一套「先选中、再点顶部按钮」的交互在两块屏幕上不一致，
   * 所以下沉到组件里统一：桌面走 antd 的 onRow，卡片走 div onClick，
   * 两处共用同一套「自身可交互元素不触发选中」的排除规则。
   */
  onRowClick?: (row: any) => void;
  /** 需要高亮的行 key（桌面端加 `row-selected`，卡片模式走 `mobile-card--selected`） */
  selectedRowKeys?: React.Key[];
}

/**
 * 行内「自身可交互」的元素：点它们不应触发行选中。
 *
 * 覆盖三类：
 * - 表单控件与按钮类（button / a / input / textarea / select / label / [role=button]）
 * - 表格自带控件（展开箭头 .ant-table-row-expand-icon、勾选列 .ant-table-selection-column）
 * - 逃生舱：业务组件不想被行选中接管时自己加 `data-row-click-ignore`
 */
export const ROW_CLICK_IGNORE =
  'button, a, input, textarea, select, label, [role="button"], ' +
  '.ant-table-row-expand-icon, .ant-table-selection-column, ' +
  '.ant-checkbox-wrapper, .ant-radio-wrapper, [data-row-click-ignore]';

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
  onRowClick,
  selectedRowKeys,
  rowClassName,
  onRow,
  ...rest
}: ResponsiveTableProps) {
  const isMobile = useIsMobile();

  /** 取行 key：rowKey 可能是字段名也可能是函数（复合主键页会传函数） */
  const keyOf = (row: any, idx: number): React.Key =>
    typeof rowKey === 'function' ? (rowKey as any)(row, idx) : (row as any)[rowKey as string];

  // 桌面端没有传 selectedRowKeys 时，退回 rowSelection.selectedRowKeys，
  // 这样「只传了 rowSelection」的页面也能拿到高亮，不用每个页面补一遍
  const keys: React.Key[] =
    selectedRowKeys ?? ((rest as any).rowSelection?.selectedRowKeys as React.Key[]) ?? [];

  if (!isMobile) {
    const isKeySelected = (row: any, idx: number) =>
      Array.isArray(keys) && keys.some((k) => String(k) === String(keyOf(row, idx)));

    // 与调用方自己的 rowClassName 合并，不能覆盖（库存页有 low-stock-row、台账页有 voided-row）
    const mergedRowClassName = (row: any, idx: number, indent: number) => {
      const base = typeof rowClassName === 'function' ? rowClassName(row, idx, indent) : rowClassName;
      return [base, isKeySelected(row, idx) ? 'row-selected' : ''].filter(Boolean).join(' ');
    };

    // 与调用方自己的 onRow 合并（生产工单页之前就是自己写 onRow 实现点行选中）
    const mergedOnRow = (row: any, idx?: number) => {
      const base = (typeof onRow === 'function' ? onRow(row, idx as number) : onRow) ?? {};
      if (!onRowClick) return base;
      return {
        ...base,
        onClick: (e: React.MouseEvent) => {
          const t = e.target as HTMLElement | null;
          // 点展开箭头 / 勾选列 / 行内按钮链接时，只走它们自己的行为，不改变选中态
          if (!t?.closest?.(ROW_CLICK_IGNORE)) onRowClick(row);
          (base as any).onClick?.(e);
        },
      };
    };

    return (
      <Table
        columns={columns}
        dataSource={dataSource}
        rowKey={rowKey}
        rowClassName={mergedRowClassName}
        onRow={mergedOnRow}
        {...rest}
      />
    );
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
        const key = keyOf(row, idx);
        const titleNode = renderCell(titleCol, row, idx);
        const subNode = subCol ? renderCell(subCol, row, idx) : null;

        // 卡片模式下 antd 的 rowSelection 不会生效，这里用 selectedRowKeys 自行判断高亮
        const isSelected = Array.isArray(keys) && keys.some((k) => String(k) === String(key));

        return (
          <div
            className={`mobile-card${isSelected ? ' mobile-card--selected' : ''}`}
            key={key ?? idx}
            onClick={
              onRowClick
                ? (e) => {
                    // 与桌面端同一套排除规则：点卡片里的按钮 / 链接不改变选中态
                    const t = e.target as HTMLElement | null;
                    if (!t?.closest?.(ROW_CLICK_IGNORE)) onRowClick(row);
                  }
                : undefined
            }
            style={{
              cursor: onRowClick ? 'pointer' : undefined,
              // 用主题变量而非硬编码色，明暗主题自动适配；
              // 内联优先级最高，避免被 .theme-dark .mobile-card 覆盖
              ...(isSelected
                ? {
                    background: 'var(--hl-soft)',
                    borderColor: 'var(--hl)',
                    boxShadow: 'inset 3px 0 0 var(--hl)',
                  }
                : null),
            }}
          >
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
