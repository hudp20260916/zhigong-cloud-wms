import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Alert, Button, Card, DatePicker, Input, InputNumber, Modal, Popconfirm, Select, Space, Tooltip, message } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { productionApi } from '../../api';
import { useList } from '../../hooks/useList';
import {
  PermGate,
  StatusTag,
  ResponsiveTable,
  DockAction,
  CopyableCode,
  DetailTable,
  FilterBar,
} from '../../components';
import { useRowDetail } from '../../hooks/useRowDetail';
import { exportCsv, today } from '../../utils/exportCsv';
import { dayVal } from '../../utils/date';

interface ReturnRow {
  key: string;
  materialId: number;
  srcItemId: number;
  name: string;
  code: string;
  spec?: string;
  unit?: string;
  remainQty: number;
  qty: number;
}

/**
 * 生产退料。
 *
 * 业务场景：工单计划 100、按 100 领料，实际只产出 98 台就停工转产，
 * 剩余未使用的物料按「原领料单、原量」退回物料库存。
 *
 * 交互：选原领料单 → 系统带出该单可退明细（原路原量）→ 填本次退回的成品数量
 * （= 领料数量 - 实际投产数量），明细数量默认按比例带出，可逐条调整。
 */
export default function MaterialReturnPage() {
  const { list, total, loading, params, patchParams, reload } = useList<any>((p) =>
    productionApi.materialReturns(p),
  );
  const detail = useRowDetail((id: number) => productionApi.materialReturnDetail(id));

  // 可选的领料单（仅有效状态）
  const [issues, setIssues] = useState<any[]>([]);
  const [open, setOpen] = useState(false);
  const [issueId, setIssueId] = useState<number | undefined>();
  const [returnDate, setReturnDate] = useState(today());
  const [returnQty, setReturnQty] = useState<number>(0);
  const [maxReturnable, setMaxReturnable] = useState<number>(0);
  const [issueInfo, setIssueInfo] = useState<any>(null);
  const [rows, setRows] = useState<ReturnRow[]>([]);
  const [remark, setRemark] = useState('');
  const [saving, setSaving] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    productionApi
      .issues({ pageSize: 300 })
      .then((r) => setIssues(r.list.filter((i: any) => i.status === '有效')))
      .catch(() => undefined);
  }, []);

  // 从领料列表「去退料」跳转过来：自动带出该领料单
  useEffect(() => {
    const st: any = location.state;
    if (st?.issueId) {
      setOpen(true);
      void pickIssue(st.issueId);
      navigate('/production/returns', { replace: true, state: null });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.state]);

  function openCreate() {
    setIssueId(undefined);
    setReturnDate(today());
    setReturnQty(0);
    setMaxReturnable(0);
    setIssueInfo(null);
    setRows([]);
    setRemark('');
    setOpen(true);
  }

  /** 选择原领料单：带出可退明细（原路原量）与可退成品上限 */
  async function pickIssue(id: number) {
    setIssueId(id);
    try {
      const d = await productionApi.returnableOf(id);
      setIssueInfo(d.issue);
      setMaxReturnable(Number(d.maxReturnable ?? 0));
      setReturnQty(0);
      setRows(
        (d.items ?? []).map((it: any) => ({
          key: String(it.src_item_id),
          materialId: it.material_id,
          srcItemId: it.src_item_id,
          name: it.name,
          code: it.code,
          spec: it.spec,
          unit: it.unit,
          remainQty: Number(it.remainQty),
          qty: 0,
        })),
      );
      if (Number(d.maxReturnable ?? 0) <= 0) {
        message.warning('该领料单没有可退数量（已全部投产或已退完）');
      }
    } catch (e: any) {
      message.error(e.message);
    }
  }

  /** 按「退回成品数量」自动等比例带出各物料退料量（原量折算） */
  function applyReturnQty(qty: number) {
    setReturnQty(qty);
    if (!issueInfo || !(qty > 0)) {
      setRows((prev) => prev.map((r) => ({ ...r, qty: 0 })));
      return;
    }
    const produceQty = Number(issueInfo.produce_qty) || 0;
    if (produceQty <= 0) return;
    setRows((prev) =>
      prev.map((r) => {
        // 各物料按「本单领料总量 / 本单领料产量」的原单耗 × 退回数量
        const perUnit = Number(r.remainQty) > 0 ? Number(r.remainQty) / produceQty : 0;
        const v = Math.round(perUnit * qty * 10000) / 10000;
        return { ...r, qty: Math.min(v, r.remainQty) };
      }),
    );
  }

  async function submit() {
    if (!issueId) return message.warning('请选择原领料单');
    if (!(returnQty > 0)) return message.warning('请填写退回的成品数量');
    const lines = rows.filter((r) => r.qty > 0);
    if (lines.length === 0) return message.warning('请至少录入一条退料明细');
    setSaving(true);
    try {
      await productionApi.createMaterialReturn({
        issueId,
        returnDate,
        returnQty,
        remark,
        items: lines.map((r) => ({
          materialId: r.materialId,
          srcItemId: r.srcItemId,
          qty: r.qty,
        })),
      });
      message.success('退料成功，物料已按原路退回库存，工单已领产量同步核减');
      setOpen(false);
      reload();
    } catch (e: any) {
      message.error(e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card
      title="生产退料"
      extra={
        <Space>
          <Input.Search
            placeholder="退料单号 / 领料单号 / 工单号"
            allowClear
            style={{ width: 240 }}
            onSearch={(keyword) => patchParams({ keyword })}
          />
          <Button
            onClick={async () => {
              const res = await productionApi.materialReturns({ ...params, page: 1, pageSize: 50000 });
              exportCsv(`生产退料_${today()}`, [
                { title: '退料单号', key: 'return_no' },
                { title: '退料日期', key: 'return_date' },
                { title: '原领料单', key: 'issue_no' },
                { title: '工单编号', key: 'wo_no' },
                { title: '主产品', key: 'productName' },
                { title: '退回数量', key: 'return_qty' },
                { title: '退料内容', key: 'content' },
                { title: '操作人', key: 'operator_name' },
                { title: '状态', key: 'status' },
              ], res.list ?? []);
            }}
          >
            导出
          </Button>
          <PermGate permission="production.issue.create">
            <DockAction icon={<PlusOutlined />} onClick={openCreate}>新增退料</DockAction>
          </PermGate>
        </Space>
      }
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="生产退料用于「领了料但没投产」的部分：按原领料单原量退回物料库存，并同步核减工单已领产量，可入库上限随之收敛到实际投产数量"
      />

      <FilterBar onReset={() => patchParams({ keyword: '', dateFrom: '', dateTo: '', materialKeyword: '' })}>
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
        scroll={{ x: 1400 }}
        expandable={{
          expandedRowRender: (r) => (
            <DetailTable
              loading={detail.loading[r.id]}
              items={detail.cache[r.id]?.items ?? []}
              columns={[
                { title: '物料编码', dataIndex: 'code', width: 130 },
                { title: '物料名称', dataIndex: 'name', width: 180 },
                { title: '规格', dataIndex: 'spec', width: 150 },
                { title: '单位', dataIndex: 'unit', width: 70 },
                { title: '退料数量', dataIndex: 'qty', width: 100, className: 'mono' },
              ]}
            />
          ),
          onExpand: (expanded, r) => {
            if (expanded) void detail.load(r.id);
          },
        }}
        pagination={{
          current: params.page,
          pageSize: params.pageSize,
          total,
          onChange: (page, pageSize) => patchParams({ page, pageSize }),
          showSizeChanger: true,
        }}
        columns={[
          { title: '退料单号', dataIndex: 'return_no', width: 160, render: (v) => <CopyableCode value={v} /> },
          { title: '退料日期', dataIndex: 'return_date', width: 110 },
          { title: '原领料单', dataIndex: 'issue_no', width: 160, render: (v) => <CopyableCode value={v} /> },
          { title: '工单编号', dataIndex: 'wo_no', width: 160, render: (v) => <CopyableCode value={v} /> },
          { title: '主产品', dataIndex: 'productName', width: 160, ellipsis: true },
          {
            title: '退回数量',
            dataIndex: 'return_qty',
            width: 100,
            className: 'mono',
            render: (v) => <span style={{ color: '#1677ff' }}>{v}</span>,
          },
          { title: '退料内容', dataIndex: 'content', ellipsis: true },
          { title: '操作人', dataIndex: 'operator_name', width: 110 },
          { title: '状态', dataIndex: 'status', width: 90, render: (v) => <StatusTag status={v} /> },
          {
            title: '操作',
            width: 100,
            fixed: 'right',
            render: (_, r) =>
              r.canUndo ? (
                <Popconfirm
                  title="确认撤销该退料单？"
                  description="物料将按原量扣回，工单已领产量恢复"
                  onConfirm={async () => {
                    try {
                      await productionApi.undoMaterialReturn(r.id);
                      message.success('已撤销，物料已扣回');
                      reload();
                    } catch (e: any) {
                      message.error(e.message);
                    }
                  }}
                >
                  <Button type="link" size="small" danger>撤销</Button>
                </Popconfirm>
              ) : (
                '-'
              ),
          },
        ]}
      />

      <Modal
        open={open}
        title="新增生产退料"
        onCancel={() => setOpen(false)}
        onOk={submit}
        confirmLoading={saving}
        width={1020}
        destroyOnClose
      >
        <Space wrap style={{ marginBottom: 12 }}>
          <Select
            style={{ width: 400 }}
            placeholder="选择原领料单"
            showSearch
            optionFilterProp="label"
            value={issueId}
            onChange={pickIssue}
            options={issues.map((o) => ({
              value: o.id,
              label: `${o.issue_no} · ${o.productName ?? ''} · 领料 ${o.produce_qty} · 已入 ${o.received_qty ?? 0}`,
            }))}
          />
          <DatePicker value={dayVal(returnDate)} onChange={(d) => setReturnDate(d ? d.format('YYYY-MM-DD') : today())} />
        </Space>

        {issueInfo && (
          <Alert
            type={maxReturnable > 0 ? 'success' : 'warning'}
            showIcon
            style={{ marginBottom: 12 }}
            message={
              maxReturnable > 0
                ? `可退回成品数量上限 ${maxReturnable}（= 累计领料 - 已退 - 已入库）`
                : '该领料单没有可退数量'
            }
          />
        )}

        {issueId && (
          <Space wrap style={{ marginBottom: 12 }}>
            <span style={{ color: '#8c8c8c', fontSize: 12 }}>本次退回成品数量</span>
            <Tooltip title="= 领料数量 - 实际投产数量，例如领 100 台、实产 98 台，则退 2">
              <InputNumber
                min={0}
                max={maxReturnable}
                value={returnQty}
                onChange={(v) => applyReturnQty(Number(v ?? 0))}
                style={{ width: 140 }}
              />
            </Tooltip>
            <span style={{ color: '#8c8c8c', fontSize: 12 }}>
              填入后各物料按原单耗自动折算退料量，可逐条调整
            </span>
          </Space>
        )}

        <ResponsiveTable
          size="small"
          rowKey="key"
          dataSource={rows}
          pagination={false}
          scroll={{ y: 300 }}
          locale={{ emptyText: '请先选择原领料单' }}
          columns={[
            { title: '物料编码', dataIndex: 'code', width: 120 },
            { title: '物料名称', dataIndex: 'name', width: 170 },
            { title: '规格', dataIndex: 'spec', width: 130 },
            { title: '单位', dataIndex: 'unit', width: 70 },
            { title: '可退数量', dataIndex: 'remainQty', width: 100, className: 'mono' },
            {
              title: '退料数量',
              dataIndex: 'qty',
              width: 140,
              render: (v, r) => (
                <InputNumber
                  min={0}
                  max={r.remainQty}
                  value={v}
                  style={{ width: '100%' }}
                  onChange={(nv) =>
                    setRows((prev) => prev.map((x) => (x.key === r.key ? { ...x, qty: Number(nv ?? 0) } : x)))
                  }
                />
              ),
            },
          ]}
        />

        <Input.TextArea
          rows={2}
          style={{ marginTop: 12 }}
          placeholder="备注（如：转产其它产品，剩余物料退回仓库）"
          value={remark}
          onChange={(e) => setRemark(e.target.value)}
        />
        <div style={{ marginTop: 8, color: '#8c8c8c', fontSize: 12 }}>
          退料按原领料单、原物料、原量退回物料库存；退回后工单「已领产量」同步核减，入库上限随之变成实际投产数量。
        </div>
      </Modal>
    </Card>
  );
}
