import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Button, Card, DatePicker, Input, InputNumber, Modal, Popconfirm, Select, Space, Table, message } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
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
  FilterBar,
} from '../../components';
import { exportCsv, today } from '../../utils/exportCsv';
import { dayVal } from '../../utils/date';

interface ItemRow { key: string; productId?: number; qty: number; price: number }

export default function SaleReturnPage() {
  const { list, total, loading, params, patchParams, reload } = useList<any>((p) => saleApi.returns(p));
  const navigate = useNavigate();
  const location = useLocation();
  const [products, setProducts] = useState<any[]>([]);
  const [orders, setOrders] = useState<any[]>([]);
  const [open, setOpen] = useState(false);
  const [orderId, setOrderId] = useState<number | undefined>();
  const [returnDate, setReturnDate] = useState(today());
  const [remark, setRemark] = useState('');
  const [items, setItems] = useState<ItemRow[]>([]);
  const [customers, setCustomers] = useState<any[]>([]);

  useEffect(() => {
    archiveApi.productOptions().then(setProducts).catch(() => undefined);
    saleApi.orders({ pageSize: 200 }).then((r) => setOrders(r.list)).catch(() => undefined);
    archiveApi.customers({ pageSize: 200 }).then((r) => setCustomers(r.list ?? [])).catch(() => undefined);
  }, []);

  useEffect(() => {
    const st: any = location.state;
    if (st?.orderId) {
      setOrderId(st.orderId);
      saleApi.orderDetail(st.orderId).then((d) => {
        setItems(d.items.map((i: any, idx: number) => ({ key: `r-${idx}`, productId: i.product_id, qty: i.qty, price: i.price })));
        setOpen(true);
      }).catch((e: any) => message.error(e.message));
      navigate('/sale/returns', { replace: true, state: null });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.state]);

  async function submit() {
    const lines = items.filter((i) => i.productId && i.qty > 0);
    if (lines.length === 0) return message.warning('请至少录入一条退货明细');
    try {
      await saleApi.createReturn({ orderId: orderId ?? null, returnDate, remark, items: lines });
      message.success('退货单已生成，成品库存已增加');
      setOpen(false);
      reload();
    } catch (e: any) { message.error(e.message); }
  }

  return (
    <Card
      title="销售退货"
      extra={
        <Space>
          <Input.Search
            placeholder="退货单号 / 销售单号 / 客户"
            allowClear
            style={{ width: 240 }}
            onSearch={(keyword) => patchParams({ keyword })}
          />
          <Button onClick={async () => {
            // 需求 15：导出跟随筛选结果
            const res = await saleApi.returns({ ...params, page: 1, pageSize: 50000 });
            exportCsv(`销售退货_${today()}`, [
              { title: '退货单号', key: 'return_no' },
              { title: '退货日期', key: 'return_date' },
              { title: '关联销售单', key: 'order_no' },
              { title: '客户', key: 'customer_name' },
              { title: '金额', key: 'total_amount' },
              { title: '状态', key: 'status' },
            ], res.list ?? []);
          }}>导出</Button>
          <PermGate permission="sale.return.create">
            <DockAction icon={<PlusOutlined />} onClick={() => { setItems([]); setOrderId(undefined); setReturnDate(today()); setRemark(''); setOpen(true); }}>新增退货</DockAction>
          </PermGate>
        </Space>
      }
    >
      {/* 需求 15：单号（顶部搜索）+ 日期区间 + 客户 + 产品名称筛选 */}
      <FilterBar
        onReset={() =>
          patchParams({ keyword: '', customerId: '', productName: '', dateFrom: '', dateTo: '' })
        }
      >
        <DatePicker
          style={{ width: 140 }}
          placeholder="开始日期"
          value={dayVal(params.dateFrom)}
          onChange={(d) => patchParams({ dateFrom: d ? d.format('YYYY-MM-DD') : '' })}
        />
        <DatePicker
          style={{ width: 140 }}
          placeholder="结束日期"
          value={dayVal(params.dateTo)}
          onChange={(d) => patchParams({ dateTo: d ? d.format('YYYY-MM-DD') : '' })}
        />
        <Select
          allowClear
          showSearch
          optionFilterProp="label"
          style={{ width: 180 }}
          placeholder="客户"
          value={params.customerId || undefined}
          onChange={(v) => patchParams({ customerId: v ?? '' })}
          options={customers.map((c) => ({ value: c.id, label: c.name }))}
        />
        <Input
          allowClear
          style={{ width: 190 }}
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
        scroll={{ x: 1100 }}
        pagination={{ current: params.page, pageSize: params.pageSize, total, onChange: (page, pageSize) => patchParams({ page, pageSize }) }}
        columns={[
          { title: '退货单号', dataIndex: 'return_no', width: 160, render: (v) => <CopyableCode value={v} /> },
          { title: '退货日期', dataIndex: 'return_date', width: 110 },
          { title: '关联销售单', dataIndex: 'order_no', width: 160, render: (v) => <CopyableCode value={v} /> },
          { title: '客户', dataIndex: 'customer_name', width: 220, render: (v) => v || '-' },
          { title: '金额', dataIndex: 'total_amount', width: 120, render: (v) => <PriceText value={v} /> },
          { title: '操作人', dataIndex: 'operator_name', width: 110 },
          { title: '状态', dataIndex: 'status', width: 90, render: (v) => <StatusTag status={v} /> },
          { title: '操作', width: 160, render: (_, r) => (
            <Space size={0}>
              <PrintButton docType="sale_return" id={r.id} />
              {r.canUndo ? (
                <Popconfirm title="确认撤销该退货单？" onConfirm={async () => {
                  try { await saleApi.undoReturn(r.id); message.success('已撤销'); reload(); }
                  catch (e: any) { message.error(e.message); }
                }}>
                  <Button type="link" size="small" danger>撤销</Button>
                </Popconfirm>
              ) : '-'}
            </Space>
          ) },
        ]}
      />

      <Modal open={open} title="新增销售退货" onCancel={() => setOpen(false)} onOk={submit} width={860} destroyOnClose>
        <Space wrap style={{ marginBottom: 12 }}>
          <Select style={{ width: 300 }} placeholder="关联销售开单（可选）" allowClear value={orderId}
            onChange={(v) => { setOrderId(v); if (v) saleApi.orderDetail(v).then((d) => setItems(d.items.map((i: any, idx: number) => ({ key: `r-${idx}`, productId: i.product_id, qty: i.qty, price: i.price })))); }}
            options={orders.map((o) => ({ value: o.id, label: `${o.order_no} · ${o.customer_name ?? '无客户'}` }))} />
          <DatePicker value={dayVal(returnDate)} onChange={(d) => setReturnDate(d ? d.format('YYYY-MM-DD') : today())} />
          <Button size="small" onClick={() => setItems((prev) => [...prev, { key: `n-${Date.now()}`, qty: 1, price: 0 }])}>添加明细</Button>
        </Space>
        <ResponsiveTable size="small" rowKey="key" dataSource={items} pagination={false} scroll={{ y: 260 }} columns={[
          { title: '成品', dataIndex: 'productId', render: (v, r) => (
            <Select style={{ width: '100%' }} value={v} showSearch optionFilterProp="label"
              options={products.map((p) => ({ value: p.id, label: `${p.code} ${p.name}` }))}
              onChange={(nv) => setItems((prev) => prev.map((x) => (x.key === r.key ? { ...x, productId: nv } : x)))} />
          ) },
          { title: '数量', dataIndex: 'qty', width: 130, render: (v, r) => (
            <InputNumber min={0} value={v} style={{ width: '100%' }} onChange={(nv) => setItems((prev) => prev.map((x) => (x.key === r.key ? { ...x, qty: Number(nv ?? 0) } : x)))} />
          ) },
          { title: '单价', dataIndex: 'price', width: 130, render: (v, r) => (
            <InputNumber min={0} step={0.01} value={v} style={{ width: '100%' }} onChange={(nv) => setItems((prev) => prev.map((x) => (x.key === r.key ? { ...x, price: Number(nv ?? 0) } : x)))} />
          ) },
          { title: '操作', width: 70, render: (_, r) => (
            <Button type="link" size="small" danger onClick={() => setItems((prev) => prev.filter((x) => x.key !== r.key))}>移除</Button>
          ) },
        ]} />
        <Input.TextArea rows={2} style={{ marginTop: 12 }} placeholder="备注" value={remark} onChange={(e) => setRemark(e.target.value)} />
      </Modal>
    </Card>
  );
}
