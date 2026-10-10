import { Card, Table } from 'antd';
import { systemApi } from '../../api';
import { useList } from '../../hooks/useList';
import { ResponsiveTable } from '../../components';

/** 操作日志：改密码、撤销、初始化等敏感动作均留痕（需求 4.3 / 4.8） */
export default function LogPage() {
  const { list, total, loading, params, patchParams } = useList<any>((p) => systemApi.logs(p));

  return (
    <Card title="操作日志">
      <ResponsiveTable
        rowKey="id"
        size="small"
        loading={loading}
        dataSource={list}
        scroll={{ x: 1000 }}
        pagination={{
          current: params.page,
          pageSize: params.pageSize,
          total,
          onChange: (page, pageSize) => patchParams({ page, pageSize }),
          showSizeChanger: true,
        }}
        columns={[
          { title: '操作人', dataIndex: 'operator_name', width: 130 },
          { title: '动作', dataIndex: 'action', width: 200 },
          { title: '对象类型', dataIndex: 'target_type', width: 140 },
          { title: '对象 ID', dataIndex: 'target_id', width: 90, className: 'mono' },
          { title: '详情', dataIndex: 'detail', ellipsis: true },
          {
            title: '时间',
            dataIndex: 'created_at',
            width: 170,
            render: (v) => String(v).slice(0, 19).replace('T', ' '),
          },
        ]}
      />
    </Card>
  );
}
