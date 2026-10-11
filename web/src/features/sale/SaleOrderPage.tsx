import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Card, DatePicker, Input, InputNumber, Modal, Select, Space, Table, message } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { archiveApi, saleApi } from '../../api';
import { useList } from '../../hooks/useList';
import { PermGate, PriceText, StatusTag, PrintButton, ResponsiveTable, DockAction, CopyableCode } from '../../components';
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
  const navigate = useNavigate();
  const [products, setProducts] = useState<any[]>([]);
  const [customers, setCustomers] = useState<any[]>([]);
  const [open, setOpen] = useState(false);
  const [customerId, setCustomerId] = useState<number | undefined>();
  const [orderDate, setOrderDate] = useState(today());
  const [remark, setRemark] = useState('');
  const [items, setItems] = useState<ItemRow[]>([]);

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
          <Button onClick={() => exportCsv(`销售开单_${today()}`, [
            { title: '销售单号', key: 'order_no' },
            { title: '开单日期', key: 'order_date' },
            { title: '客户', key: 'customer_name' },
            { title: '金额', key: 'total_amount' },
            { title: '状态', key: 'status' },
          ], list)}>导出</Button>
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
      <ResponsiveTable
        rowKey="id"
        size="small"
        loading={loading}
        dataSource={list}
        scroll={{ x: 1200 }}
        pagination={{ current: params.page, pageSize: params.pageSize, total, onChange: (page, pageSize) => patchParams({ page, pageSize }) }}
        columns={[
          { title: '销售单号', dataIndex: 'order_no', width: 160, render: (v) => <CopyableCode value={v} /> },
          { title: '开单日期', dataIndex: 'order_date', width: 110 },
          { title: '客户', dataIndex: 'customer_name', width: 220, render: (v) => v || '-' },
          { title: '数量合计', dataIndex: 'total_qty', width: 100, className: 'mono' },
          { title: '金额', dataIndex: 'total_amount', width: 120, render: (v) => <PriceText value={v} /> },
          { title: '状态', dataIndex: 'status', width: 100, render: (v) => <StatusTag status={v} /> },
          { title: '制单人', dataIndex: 'creator_name', width: 110 },
          {
            title: '操作',
            width: 220,
            render: (_, r) => (
              <Space size={0}>
                <PrintButton docType="sale_order" id={r.id} />
                {r.canDeliver && (
                  <Button type="link" size="small" onClick={() => navigate('/sale/deliveries', { state: { orderId: r.id } })}>
                    去出库
                  </Button>
                )}
                {r.canReturn && (
                  <Button type="link" size="small" onClick={() => navigate('/sale/returns', { state: { orderId: r.id } })}>
                    去退货
                  </Button>
                )}
              </Space>
            ),
          },
        ]}
      />

      <Modal open={open} title="新增销售单" onCancel={() => setOpen(false)} onOk={submit} width={900} destroyOnClose>
        <Space wrap style={{ marginBottom: 12 }}>
          <Select style={{ width: 260 }} placeholder="客户" allowClear value={customerId} onChange={setCustomerId}
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
