import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Card, DatePicker, Input, InputNumber, Radio, Select, Space, Table, Tag, message } from 'antd';
import { PlusOutlined, RollbackOutlined } from '@ant-design/icons';
import { useLocation } from 'react-router-dom';
import { archiveApi, productionApi, warehouseApi } from '../../api';
import { useList } from '../../hooks/useList';
import {
  PermGate,
  StatusTag,
  ResponsiveTable,
  DockAction,
  CopyableCode,
  FilterBar,
  Modal,
  TopActionBar,
  RowActionButton,
  useRowSelect,
  WarehouseSelect,
} from '../../components';
import { exportCsv, today } from '../../utils/exportCsv';
import { dayVal } from '../../utils/date';

interface ItemRow { key: string; materialId?: number; qty: number; reason: string; stock?: number }

const REASONS = ['来料不良', '制程损坏', '仓储破损', '过期失效', '其他'];

export default function DefectivePage() {
  const { list, total, loading, params, patchParams, reload } = useList<any>((p) => warehouseApi.defectives(p));
  const [materials, setMaterials] = useState<any[]>([]);
  const [issues, setIssues] = useState<any[]>([]);
  const [open, setOpen] = useState(false);
  const [outDate, setOutDate] = useState(today());
  const [remark, setRemark] = useState('');
  const [items, setItems] = useState<ItemRow[]>([]);
  const [sourceType, setSourceType] = useState<'manual' | 'issue'>('manual');
  const [issueId, setIssueId] = useState<number | undefined>();
  const [issueInfo, setIssueInfo] = useState<any>(null);
  const [produceQty, setProduceQty] = useState<number>(0);
  /** 多仓库：从哪个仓出不良品；不传时服务端按来源领料单原仓 → 物料默认仓兜底 */
  const [warehouseId, setWarehouseId] = useState<number | null>(null);
  const location = useLocation();
  /** 顶部操作区：先选中一行，再点按钮（与生产工单页同一套交互） */
  const { selectedId, clearSelection, rowSelection, onRowClick } = useRowSelect();
  const selected = list.find((r) => r.id === selectedId) ?? null;

  useEffect(() => {
    archiveApi.materialOptions().then(setMaterials).catch(() => undefined);
    productionApi.issues({ pageSize: 300 }).then((r) => setIssues(r.list.filter((i: any) => i.status === '有效'))).catch(() => undefined);
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

  /** 切到「生产领料」来源：带出该领料单可退明细（原路原量），填入不良品明细 */
  async function pickIssue(id: number | undefined) {
    setIssueId(id);
    setIssueInfo(null);
    setProduceQty(0);
    if (!id) {
      setItems([]);
      return;
    }
    try {
      const d = await productionApi.returnableOf(id);
      setIssueInfo(d.issue);
      setItems(
        (d.items ?? []).map((it: any) => ({
          key: String(it.src_item_id ?? it.material_id),
          materialId: it.material_id,
          qty: 0,
          reason: '制程损坏',
          stock: it.remainQty,
        })),
      );
    } catch (e: any) {
      message.error(e.message);
    }
  }

  async function submit() {
    const lines = items.filter((i) => i.materialId && i.qty > 0);
    if (lines.length === 0) return message.warning('请至少录入一条不良品明细');
    if (sourceType === 'issue' && !issueId) return message.warning('请选择来源领料单');
    if (sourceType === 'issue' && !(produceQty >= 0)) return message.warning('请填写对应成品数量（可为 0）');
    try {
      await warehouseApi.createDefective({
        outDate,
        remark,
        sourceType,
        issueId: sourceType === 'issue' ? issueId : undefined,
        produceQty: sourceType === 'issue' ? produceQty : 0,
        warehouseId: warehouseId ?? undefined,
        items: lines,
      });
      message.success(sourceType === 'issue' ? '不良品出库单已生成（领料来源），物料库存已扣减，工单可入库余量已联动' : '不良品出库单已生成，物料库存已扣减');
      setOpen(false);
      reload();
    } catch (e: any) { message.error(e.message); }
  }

  function openCreate() {
    setItems([]);
    setOutDate(today());
    setRemark('');
    setSourceType('manual');
    setIssueId(undefined);
    setIssueInfo(null);
    setProduceQty(0);
    setWarehouseId(null);
    setOpen(true);
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
            <DockAction icon={<PlusOutlined />} onClick={openCreate}>新增不良品出库</DockAction>
          </PermGate>
        </Space>
      }
    >
      {/* 需求 26：日期区间 + 物料名称/编码包含字筛选 */}
      <FilterBar
        onReset={() => patchParams({ materialKeyword: '', dateFrom: '', dateTo: '' })}
        extra={
          /* 选中行操作组：先在列表中点行选中，再点这里执行。
             原「撤销」在每行末尾重复展示，几十条数据时很杂乱，故集中到顶部。
             是否可撤销由列表接口返回的 canUndo 决定（后端算好，含权限）。 */
          <TopActionBar>
            <RowActionButton
              text="撤销"
              icon={<RollbackOutlined />}
              danger
              selected={selected}
              tipName="不良品出库单"
              disabledReason={(r) => (r.canUndo ? null : '该出库单当前不可撤销')}
              confirm={(r) => ({
                title: '确认撤销该不良品出库单？',
                content:
                  r.source_type === 'issue'
                    ? '撤销后物料库存回补，工单可入库余量随之恢复，且不可恢复。'
                    : `出库单「${r.out_no}」撤销后物料库存回补，且不可恢复。`,
              })}
              onAction={async (r) => {
                try {
                  await warehouseApi.undoDefective(r.id);
                  message.success('已撤销');
                  clearSelection();
                  reload();
                } catch (e: any) {
                  message.error(e.message);
                }
              }}
            />
          </TopActionBar>
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
        rowSelection={rowSelection}
        onRowClick={onRowClick}
        selectedRowKeys={selectedId === null ? [] : [selectedId]}
        scroll={{ x: 1100 }}
        pagination={{ current: params.page, pageSize: params.pageSize, total, onChange: (page, pageSize) => patchParams({ page, pageSize }) }}
        columns={[
          { title: '出库单号', dataIndex: 'out_no', width: 160, render: (v) => <CopyableCode value={v} /> },
          { title: '出库日期', dataIndex: 'out_date', width: 110 },
          { title: '来源', dataIndex: 'sourceLabel', width: 200, ellipsis: true, render: (v, r) => r.source_type === 'issue' ? <Tag color="orange">领料来源 {r.source_issue_no ?? ''}</Tag> : <Tag>手工拣选</Tag> },
          { title: '对应成品量', dataIndex: 'produce_qty', width: 110, className: 'mono', render: (v, r) => r.source_type === 'issue' ? <span style={{ color: '#fa8c16' }}>{v}</span> : '-' },
          { title: '出库内容', dataIndex: 'content', ellipsis: true },
          { title: '操作人', dataIndex: 'operator_name', width: 110 },
          { title: '状态', dataIndex: 'status', width: 90, render: (v) => <StatusTag status={v} /> },
        ]}
      />

      <Modal open={open} title="新增不良品出库" onCancel={() => setOpen(false)} onOk={submit} width={880} destroyOnClose>
        <Space wrap style={{ marginBottom: 12 }}>
          <Radio.Group value={sourceType} onChange={(e) => {
            const v = e.target.value;
            setSourceType(v);
            setIssueId(undefined);
            setIssueInfo(null);
            setItems([]);
          }}>
            <Radio.Button value="manual">手工拣选</Radio.Button>
            <Radio.Button value="issue">生产领料来源</Radio.Button>
          </Radio.Group>
          <DatePicker value={dayVal(outDate)} onChange={(d) => setOutDate(d ? d.format('YYYY-MM-DD') : today())} />
          <div>
            <div style={{ marginBottom: 4, fontSize: 12, color: '#595959' }}>出库仓库</div>
            <WarehouseSelect
              itemType="material"
              value={warehouseId}
              onChange={setWarehouseId}
              style={{ width: 200 }}
              showHint={sourceType === 'manual'}
            />
            {sourceType === 'issue' && !warehouseId && (
              <div style={{ marginTop: 4, fontSize: 12, color: '#8c8c8c' }}>未选择时归入该领料单原仓</div>
            )}
          </div>
        </Space>

        {sourceType === 'issue' && (
          <Space wrap style={{ marginBottom: 12 }}>
            <Select
              style={{ width: 420 }}
              placeholder="选择来源生产领料单"
              showSearch
              optionFilterProp="label"
              value={issueId}
              onChange={pickIssue}
              options={issues.map((o) => ({
                value: o.id,
                label: `${o.issue_no} · ${o.productName ?? ''} · 领料 ${o.produce_qty} · 已入 ${o.received_qty ?? 0}`,
              }))}
            />
            {issueInfo && (
              <Alert
                type="success"
                showIcon
                message={`来源领料单 ${issueInfo.issue_no}（工单 ${issueInfo.wo_no}），已带出该单可退物料明细，数量默认 0，请按需填写`}
              />
            )}
          </Space>
        )}

        {sourceType === 'issue' && issueInfo && (
          <Space wrap style={{ marginBottom: 12 }}>
            <span style={{ color: '#8c8c8c', fontSize: 12 }}>对应成品数量（台/件，从工单可入库余量中核减）</span>
            <InputNumber
              min={0}
              max={Number(issueInfo.produce_qty) || undefined}
              value={produceQty}
              onChange={(v) => setProduceQty(Number(v ?? 0))}
              style={{ width: 140 }}
            />
            <span style={{ color: '#8c8c8c', fontSize: 12 }}>
              填写后该工单「可入库余量」自动收敛，实际合格产能随之减少
            </span>
          </Space>
        )}

        {sourceType === 'manual' && (
          <Button size="small" onClick={() => setItems((prev) => [...prev, { key: `n-${Date.now()}`, qty: 1, reason: '' }])}>添加明细</Button>
        )}

        <ResponsiveTable size="small" rowKey="key" dataSource={items} pagination={false} scroll={{ y: 260 }} locale={{ emptyText: sourceType === 'issue' ? '请先选择来源领料单' : '请点击「添加明细」' }} columns={[
          { title: '不良物料', dataIndex: 'materialId', render: (v, r) => (
            <Select style={{ width: '100%' }} value={v} showSearch optionFilterProp="label" disabled={sourceType === 'issue'}
              options={materials.map((m) => ({ value: m.id, label: `${m.code} ${m.name}` }))}
              onChange={(nv) => { const m = materials.find((x) => x.id === nv); setItems((prev) => prev.map((x) => (x.key === r.key ? { ...x, materialId: nv, stock: m?.current_stock } : x))); }} />
          ) },
          { title: '可退/可用', dataIndex: 'stock', width: 100, className: 'mono', render: (v) => v ?? '-' },
          { title: '数量', dataIndex: 'qty', width: 110, render: (v, r) => (
            <InputNumber min={0} max={r.stock ? Number(r.stock) : undefined} value={v} style={{ width: '100%' }} onChange={(nv) => setItems((prev) => prev.map((x) => (x.key === r.key ? { ...x, qty: Number(nv ?? 0) } : x)))} />
          ) },
          { title: '原因', dataIndex: 'reason', width: 160, render: (v, r) => (
            <Select style={{ width: '100%' }} value={v || undefined} placeholder="选择原因"
              options={REASONS.map((x) => ({ value: x, label: x }))}
              onChange={(nv) => setItems((prev) => prev.map((x) => (x.key === r.key ? { ...x, reason: nv } : x)))} />
          ) },
          { title: '操作', width: 70, render: (_, r) => sourceType === 'manual' ? (
            <Button type="link" size="small" danger onClick={() => setItems((prev) => prev.filter((x) => x.key !== r.key))}>移除</Button>
          ) : null },
        ]} />
        <Input.TextArea rows={2} style={{ marginTop: 12 }} placeholder="备注" value={remark} onChange={(e) => setRemark(e.target.value)} />
      </Modal>
    </Card>
  );
}
