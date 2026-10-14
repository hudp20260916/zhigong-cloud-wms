import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, Input, Space, Tabs, Tag } from 'antd';
import { EyeOutlined, ShoppingOutlined, ToolOutlined } from '@ant-design/icons';
import { inventoryApi } from '../../api';
import { useList } from '../../hooks/useList';
import {
  ResponsiveTable,
  PriceText,
  TopActionBar,
  RowActionButton,
  useRowSelect,
} from '../../components';
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
  /** 顶部操作区：先选中一行，再点按钮（与生产工单页同一套交互） */
  const { selectedId, clearSelection, rowSelection, onRowClick } = useRowSelect();
  const selected = list.find((r) => r.id === selectedId) ?? null;

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
          clearSelection(); // 换页签后行数据全变，选中态必须清掉
          patchParams({ page: 1 });
        }}
        items={[
          { key: 'product', label: '成品库存' },
          { key: 'material', label: '物料库存' },
        ]}
      />

      {/* 操作区：原按钮在每行末尾重复展示，统一集中到表格上方右侧（先选中一行再操作） */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
        <TopActionBar>
          <RowActionButton
            text="出入库详情"
            icon={<EyeOutlined />}
            selected={selected}
            tipName="库存记录"
            onAction={(row) => setDetail({ itemType: tab, itemId: row.id, itemName: row.name })}
          />
          {/* 去采购仅对低库存物料开放（原行内按钮也是这个口径） */}
          <RowActionButton
            text="去采购"
            icon={<ShoppingOutlined />}
            permission="purchase.order.create"
            selected={selected}
            tipName="库存记录"
            disabledReason={(row) => {
              if (tab !== 'material') return '请先切换到「物料库存」页签';
              return row.isLow ? null : '该物料库存正常，无需采购';
            }}
            onAction={(row) => goPurchase(row)}
          />
          {/* 去创建工单仅对低库存成品开放 */}
          <RowActionButton
            text="去创建工单"
            icon={<ToolOutlined />}
            permission="production.wo.create"
            selected={selected}
            tipName="库存记录"
            disabledReason={(row) => {
              if (tab !== 'product') return '请先切换到「成品库存」页签';
              return row.isLow ? null : '该成品库存正常，无需生产';
            }}
            onAction={(row) => goWorkOrder(row)}
          />
        </TopActionBar>
      </div>

      <ResponsiveTable
        rowKey="id"
        size="small"
        loading={loading}
        dataSource={list}
        columns={columns(tab) as any}
        rowSelection={rowSelection}
        onRowClick={onRowClick}
        selectedRowKeys={selectedId === null ? [] : [selectedId]}
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
