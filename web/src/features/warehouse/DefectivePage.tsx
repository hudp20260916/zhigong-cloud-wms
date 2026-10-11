import { useEffect, useRef, useState } from 'react';
import { Button, Card, DatePicker, Input, InputNumber, Modal, Popconfirm, Select, Space, Table, message } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { useLocation } from 'react-router-dom';
import { archiveApi, warehouseApi } from '../../api';
import { useList } from '../../hooks/useList';
import { PermGate, StatusTag, ResponsiveTable, DockAction, CopyableCode, FilterBar } from '../../components';
import { exportCsv, today } from '../../utils/exportCsv';
import { dayVal } from '../../utils/date';

interface ItemRow { key: string; materialId?: number; qty: number; reason: string; stock?: number }

const REASONS = ['来料不良', '制程损坏', '仓储破损', '过期失效', '其他'];

export default function DefectivePage() {
  const { list, total, loading, params, patchParams, reload } = useList<any>((p) => warehouseApi.defectives(p));
  const [materials, setMaterials] = useState<any[]>([]);
  const [open, setOpen] = useState(false);
  const [outDate, setOutDate] = useState(today());
  const [remark, setRemark] = useState('');
  const [items, setItems] = useState<ItemRow[]>([]);
  const location = useLocation();

  useEffect(() => {
    archiveApi.materialOptions().then(setMaterials).catch(() => undefined);
  }, []);

  // 需求 22：从库存预警看板「呆滞库存 → 不良品处理」跳过来时，自动带出该物料并打开新增弹窗
  const prefillHandled = useRef(false);
  useEffect(() => {
    const st: any = location.state;
    const mid = st?.prefill?.materialId;
    if (!mid || prefillHandled.current || materials.length === 0) return;
    prefillHandled.current = true;
    const m = materials.find((x) => x.id === mid);
    setItems([{ key: String(mid), materialId: mid, qty: 1, reason: '仓储破损', stock: m?.current_stock }]);
    setOutDate(today());
    setRemark('');
    setOpen(true);
  }, [location.state, materials]);

  async function submit() {
    const lines = items.filter((i) => i.materialId && i.qty > 0);
    if (lines.length === 0) return message.warning('请至少录入一条不良品明细');
    try {
      await warehouseApi.createDefective({ outDate, remark, items: lines });
      message.success('不良品出库单已生成，物料库存已扣减');
      setOpen(false);
      reload();
    } catch (e: any) { message.error(e.message); }
  }

  return (
    <Card
      title="不良品出库"
      extra={
        <Space>
          <Input.Search placeholder="出库单号" allowClear style={{ width: 190 }} onSearch={(keyword) => patchParams({ keyword })} />
          {/* 需求 26：导出跟随筛选结果 */}
          <Button onClick={async () => {
            const res = await warehouseApi.defectives({ ...params, page: 1, pageSize: 50000 });
            exportCsv(`不良品出库_${today()}`, [
              { title: '出库单号', key: 'out_no' },
              { title: '出库日期', key: 'out_date' },
              { title: '出库内容', key: 'content' },
              { title: '操作人', key: 'operator_name' },
              { title: '状态', key: 'status' },
            ], res.list ?? []);
          }}>导出</Button>
          <PermGate permission="warehouse.defective.create">
            <DockAction icon={<PlusOutlined />} onClick={() => { setItems([]); setOutDate(today()); setRemark(''); setOpen(true); }}>新增不良品出库</DockAction>
          </PermGate>
        </Space>
      }
    >
      {/* 需求 26：日期区间 + 物料名称/编码包含字筛选 */}
      <FilterBar onReset={() => patchParams({ materialKeyword: '', dateFrom: '', dateTo: '' })}>
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
        scroll={{ x: 1000 }}
        pagination={{ current: params.page, pageSize: params.pageSize, total, onChange: (page, pageSize) => patchParams({ page, pageSize }) }}
        columns={[
          { title: '出库单号', dataIndex: 'out_no', width: 160, render: (v) => <CopyableCode value={v} /> },
          { title: '出库日期', dataIndex: 'out_date', width: 110 },
          { title: '出库内容', dataIndex: 'content', ellipsis: true },
          { title: '操作人', dataIndex: 'operator_name', width: 110 },
          { title: '状态', dataIndex: 'status', width: 90, render: (v) => <StatusTag status={v} /> },
          { title: '操作', width: 90, render: (_, r) => r.canUndo ? (
            <Popconfirm title="确认撤销？" onConfirm={async () => {
              try { await warehouseApi.undoDefective(r.id); message.success('已撤销'); reload(); }
              catch (e: any) { message.error(e.message); }
            }}>
              <Button type="link" size="small" danger>撤销</Button>
            </Popconfirm>
          ) : '-' },
        ]}
      />

      <Modal open={open} title="新增不良品出库" onCancel={() => setOpen(false)} onOk={submit} width={860} destroyOnClose>
        <Space wrap style={{ marginBottom: 12 }}>
          <DatePicker value={dayVal(outDate)} onChange={(d) => setOutDate(d ? d.format('YYYY-MM-DD') : today())} />
          <Button size="small" onClick={() => setItems((prev) => [...prev, { key: `n-${Date.now()}`, qty: 1, reason: '' }])}>添加明细</Button>
        </Space>
        <ResponsiveTable size="small" rowKey="key" dataSource={items} pagination={false} scroll={{ y: 260 }} columns={[
          { title: '不良物料', dataIndex: 'materialId', render: (v, r) => (
            <Select style={{ width: '100%' }} value={v} showSearch optionFilterProp="label"
              options={materials.map((m) => ({ value: m.id, label: `${m.code} ${m.name}` }))}
              onChange={(nv) => { const m = materials.find((x) => x.id === nv); setItems((prev) => prev.map((x) => (x.key === r.key ? { ...x, materialId: nv, stock: m?.current_stock } : x))); }} />
          ) },
          { title: '可用库存', dataIndex: 'stock', width: 100, className: 'mono', render: (v) => v ?? '-' },
          { title: '数量', dataIndex: 'qty', width: 110, render: (v, r) => (
            <InputNumber min={0} value={v} style={{ width: '100%' }} onChange={(nv) => setItems((prev) => prev.map((x) => (x.key === r.key ? { ...x, qty: Number(nv ?? 0) } : x)))} />
          ) },
          { title: '原因', dataIndex: 'reason', width: 160, render: (v, r) => (
            <Select style={{ width: '100%' }} value={v || undefined} placeholder="选择原因"
              options={REASONS.map((x) => ({ value: x, label: x }))}
              onChange={(nv) => setItems((prev) => prev.map((x) => (x.key === r.key ? { ...x, reason: nv } : x)))} />
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
