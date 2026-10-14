import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Card, DatePicker, Input, InputNumber, Select, Space, message } from 'antd';
import { ExportOutlined, PlusOutlined, RollbackOutlined } from '@ant-design/icons';
import { archiveApi, saleApi } from '../../api';
import { useList } from '../../hooks/useList';
import {
  PermGate,
  PriceText,
  StatusTag,
  PrintButton,
  ResponsiveTable,
  DockAction,
  CopyableCode,
  DetailTable,
  FilterBar,
  SearchableSelect,
  Modal,
  TopActionBar,
  RowActionButton,
  RowActionGate,
  useRowSelect,
} from '../../components';
import { useRowDetail } from '../../hooks/useRowDetail';
import { exportCsv, today } from '../../utils/exportCsv';
import { dayVal } from '../../utils/date';

interface ItemRow {
  key: string;
  productId?: number;
  qty: number;
  price: number;
  stock?: number;
}

export default function SaleOrderPage() {
  const { list, total, loading, params, patchParams, reload } = useList<any>((p) => saleApi.orders(p));
  // 需求 12：点击行展开该销售单的成品明细
  const detail = useRowDetail((id: number) => saleApi.orderDetail(id));
  const navigate = useNavigate();
  const [products, setProducts] = useState<any[]>([]);
  const [customers, setCustomers] = useState<any[]>([]);
  const [open, setOpen] = useState(false);
  const [customerId, setCustomerId] = useState<number | undefined>();
  const [orderDate, setOrderDate] = useState(today());
  const [remark, setRemark] = useState('');
  const [items, setItems] = useState<ItemRow[]>([]);
  /** 顶部操作区：先选中一行，再点按钮（与生产工单页同一套交互） */
  const { selectedId, clearSelection, rowSelection, onRowClick } = useRowSelect();
  const selected = list.find((r) => r.id === selectedId) ?? null;

  useEffect(() => {
    archiveApi.productOptions().then(setProducts).catch(() => undefined);
    archiveApi
      .customers({ pageSize: 200 })
      .then((r) => setCustomers(r.list))
      .catch(() => undefined);
  }, []);

  async function submit() {
    const lines = items.filter((i) => i.productId && i.qty > 0);
    if (lines.length === 0) return message.warning('请至少录入一条销售明细');
    try {
      await saleApi.createOrder({
        customerId: customerId ?? null,
        orderDate,
        remark,
        items: lines.map((i) => ({ productId: i.productId, qty: i.qty, price: i.price })),
      });
      message.success('销售单已创建，状态为待出库');
      setOpen(false);
      reload();
    } catch (e: any) {
      message.error(e.message);
    }
  }

  return (
    <Card
      title="销售开单"
      extra={
        <Space>
          <Input.Search placeholder="单号 / 客户" allowClear style={{ width: 220 }} onSearch={(keyword) => patchParams({ keyword })} />
          <Button onClick={async () => {
            // 需求 12：导出跟随筛选结果
            const res = await saleApi.orders({ ...params, page: 1, pageSize: 50000 });
            exportCsv(`销售开单_${today()}`, [
              { title: '销售单号', key: 'order_no' },
              { title: '开单日期', key: 'order_date' },
              { title: '客户', key: 'customer_name' },
              { title: '金额', key: 'total_amount' },
              { title: '状态', key: 'status' },
            ], res.list ?? []);
          }}>导出</Button>
          <PermGate permission="sale.order.create">
            <DockAction icon={<PlusOutlined />} onClick={() => {
                setItems([]);
                setCustomerId(undefined);
                setOrderDate(today());
                setRemark('');
                setOpen(true);
              }}>新增销售单</DockAction>
          </PermGate>
        </Space>
      }
    >
      {/* 需求 12：单号（顶部搜索）+ 客户 + 产品名称筛选 */}
      <FilterBar
        onReset={() => patchParams({ keyword: '', customerId: '', productName: '' })}
        extra={
          /* 选中行操作组：先在列表中点行选中，再点这里执行。
             原按钮在每行末尾重复展示，几十条数据时很杂乱，故集中到顶部。
             可用动作由列表接口返回的 canDeliver / canReturn 决定（后端算好，含权限）。 */
          <TopActionBar>
            <RowActionGate selected={selected} tipName="销售订单">
              <PrintButton
                docType="sale_order"
                id={selected?.id ?? 0}
                type="default"
                className="btn-action"
              />
            </RowActionGate>
            <RowActionButton
              text="去出库"
              icon={<ExportOutlined />}
              selected={selected}
              tipName="销售订单"
              disabledReason={(r) => (r.canDeliver ? null : '该销售单当前不可出库')}
              onAction={(r) => navigate('/sale/deliveries', { state: { orderId: r.id } })}
            />
            <RowActionButton
              text="去退货"
              icon={<RollbackOutlined />}
              selected={selected}
              tipName="销售订单"
              disabledReason={(r) => (r.canReturn ? null : '该销售单当前不可退货')}
              onAction={(r) => navigate('/sale/returns', { state: { orderId: r.id } })}
            />
          </TopActionBar>
        }
      >
        <Select
          allowClear
          showSearch
          optionFilterProp="label"
          style={{ width: 200 }}
          placeholder="客户"
          value={params.customerId || undefined}
          onChange={(v) => patchParams({ customerId: v ?? '' })}
          options={customers.map((c) => ({ value: c.id, label: c.name }))}
        />
        <Input
          allowClear
          style={{ width: 200 }}
          placeholder="产品名称 / 编码包含"
          value={params.productName ?? ''}
          onChange={(e) => patchParams({ productName: e.target.value })}
        />
      </FilterBar>

      <ResponsiveTable
        rowKey="id"
        size="small"
        loading={loading}
        dataSource={list}
        rowSelection={rowSelection}
        onRowClick={onRowClick}
        selectedRowKeys={selectedId === null ? [] : [selectedId]}
        scroll={{ x: 1200 }}
        // 需求 12：点击行（客户所在行）展开销售明细
        expandable={{
          expandedRowRender: (r) => (
            <DetailTable
              loading={detail.loading[r.id]}
              items={detail.cache[r.id]?.items ?? []}
              columns={[
                { title: '产品编码', dataIndex: 'code', width: 130 },
                { title: '产品名称', dataIndex: 'name', width: 180 },
                { title: '规格', dataIndex: 'spec', width: 150 },
                { title: '单位', dataIndex: 'unit', width: 70 },
                { title: '数量', dataIndex: 'qty', width: 90, className: 'mono' },
                { title: '单价', dataIndex: 'price', width: 100, render: (v) => <PriceText value={v} /> },
                {
                  title: '金额',
                  width: 110,
                  className: 'mono',
                  render: (_v, it) => (
                    <PriceText value={Number(it.qty ?? 0) * Number(it.price ?? 0)} />
                  ),
                },
                { title: '当前库存', dataIndex: 'current_stock', width: 100, className: 'mono' },
                { title: '备注', dataIndex: 'remark' },
              ]}
            />
          ),
          onExpand: (expanded, r) => {
            if (expanded) void detail.load(r.id);
          },
        }}
        pagination={{ current: params.page, pageSize: params.pageSize, total, onChange: (page, pageSize) => patchParams({ page, pageSize }) }}
        columns={[
          { title: '销售单号', dataIndex: 'order_no', width: 160, render: (v) => <CopyableCode value={v} /> },
          { title: '开单日期', dataIndex: 'order_date', width: 110 },
          { title: '客户', dataIndex: 'customer_name', width: 220, render: (v) => v || '-' },
          { title: '数量合计', dataIndex: 'total_qty', width: 100, className: 'mono' },
          { title: '金额', dataIndex: 'total_amount', width: 120, render: (v) => <PriceText value={v} /> },
          { title: '状态', dataIndex: 'status', width: 100, render: (v) => <StatusTag status={v} /> },
          { title: '制单人', dataIndex: 'creator_name', width: 110 },
        ]}
      />

      <Modal open={open} title="新增销售单" onCancel={() => setOpen(false)} onOk={submit} width={900} destroyOnClose>
        <Space wrap style={{ marginBottom: 12 }}>
          <SearchableSelect style={{ width: 260 }} placeholder="客户" allowClear value={customerId} onChange={setCustomerId}
            options={customers.map((c) => ({ value: c.id, label: c.name }))} />
          <DatePicker value={dayVal(orderDate)} onChange={(d) => setOrderDate(d ? d.format('YYYY-MM-DD') : today())} />
          <Button
            size="small"
            onClick={() => setItems((prev) => [...prev, { key: `n-${Date.now()}`, qty: 1, price: 0 }])}
          >
            添加明细
          </Button>
        </Space>
        <ResponsiveTable
          size="small"
          rowKey="key"
          dataSource={items}
          pagination={false}
          scroll={{ y: 280 }}
          columns={[
            {
              title: '成品',
              dataIndex: 'productId',
              render: (v, r) => (
                <Select
                  style={{ width: '100%' }}
                  value={v}
                  showSearch
                  optionFilterProp="label"
                  options={products.map((p) => ({ value: p.id, label: `${p.code} ${p.name}` }))}
                  onChange={(nv) => {
                    const p = products.find((x) => x.id === nv);
                    setItems((prev) => prev.map((x) => (x.key === r.key ? { ...x, productId: nv, stock: p?.current_stock } : x)));
                  }}
                />
              ),
            },
            { title: '可用库存', dataIndex: 'stock', width: 100, className: 'mono', render: (v) => v ?? '-' },
            { title: '数量', dataIndex: 'qty', width: 120, render: (v, r) => (
              <InputNumber min={0} value={v} style={{ width: '100%' }} onChange={(nv) => setItems((prev) => prev.map((x) => (x.key === r.key ? { ...x, qty: Number(nv ?? 0) } : x)))} />
            ) },
            { title: '单价', dataIndex: 'price', width: 120, render: (v, r) => (
              <InputNumber min={0} step={0.01} value={v} style={{ width: '100%' }} onChange={(nv) => setItems((prev) => prev.map((x) => (x.key === r.key ? { ...x, price: Number(nv ?? 0) } : x)))} />
            ) },
            { title: '操作', width: 70, render: (_, r) => (
              <Button type="link" size="small" danger onClick={() => setItems((prev) => prev.filter((x) => x.key !== r.key))}>移除</Button>
            ) },
          ]}
        />
        <Input.TextArea rows={2} style={{ marginTop: 12 }} placeholder="备注" value={remark} onChange={(e) => setRemark(e.target.value)} />
        <div style={{ marginTop: 8, color: '#8c8c8c', fontSize: 12 }}>开单时会校验成品可用库存，库存不足将拒绝开单。</div>
      </Modal>
    </Card>
  );
}
