import { useEffect, useRef, useState } from 'react';
import { Button, Card, DatePicker, Input, InputNumber, Modal, Popconfirm, Select, Space, Table, message } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { useLocation } from 'react-router-dom';
import { archiveApi, warehouseApi } from '../../api';
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
  SearchableSelect,
} from '../../components';
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
  const location = useLocation();

  useEffect(() => {
    archiveApi.materialOptions().then(setMaterials).catch(() => undefined);
    archiveApi.customers({ pageSize: 200 }).then((r) => setCustomers(r.list)).catch(() => undefined);
  }, []);

  // 需求 22：从库存预警看板「呆滞库存 → 销售处理」跳过来时，自动带出该物料并直接打开新增弹窗。
  // 要等 materialOptions 加载完才能取到库存与成本，所以用 ref 保证只认领一次。
  const prefillHandled = useRef(false);
  useEffect(() => {
    const st: any = location.state;
    const mid = st?.prefill?.materialId;
    if (!mid || prefillHandled.current || materials.length === 0) return;
    prefillHandled.current = true;
    const m = materials.find((x) => x.id === mid);
    setItems([
      { key: String(mid), materialId: mid, qty: 1, price: Number(m?.avg_cost ?? 0), stock: m?.current_stock },
    ]);
    setCustomerId(undefined);
    setSaleDate(today());
    setRemark('');
    setOpen(true);
  }, [location.state, materials]);

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
          <Input.Search placeholder="销售单号" allowClear style={{ width: 190 }} onSearch={(keyword) => patchParams({ keyword })} />
          {/* 需求 25：导出跟随筛选结果 */}
          <Button onClick={async () => {
            const res = await warehouseApi.materialSales({ ...params, page: 1, pageSize: 50000 });
            exportCsv(`物料销售_${today()}`, [
              { title: '销售单号', key: 'sale_no' },
              { title: '销售日期', key: 'sale_date' },
              { title: '客户', key: 'customer_name' },
              { title: '销售内容', key: 'content' },
              { title: '金额', key: 'total_amount' },
              { title: '操作人', key: 'operator_name' },
              { title: '状态', key: 'status' },
            ], res.list ?? []);
          }}>导出</Button>
          <PermGate permission="warehouse.materialSale.create">
            <DockAction icon={<PlusOutlined />} onClick={() => { setItems([]); setCustomerId(undefined); setSaleDate(today()); setRemark(''); setOpen(true); }}>新增物料销售</DockAction>
          </PermGate>
        </Space>
      }
    >
      {/* 需求 25：日期区间 + 客户 + 物料名称/编码包含字筛选 */}
      <FilterBar onReset={() => patchParams({ customerId: '', materialKeyword: '', dateFrom: '', dateTo: '' })}>
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
          placeholder="物料名称 / 编码包含"
          value={params.materialKeyword ?? ''}
          onChange={(e) => patchParams({ materialKeyword: e.target.value })}
        />
      </FilterBar>

      <ResponsiveTable
        rowKey="id"
        size="small"
        loading={loading}
        dataSource={list}
        scroll={{ x: 1200 }}
        pagination={{ current: params.page, pageSize: params.pageSize, total, onChange: (page, pageSize) => patchParams({ page, pageSize }) }}
        columns={[
          { title: '销售单号', dataIndex: 'sale_no', width: 160, render: (v) => <CopyableCode value={v} /> },
          { title: '销售日期', dataIndex: 'sale_date', width: 110 },
          { title: '客户', dataIndex: 'customer_name', width: 180, render: (v) => v || '-' },
          { title: '销售内容', dataIndex: 'content', ellipsis: true },
          { title: '金额', dataIndex: 'total_amount', width: 120, render: (v) => <PriceText value={v} /> },
          { title: '操作人', dataIndex: 'operator_name', width: 110 },
          { title: '状态', dataIndex: 'status', width: 90, render: (v) => <StatusTag status={v} /> },
          { title: '操作', width: 160, render: (_, r) => (
            <Space size={0}>
              {/* 需求 25：物料销售打印模板 */}
              <PrintButton docType="material_sale" id={r.id} />
              {r.canUndo ? (
                <Popconfirm title="确认撤销？" onConfirm={async () => {
                  try { await warehouseApi.undoMaterialSale(r.id); message.success('已撤销'); reload(); }
                  catch (e: any) { message.error(e.message); }
                }}>
                  <Button type="link" size="small" danger>撤销</Button>
                </Popconfirm>
              ) : null}
            </Space>
          ) },
        ]}
      />

      <Modal open={open} title="新增物料销售" onCancel={() => setOpen(false)} onOk={submit} width={860} destroyOnClose>
        <Space wrap style={{ marginBottom: 12 }}>
          <SearchableSelect style={{ width: 260 }} placeholder="客户（可选）" allowClear value={customerId} onChange={setCustomerId}
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
