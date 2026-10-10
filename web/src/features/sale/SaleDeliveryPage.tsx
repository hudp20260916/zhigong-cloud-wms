import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Alert, Button, Card, DatePicker, Input, Modal, Popconfirm, Select, Space, Table, message } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { saleApi } from '../../api';
import { useList } from '../../hooks/useList';
import { PermGate, PriceText, StatusTag, PrintButton, ResponsiveTable, DockAction } from '../../components';
import { exportCsv, today } from '../../utils/exportCsv';
import { dayVal } from '../../utils/date';

export default function SaleDeliveryPage() {
  const { list, total, loading, params, patchParams, reload } = useList<any>((p) => saleApi.deliveries(p));
  const navigate = useNavigate();
  const location = useLocation();
  const [orders, setOrders] = useState<any[]>([]);
  const [open, setOpen] = useState(false);
  const [orderId, setOrderId] = useState<number | undefined>();
  const [deliveryDate, setDeliveryDate] = useState(today());
  const [remark, setRemark] = useState('');

  useEffect(() => {
    saleApi
      .orders({ pageSize: 200 })
      .then((r) => setOrders(r.list.filter((o: any) => o.status === '待出库')))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    const st: any = location.state;
    if (st?.orderId) {
      setOrderId(st.orderId);
      setOpen(true);
      navigate('/sale/deliveries', { replace: true, state: null });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.state]);

  async function submit() {
    if (!orderId) return message.warning('请选择销售开单');
    try {
      await saleApi.createDelivery({ orderId, deliveryDate, remark });
      message.success('出库单已生成，成品库存已扣减');
      setOpen(false);
      reload();
    } catch (e: any) {
      message.error(e.message);
    }
  }

  return (
    <Card
      title="销售出库"
      extra={
        <Space>
          <Input.Search placeholder="单号" allowClear style={{ width: 200 }} onSearch={(keyword) => patchParams({ keyword })} />
          <Button onClick={() => exportCsv(`销售出库_${today()}`, [
            { title: '出库单号', key: 'delivery_no' },
            { title: '出库日期', key: 'delivery_date' },
            { title: '关联销售单', key: 'order_no' },
            { title: '客户', key: 'customer_name' },
            { title: '金额', key: 'total_amount' },
            { title: '状态', key: 'status' },
          ], list)}>导出</Button>
          <PermGate permission="sale.delivery.create">
            <DockAction icon={<PlusOutlined />} onClick={() => { setOrderId(undefined); setDeliveryDate(today()); setRemark(''); setOpen(true); }}>一键出库</DockAction>
          </PermGate>
        </Space>
      }
    >
      <Alert type="info" showIcon style={{ marginBottom: 12 }} message="出库扣减成品库存并禁止负库存；撤销出库将回补库存并把销售单恢复为待出库" />
      <ResponsiveTable
        rowKey="id"
        size="small"
        loading={loading}
        dataSource={list}
        scroll={{ x: 1200 }}
        pagination={{ current: params.page, pageSize: params.pageSize, total, onChange: (page, pageSize) => patchParams({ page, pageSize }) }}
        columns={[
          { title: '出库单号', dataIndex: 'delivery_no', width: 160 },
          { title: '出库日期', dataIndex: 'delivery_date', width: 110 },
          { title: '关联销售单', dataIndex: 'order_no', width: 160 },
          { title: '客户', dataIndex: 'customer_name', width: 220, render: (v) => v || '-' },
          { title: '金额', dataIndex: 'total_amount', width: 120, render: (v) => <PriceText value={v} /> },
          { title: '操作人', dataIndex: 'operator_name', width: 110 },
          { title: '状态', dataIndex: 'status', width: 90, render: (v) => <StatusTag status={v} /> },
          {
            title: '操作',
            width: 160,
            render: (_, r) => (
              <Space size={0}>
                <PrintButton docType="sale_delivery" id={r.id} />
                {r.canUndo ? (
                  <Popconfirm title="确认撤销该出库单？" description="库存将回补" onConfirm={async () => {
                    try { await saleApi.undoDelivery(r.id); message.success('已撤销，库存已回补'); reload(); }
                    catch (e: any) { message.error(e.message); }
                  }}>
                    <Button type="link" size="small" danger>撤销</Button>
                  </Popconfirm>
                ) : '-'}
              </Space>
            ),
          },
        ]}
      />

      <Modal open={open} title="一键生成销售出库单" onCancel={() => setOpen(false)} onOk={submit} destroyOnClose>
        <Space direction="vertical" style={{ width: '100%' }} size={12}>
          <Select style={{ width: '100%' }} placeholder="选择待出库的销售单" value={orderId} onChange={setOrderId}
            options={orders.map((o) => ({ value: o.id, label: `${o.order_no} · ${o.customer_name ?? '无客户'} · ${o.total_amount}` }))} />
          <DatePicker style={{ width: '100%' }} value={dayVal(deliveryDate)} onChange={(d) => setDeliveryDate(d ? d.format('YYYY-MM-DD') : today())} />
          <Input.TextArea rows={2} placeholder="备注" value={remark} onChange={(e) => setRemark(e.target.value)} />
        </Space>
      </Modal>
    </Card>
  );
}
