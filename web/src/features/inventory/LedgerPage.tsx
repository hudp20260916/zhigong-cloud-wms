import { Select, Card, Space, Table, Tag, Button, message } from 'antd';
import { inventoryApi } from '../../api';
import { useList } from '../../hooks/useList';
import { PriceText, ResponsiveTable } from '../../components';
import { useAuthStore } from '../../stores/auth';
import { exportCsv } from '../../utils/exportCsv';

const BIZ_TYPES = [
  '期初库存',
  '采购入库',
  '采购退货',
  '生产领料',
  '成品入库',
  '销售出库',
  '销售退货',
  '物料销售',
  '不良品出库',
  '盘点调整',
];

/** 流水台账：全量原子流水，撤销记录划线保留；全台账不展示入库单号（需求 3.7.5 / 4.5） */
export default function LedgerPage() {
  const { list, total, loading, params, patchParams } = useList<any>((p) => inventoryApi.ledger(p));
  const has = useAuthStore((s) => s.has);
  const canViewPrice = has('price.view');
  const canExport = has('export.data');

  return (
    <Card
      title="流水台账"
      extra={
        <Space>
          <Select
            style={{ width: 140 }}
            allowClear
            placeholder="库存对象"
            value={params.itemType}
            onChange={(itemType) => patchParams({ itemType })}
            options={[
              { value: 'material', label: '物料' },
              { value: 'product', label: '成品' },
            ]}
          />
          <Select
            style={{ width: 150 }}
            allowClear
            placeholder="业务类型"
            value={params.bizType}
            onChange={(bizType) => patchParams({ bizType })}
            options={BIZ_TYPES.map((b) => ({ value: b, label: b }))}
          />
          {/* 需求 21：按方向（入库 / 出库）筛选 */}
          <Select
            style={{ width: 130 }}
            allowClear
            placeholder="方向"
            value={params.direction}
            onChange={(direction) => patchParams({ direction })}
            options={[
              { value: 'in', label: '入库' },
              { value: 'out', label: '出库' },
            ]}
          />
          <Button
            onClick={async () => {
              if (!canExport) {
                message.warning('无数据导出权限');
                return;
              }
              // 需求 21：导出跟随筛选结果
              const res = await inventoryApi.ledger({ ...params, page: 1, pageSize: 50000 });
              const columns: any[] = [
                { title: '库存对象', key: 'item_name' },
                { title: '类型', key: 'item_type', render: (r: any) => (r.item_type === 'material' ? '物料' : '成品') },
                { title: '业务类型', key: 'biz_type' },
                { title: '方向', key: 'direction', render: (r: any) => (r.direction === 'in' ? '入库' : '出库') },
                { title: '数量', key: 'qty' },
                { title: '结存', key: 'balance_after' },
              ];
              if (canViewPrice) columns.push({ title: '单价', key: 'unit_price' }, { title: '金额', key: 'amount' });
              columns.push(
                { title: '操作人', key: 'operator_name' },
                { title: '时间', key: 'created_at', render: (r: any) => String(r.created_at).slice(0, 19).replace('T', ' ') },
              );
              exportCsv('流水台账', columns, res.list ?? []);
            }}
          >
            导出
          </Button>
        </Space>
      }
    >
      <ResponsiveTable
        rowKey="id"
        size="small"
        loading={loading}
        dataSource={list}
        scroll={{ x: 1200 }}
        rowClassName={(r: any) => (r.status === '已撤销' || r.is_reversal === 1 ? 'voided-row' : '')}
        pagination={{
          current: params.page,
          pageSize: params.pageSize,
          total,
          onChange: (page, pageSize) => patchParams({ page, pageSize }),
          showSizeChanger: true,
        }}
        columns={[
          { title: '库存对象', dataIndex: 'item_name', width: 180 },
          {
            title: '类型',
            dataIndex: 'item_type',
            width: 80,
            render: (v) => (v === 'material' ? '物料' : '成品'),
          },
          {
            title: '业务类型',
            dataIndex: 'biz_type',
            width: 110,
            render: (v, r: any) => (
              <span style={{ textDecoration: r.status === '已撤销' ? 'line-through' : undefined }}>{v}</span>
            ),
          },
          {
            title: '方向',
            dataIndex: 'direction',
            width: 80,
            render: (v) => <Tag color={v === 'in' ? 'red' : 'green'}>{v === 'in' ? '入库' : '出库'}</Tag>,
          },
          { title: '数量', dataIndex: 'qty', width: 90, className: 'mono' },
          { title: '结存', dataIndex: 'balance_after', width: 90, className: 'mono' },
          ...(canViewPrice
            ? [
                { title: '单价', dataIndex: 'unit_price', width: 90, render: (v: any) => <PriceText value={v} /> },
                { title: '金额', dataIndex: 'amount', width: 100, render: (v: any) => <PriceText value={v} /> },
              ]
            : []),
          { title: '操作人', dataIndex: 'operator_name', width: 110 },
          {
            title: '时间',
            dataIndex: 'created_at',
            width: 170,
            render: (v) => String(v).slice(0, 19).replace('T', ' '),
          },
          {
            title: '状态',
            dataIndex: 'status',
            width: 100,
            render: (v, r: any) => (r.is_reversal === 1 ? <Tag>撤销对冲</Tag> : <Tag color="blue">{v}</Tag>),
          },
        ]}
      />
    </Card>
  );
}
