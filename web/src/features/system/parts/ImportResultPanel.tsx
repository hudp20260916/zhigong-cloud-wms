import { forwardRef, memo } from 'react';
import { Alert, Progress, Table } from 'antd';

export interface ImportResultPanelProps {
  total: number;
  success: number;
  failed: number;
  errors: { row: number; message: string }[];
  /** 与本次导入一起被前端自检跳过的空行数 */
  skippedEmpty: number;
}

/** 导入完成后的结果面板（纯展示，forwardRef + memo） */
export const ImportResultPanel = memo(
  forwardRef<HTMLDivElement, ImportResultPanelProps>(function ImportResultPanel(
    { total, success, failed, errors, skippedEmpty },
    ref,
  ) {
    const percent = Math.round((success / Math.max(1, total)) * 100);

    return (
      <div ref={ref}>
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 16,
            alignItems: 'center',
            padding: '18px 20px',
            borderRadius: 14,
            border: `1px solid ${failed > 0 ? '#ffccc7' : '#b7eb8f'}`,
            background: failed > 0 ? '#fff7f6' : '#f6ffed',
          }}
        >
          <Progress
            type="circle"
            percent={percent}
            size={92}
            status={failed > 0 ? 'exception' : 'success'}
          />
          <div style={{ flex: '1 1 220px', minWidth: 200 }}>
            <div style={{ fontSize: 17, fontWeight: 700, marginBottom: 6 }}>
              {failed > 0 ? '导入未通过，已整批回滚' : '导入完成'}
            </div>
            <div style={{ color: '#555', lineHeight: 1.9 }}>
              共 <b>{total}</b> 行 · 成功 <b style={{ color: '#389e0d' }}>{success}</b> 行 · 失败{' '}
              <b style={{ color: failed > 0 ? '#cf1322' : '#999' }}>{failed}</b> 行
              {skippedEmpty > 0 && <> · 跳过空行 <b>{skippedEmpty}</b> 行</>}
            </div>
          </div>
        </div>

        {failed > 0 && (
          <Alert
            type="warning"
            showIcon
            style={{ marginTop: 12 }}
            message="存在失败行时整批回滚，不会留下半截数据"
            description="请按下方明细修正后重新导入。"
          />
        )}

        {errors.length > 0 && (
          <Table
            style={{ marginTop: 12 }}
            size="small"
            rowKey="row"
            dataSource={errors}
            pagination={{ pageSize: 8, size: 'small' }}
            columns={[
              { title: '行号', dataIndex: 'row', width: 80 },
              { title: '原因', dataIndex: 'message' },
            ]}
          />
        )}
      </div>
    );
  }),
);

export default ImportResultPanel;
