import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  Alert,
  Button,
  Card,
  DatePicker,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tooltip,
  message,
} from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { productionApi } from '../../api';
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
} from '../../components';
import { useRowDetail } from '../../hooks/useRowDetail';
import { exportCsv, today } from '../../utils/exportCsv';
import { dayVal } from '../../utils/date';

export default function IssuePage() {
  const { list, total, loading, params, patchParams, reload } = useList<any>((p) =>
    productionApi.issues(p),
  );
  // 需求 10：点击行展开领料明细
  const detail = useRowDetail((id: number) => productionApi.issueDetail(id));
  const navigate = useNavigate();
  const location = useLocation();
  const [options, setOptions] = useState<any[]>([]);
  const [open, setOpen] = useState(false);
  const [woId, setWoId] = useState<number | undefined>();
  const [produceQty, setProduceQty] = useState(50);
  const [issueDate, setIssueDate] = useState(today());
  const [remark, setRemark] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    productionApi
      .workOrderOptions()
      .then(setOptions)
      .catch(() => undefined);
  }, []);

  // 从工单列表「去领料」跳转
  useEffect(() => {
    const st: any = location.state;
    if (st?.workOrderId) {
      setWoId(st.workOrderId);
      setOpen(true);
      navigate('/production/issues', { replace: true, state: null });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.state]);

  async function submit() {
    if (!woId) {
      message.warning('请选择生产工单');
      return;
    }
    setSaving(true);
    try {
      await productionApi.createIssue({ woId, issueDate, produceQty, remark });
      message.success('领料成功，已按 BOM 展开并穿透虚拟件扣减实阶物料');
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
      title="生产领料"
      extra={
        <Space>
          <Input.Search
            placeholder="领料单号 / 主产品 / 工单号"
            allowClear
            style={{ width: 240 }}
            onSearch={(keyword) => patchParams({ keyword })}
          />
          <Button
            onClick={async () => {
              // 需求 10：导出跟随筛选结果
              const res = await productionApi.issues({ ...params, page: 1, pageSize: 50000 });
              exportCsv(`生产领料_${today()}`, [
                { title: '领料单号', key: 'issue_no' },
                { title: '领料日期', key: 'issue_date' },
                { title: '主产品名称', key: 'productName' },
                { title: '工单编号', key: 'wo_no' },
                { title: '生产数量', key: 'produce_qty' },
                { title: '可入库余量', key: 'remainQty' },
                { title: '操作人', key: 'operator_name' },
                { title: '状态', key: 'status' },
              ], res.list ?? []);
            }}
          >
            导出
          </Button>
          <PermGate permission="production.issue.create">
            <DockAction icon={<PlusOutlined />} onClick={() => {
                setWoId(undefined);
                setProduceQty(50);
                setIssueDate(today());
                setRemark('');
                setOpen(true);
              }}>新增领料</DockAction>
          </PermGate>
        </Space>
      }
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="领料必须关联生产工单，明细按 BOM 自动生成并穿透虚拟件；「去入库」仅在可入库余量大于 0 时出现"
      />

      {/* 需求 10：筛选结果优化 —— 日期区间 + 物料包含字 */}
      <FilterBar
        onReset={() => patchParams({ keyword: '', dateFrom: '', dateTo: '', materialKeyword: '' })}
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
        scroll={{ x: 1400 }}
        // 需求 10：点击行展开领料明细
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
                { title: '领料数量', dataIndex: 'qty', width: 100, className: 'mono' },
                { title: '库存', dataIndex: 'stock', width: 90, className: 'mono' },
                { title: '备注', dataIndex: 'remark' },
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
          { title: '领料单号', dataIndex: 'issue_no', width: 150, render: (v) => <CopyableCode value={v} /> },
          { title: '领料日期', dataIndex: 'issue_date', width: 110 },
          {
            // 需求 3.5.2：领料列表新增「主产品名称」列，过长悬浮查看，导出同步
            title: '主产品名称',
            dataIndex: 'productName',
            width: 200,
            ellipsis: true,
            render: (v) => (
              <Tooltip title={v || '未关联主产品'}>
                <span>{v || '未关联主产品'}</span>
              </Tooltip>
            ),
          },
          { title: '工单编号', dataIndex: 'wo_no', width: 150, render: (v) => <CopyableCode value={v} /> },
          { title: '工单计划产量', dataIndex: 'plan_qty', width: 110, className: 'mono' },
          { title: '生产数量', dataIndex: 'produce_qty', width: 100, className: 'mono' },
          {
            title: '可入库余量',
            dataIndex: 'remainQty',
            width: 110,
            className: 'mono',
            render: (v) => <span style={{ color: Number(v) <= 0 ? '#8c8c8c' : '#3B6D11' }}>{v}</span>,
          },
          { title: '操作人', dataIndex: 'operator_name', width: 110 },
          { title: '状态', dataIndex: 'status', width: 90, render: (v) => <StatusTag status={v} /> },
          {
            title: '操作',
            width: 180,
            fixed: 'right',
            render: (_, r) => (
              <Space size={0}>
                <PrintButton docType="material_issue" id={r.id} />
                {r.canReceive && (
                  <Tooltip title="入库类型锁定「生产入库（已领料）」，数量自动锁定且只读">
                    <Button
                      type="link"
                      size="small"
                      onClick={() => navigate('/production/receipts', { state: { issueId: r.id } })}
                    >
                      去入库
                    </Button>
                  </Tooltip>
                )}
                {!r.canReceive && r.status === '有效' && (
                  <Tooltip title="可入库余量为 0，请先继续领料">
                    <span style={{ color: '#8c8c8c', fontSize: 12 }}>余量不足</span>
                  </Tooltip>
                )}
                {r.status === '有效' && (
                  <Tooltip title="领了料但未投产的部分，按原单原量退回物料库存">
                    <Button
                      type="link"
                      size="small"
                      onClick={() => navigate('/production/returns', { state: { issueId: r.id } })}
                    >
                      去退料
                    </Button>
                  </Tooltip>
                )}
                {r.canUndo && (
                  <Popconfirm
                    title="确认撤销该领料单？"
                    description="已依据本单入库的成品需先撤销入库单"
                    onConfirm={async () => {
                      try {
                        await productionApi.undoIssue(r.id);
                        message.success('已撤销，物料库存已回滚');
                        reload();
                      } catch (e: any) {
                        message.error(e.message);
                      }
                    }}
                  >
                    <Button type="link" size="small" danger>
                      撤销
                    </Button>
                  </Popconfirm>
                )}
              </Space>
            ),
          },
        ]}
      />

      <Modal open={open} title="新增生产领料" onCancel={() => setOpen(false)} onOk={submit} confirmLoading={saving} destroyOnClose>
        <Form layout="vertical">
          <Form.Item label="生产工单" required>
            <Select
              showSearch
              placeholder="选择生产工单"
              value={woId}
              onChange={setWoId}
              optionFilterProp="label"
              options={options.map((o) => ({
                value: o.id,
                label: `${o.wo_no} · ${o.product_name} · 计划 ${o.plan_qty}`,
              }))}
            />
          </Form.Item>
          <Form.Item label="生产数量（本单可生产成品数）">
            <InputNumber min={1} value={produceQty} onChange={(v) => setProduceQty(Number(v ?? 0))} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item label="领料日期">
            <DatePicker
              value={dayVal(issueDate)}
              onChange={(d) => setIssueDate(d ? d.format('YYYY-MM-DD') : today())}
              style={{ width: '100%' }}
            />
          </Form.Item>
          <Form.Item label="备注">
            <Input.TextArea rows={2} value={remark} onChange={(e) => setRemark(e.target.value)} />
          </Form.Item>
        </Form>
        <div style={{ color: '#8c8c8c', fontSize: 12 }}>
          明细按所选工单的 BOM 自动生成：虚拟件会穿透为实阶物料，外箱按成品装箱规格向上取整扣除。
        </div>
      </Modal>
    </Card>
  );
}
