import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Card, Input, Space, Table, Tabs, Tag, Tooltip, message } from 'antd';
import { ShoppingOutlined } from '@ant-design/icons';
import { inventoryApi } from '../../api';
import { useList } from '../../hooks/useList';
import { PermGate, PriceText, ResponsiveTable } from '../../components';
import { useAuthStore } from '../../stores/auth';
import StockDetailModal from './StockDetailModal';
import type { ItemType } from '@shared/enums';

interface StockRow {
  id: number;
  code: string;
  name: string;
  spec?: string;
  unit: string;
  current_stock: number;
  safety_stock: number;
  avg_cost?: number;
  default_supplier_name?: string;
  isLow?: boolean;
}

export default function StockPage() {
  const [tab, setTab] = useState<ItemType>('product');
  const [sortDir, setSortDir] = useState<'ASC' | 'DESC'>('ASC');
  const [detail, setDetail] = useState<{ itemType: ItemType; itemId: number; itemName: string } | null>(null);
  const navigate = useNavigate();
  const has = useAuthStore((s) => s.has);

  const { list, total, loading, params, patchParams } = useList<StockRow>(
    (p) => (tab === 'product' ? inventoryApi.products(p) : inventoryApi.materials(p)),
    { sortDir: 'ASC' },
  );

  function onTableChange(_p: any, _f: any, sorter: any) {
    const dir = sorter?.order === 'descend' ? 'DESC' : 'ASC';
    setSortDir(dir);
    patchParams({ sortDir: dir });
  }

  function goPurchase(row: StockRow) {
    // 带出物料名称、编码、规格、单位与默认供应商，不带采购数量（需求 3.7.1）
    navigate('/purchase/orders', {
      state: { prefill: { materialIds: [row.id], openCreate: true } },
    });
  }

  function goWorkOrder(row: StockRow) {
    // 仅带出成品，不带建议生产数量（需求 3.7.1）
    navigate('/production/work-orders', { state: { prefill: { productId: row.id } } });
  }

  const columns = (itemType: ItemType) => [
    { title: '编码', dataIndex: 'code', width: 120 },
    {
      title: itemType === 'product' ? '成品名称' : '物料名称',
      dataIndex: 'name',
      width: 200,
      // 表头点击全局排序，多页生效，空值排末尾（需求 4.8）
      sorter: true,
      sortOrder: (sortDir === 'DESC' ? 'descend' : 'ascend') as any,
    },
    { title: '规格', dataIndex: 'spec', width: 160 },
    { title: '单位', dataIndex: 'unit', width: 70 },
    {
      title: '可用库存',
      dataIndex: 'current_stock',
      width: 110,
      className: 'mono',
      render: (v: number, r: StockRow) => (
        <span style={{ color: r.isLow ? '#cf1322' : undefined, fontWeight: r.isLow ? 500 : 400 }}>{v}</span>
      ),
    },
    { title: '安全库存', dataIndex: 'safety_stock', width: 100, className: 'mono' },
    ...(itemType === 'material'
      ? [
          {
            title: '加权成本',
            dataIndex: 'avg_cost',
            width: 100,
            render: (v: any) => <PriceText value={v} />,
          },
          { title: '默认供应商', dataIndex: 'default_supplier_name', width: 200 },
        ]
      : []),
    {
      title: '状态',
      width: 100,
      render: (_: any, r: StockRow) =>
        r.isLow ? <Tag color="red">低库存</Tag> : <Tag color="green">正常</Tag>,
    },
    {
      title: '操作',
      width: 210,
      fixed: 'right' as const,
      render: (_: any, r: StockRow) => (
        <Space size={0}>
          <Button
            type="link"
            size="small"
            onClick={() => setDetail({ itemType, itemId: r.id, itemName: r.name })}
          >
            {itemType === 'product' ? '成品' : '物料'}出入库详情
          </Button>
          {r.isLow &&
            (itemType === 'material' ? (
              <PermGate permission="purchase.order.create">
                <Tooltip title="跳转采购订单，带出该物料信息">
                  <Button type="link" size="small" icon={<ShoppingOutlined />} onClick={() => goPurchase(r)}>
                    去采购
                  </Button>
                </Tooltip>
              </PermGate>
            ) : (
              <PermGate permission="production.wo.create">
                <Button type="link" size="small" onClick={() => goWorkOrder(r)}>
                  去创建工单
                </Button>
              </PermGate>
            ))}
        </Space>
      ),
    },
  ];

  return (
    <Card
      title="库存查询"
      extra={
        <Space>
          <Input.Search
            placeholder="编码 / 名称 / 拼音 / 规格"
            allowClear
            style={{ width: 240 }}
            onSearch={(keyword) => patchParams({ keyword })}
          />
        </Space>
      }
    >
      <Tabs
        activeKey={tab}
        onChange={(k) => {
          setTab(k as ItemType);
          patchParams({ page: 1 });
        }}
        items={[
          { key: 'product', label: '成品库存' },
          { key: 'material', label: '物料库存' },
        ]}
      />
      <ResponsiveTable
        rowKey="id"
        size="small"
        loading={loading}
        dataSource={list}
        columns={columns(tab) as any}
        scroll={{ x: 1400 }}
        onChange={onTableChange}
        rowClassName={(r) => (r.isLow ? 'low-stock-row' : '')}
        pagination={{
          current: params.page,
          pageSize: params.pageSize,
          total,
          onChange: (page, pageSize) => patchParams({ page, pageSize }),
          showSizeChanger: true,
        }}
      />

      {detail && (
        <StockDetailModal
          open={!!detail}
          onClose={() => setDetail(null)}
          itemType={detail.itemType}
          itemId={detail.itemId}
          itemName={detail.itemName}
        />
      )}
    </Card>
  );
}
