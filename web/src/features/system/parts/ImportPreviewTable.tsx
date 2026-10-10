import { forwardRef, memo } from 'react';
import { Table, Tag } from 'antd';
import { ResponsiveTable } from '../../../components';
import { isBlank, type ColumnDef } from './utils';

export interface ImportPreviewTableProps {
  columns: ColumnDef[];
  rows: any[];
  /** 文件行号 -> 服务端返回的错误信息 */
  errByRow: Map<number, string>;
  /** 前端自检出的空行 */
  emptyRows: number[];
  /** 前端自检出的重复行：文件行号 -> 说明 */
  duplicated: Map<number, string>;
}

/**
 * 解析结果的预览表。
 *
 * 同样是纯展示组件：所有数据由父级算好传进来，
 * 这样父级在输入框里敲一个字也不会把整张表重排一遍。
 */
export const ImportPreviewTable = memo(
  forwardRef<HTMLDivElement, ImportPreviewTableProps>(function ImportPreviewTable(
    { columns, rows, errByRow, emptyRows, duplicated },
    ref,
  ) {
    const emptySet = new Set(emptyRows);

    return (
      <div ref={ref}>
        <Table
          size="small"
          rowKey={(_r, i) => String(i)}
          dataSource={rows}
          scroll={{ x: 900, y: 380 }}
          pagination={{ pageSize: 50, size: 'small' }}
          rowClassName={(_r, i) => {
            const fileRow = (i ?? 0) + 2;
            if (errByRow.has(fileRow) || duplicated.has(fileRow)) return 'row-error';
            if (emptySet.has(fileRow)) return 'row-muted';
            return '';
          }}
          columns={[
            {
              title: '行号',
              width: 68,
              fixed: 'left' as const,
              render: (_v, _r, i) => (i ?? 0) + 2,
            },
            ...columns.map((c) => ({
              title: c.label + (c.required ? ' *' : ''),
              dataIndex: c.key,
              key: c.key,
              width: 140,
              render: (v: any) =>
                isBlank(v) ? <span style={{ color: '#bbb' }}>—</span> : String(v),
            })),
            {
              title: '校验结果',
              width: 240,
              render: (_v, _r, i) => {
                const fileRow = (i ?? 0) + 2;
                const fromServer = errByRow.get(fileRow);
                const dup = duplicated.get(fileRow);
                if (fromServer) return <span style={{ color: '#cf1322' }}>{fromServer}</span>;
                if (dup) return <span style={{ color: '#d46b08' }}>{dup}（同一批内重复）</span>;
                if (emptySet.has(fileRow)) return <Tag color="default">整行为空，导入时将跳过</Tag>;
                return <Tag color="green">通过</Tag>;
              },
            },
          ]}
        />
      </div>
    );
  }),
);

export default ImportPreviewTable;
