import { Button, Card, Input, Space, Table, Tag, Tooltip } from 'antd';
import { purchaseApi } from '../../api';
import { useList } from '../../hooks/useList';
import { PriceText, ResponsiveTable } from '../../components';
import { exportCsv, today } from '../../utils/exportCsv';

/** 到货核对：采购内容列 + 主产品/物料名称搜索 + 导出同步包含采购内容（需求 3.4.5） */
export default function ArrivalPage() {
  const { list, total, loading, params, patchParams } = useList<any>((p) => purchaseApi.arrivals(p));

  return (
    <Card
      title="采购订单到货核对"
      extra={
        <Space>
          <Input.Search
            placeholder="主产品名称 / 物料名称 / 订单号"
            allowClear
            style={{ width: 260 }}
            onSearch={(keyword) => patchParams({ keyword })}
          />
          <Button
            onClick={() =>
              exportCsv(
                `到货核对_${today()}`,
                [
                  { title: '订单编号', key: 'order_no' },
                  { title: '父订单号', key: 'parent_order_no' },
                  { title: '采购内容', key: 'purchaseContent' },
                  { title: '供应商', key: 'supplier_name' },
                  { title: '物料编码', key: 'material_code' },
                  { title: '物料名称', key: 'material_name' },
                  { title: '规格', key: 'spec' },
                  { title: '下单量', key: 'order_qty' },
                  { title: '已入库', key: 'received_qty' },
                  { title: '未入库', key: 'pendingQty' },
                  { title: '单价', key: 'price' },
                  { title: '到货状态', key: 'arrivalStatus' },
                ],
                list,
              )
            }
          >
            导出
          </Button>
        </Space>
      }
    >
      <ResponsiveTable
        rowKey="item_id"
        size="small"
        loading={loading}
        dataSource={list}
        scroll={{ x: 1400 }}
        pagination={{
          current: params.page,
          pageSize: params.pageSize,
          total,
          onChange: (page, pageSize) => patchParams({ page, pageSize }),
          showSizeChanger: true,
        }}
        columns={[
          { title: '订单编号', dataIndex: 'order_no', width: 150 },
          { title: '父订单号', dataIndex: 'parent_order_no', width: 140, render: (v) => v || '-' },
          {
            title: '采购内容',
            dataIndex: 'purchaseContent',
            width: 180,
            ellipsis: true,
            render: (v) => (
              <Tooltip title={v || '-'}>
                <span>{v || '-'}</span>
              </Tooltip>
            ),
          },
          { title: '供应商', dataIndex: 'supplier_name', width: 190, render: (v) => v || '待分配' },
          { title: '物料编码', dataIndex: 'material_code', width: 110 },
          { title: '物料名称', dataIndex: 'material_name', width: 160 },
          { title: '规格', dataIndex: 'spec', width: 130 },
          { title: '下单量', dataIndex: 'order_qty', width: 90, className: 'mono' },
          { title: '已入库', dataIndex: 'received_qty', width: 90, className: 'mono' },
          {
            title: '未入库',
            dataIndex: 'pendingQty',
            width: 90,
            className: 'mono',
            render: (v) => <span style={{ color: Number(v) > 0 ? '#cf1322' : undefined }}>{v}</span>,
          },
          { title: '单价', dataIndex: 'price', width: 90, render: (v) => <PriceText value={v} /> },
          { title: '下单日期', dataIndex: 'order_date', width: 110 },
          { title: '预计到货', dataIndex: 'expected_date', width: 110, render: (v) => v || '-' },
          {
            title: '到货状态',
            dataIndex: 'arrivalStatus',
            width: 100,
            render: (v) => (
              <Tag color={v === '已到齐' ? 'success' : v === '部分到货' ? 'warning' : 'default'}>{v}</Tag>
            ),
          },
        ]}
      />
    </Card>
  );
}
