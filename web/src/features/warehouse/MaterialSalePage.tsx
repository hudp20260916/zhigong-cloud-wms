import { useEffect, useState } from 'react';
import { Button, Card, DatePicker, Input, InputNumber, Modal, Popconfirm, Select, Space, Table, message } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { archiveApi, warehouseApi } from '../../api';
import { useList } from '../../hooks/useList';
import { PermGate, PriceText, StatusTag, ResponsiveTable, DockAction, CopyableCode } from '../../components';
import { exportCsv, today } from '../../utils/exportCsv';
import { dayVal } from '../../utils/date';

interface ItemRow { key: string; materialId?: number; qty: number; price: number; stock?: number }

export default function MaterialSalePage() {
  const { list, total, loading, params, patchParams, reload } = useList<any>((p) => warehouseApi.materialSales(p));
  const [materials, setMaterials] = useState<any[]>([]);
  const [customers, setCustomers] = useState<any[]>([]);
  const [open, setOpen] = useState(false);
  const [customerId, setCustomerId] = useState<number | undefined>();
  const [saleDate, setSaleDate] = useState(today());
  const [remark, setRemark] = useState('');
  const [items, setItems] = useState<ItemRow[]>([]);

  useEffect(() => {
    archiveApi.materialOptions().then(setMaterials).catch(() => undefined);
    archiveApi.customers({ pageSize: 200 }).then((r) => setCustomers(r.list)).catch(() => undefined);
  }, []);

  async function submit() {
    const lines = items.filter((i) => i.materialId && i.qty > 0);
    if (lines.length === 0) return message.warning('请至少录入一条明细');
    try {
      await warehouseApi.createMaterialSale({
        customerId: customerId ?? null, saleDate, remark,
        items: lines.map((i) => ({ materialId: i.materialId, qty: i.qty, price: i.price })),
      });
      message.success('物料销售单已生成，物料库存已扣减');
      setOpen(false);
      reload();
    } catch (e: any) { message.error(e.message); }
  }

  return (
    <Card
      title="物料销售"
      extra={
        <Space>
          <Button onClick={() => exportCsv(`物料销售_${today()}`, [
            { title: '销售单号', key: 'sale_no' },
            { title: '销售日期', key: 'sale_date' },
            { title: '销售内容', key: 'content' },
            { title: '金额', key: 'total_amount' },
            { title: '操作人', key: 'operator_name' },
            { title: '状态', key: 'status' },
          ], list)}>导出</Button>
          <PermGate permission="warehouse.materialSale.create">
            <DockAction icon={<PlusOutlined />} onClick={() => { setItems([]); setCustomerId(undefined); setSaleDate(today()); setRemark(''); setOpen(true); }}>新增物料销售</DockAction>
          </PermGate>
        </Space>
      }
    >
      <ResponsiveTable
        rowKey="id"
        size="small"
        loading={loading}
        dataSource={list}
        scroll={{ x: 1100 }}
        pagination={{ current: params.page, pageSize: params.pageSize, total, onChange: (page, pageSize) => patchParams({ page, pageSize }) }}
        columns={[
          { title: '销售单号', dataIndex: 'sale_no', width: 160, render: (v) => <CopyableCode value={v} /> },
          { title: '销售日期', dataIndex: 'sale_date', width: 110 },
          { title: '销售内容', dataIndex: 'content', ellipsis: true },
          { title: '金额', dataIndex: 'total_amount', width: 120, render: (v) => <PriceText value={v} /> },
          { title: '操作人', dataIndex: 'operator_name', width: 110 },
          { title: '状态', dataIndex: 'status', width: 90, render: (v) => <StatusTag status={v} /> },
          { title: '操作', width: 90, render: (_, r) => r.canUndo ? (
            <Popconfirm title="确认撤销？" onConfirm={async () => {
              try { await warehouseApi.undoMaterialSale(r.id); message.success('已撤销'); reload(); }
              catch (e: any) { message.error(e.message); }
            }}>
              <Button type="link" size="small" danger>撤销</Button>
            </Popconfirm>
          ) : '-' },
        ]}
      />

      <Modal open={open} title="新增物料销售" onCancel={() => setOpen(false)} onOk={submit} width={860} destroyOnClose>
        <Space wrap style={{ marginBottom: 12 }}>
          <Select style={{ width: 260 }} placeholder="客户（可选）" allowClear value={customerId} onChange={setCustomerId}
            options={customers.map((c) => ({ value: c.id, label: c.name }))} />
          <DatePicker value={dayVal(saleDate)} onChange={(d) => setSaleDate(d ? d.format('YYYY-MM-DD') : today())} />
          <Button size="small" onClick={() => setItems((prev) => [...prev, { key: `n-${Date.now()}`, qty: 1, price: 0 }])}>添加明细</Button>
        </Space>
        <ResponsiveTable size="small" rowKey="key" dataSource={items} pagination={false} scroll={{ y: 260 }} columns={[
          { title: '物料', dataIndex: 'materialId', render: (v, r) => (
            <Select style={{ width: '100%' }} value={v} showSearch optionFilterProp="label"
              options={materials.map((m) => ({ value: m.id, label: `${m.code} ${m.name}` }))}
              onChange={(nv) => { const m = materials.find((x) => x.id === nv); setItems((prev) => prev.map((x) => (x.key === r.key ? { ...x, materialId: nv, stock: m?.current_stock } : x))); }} />
          ) },
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
        ]} />
        <Input.TextArea rows={2} style={{ marginTop: 12 }} placeholder="备注" value={remark} onChange={(e) => setRemark(e.target.value)} />
      </Modal>
    </Card>
  );
}
