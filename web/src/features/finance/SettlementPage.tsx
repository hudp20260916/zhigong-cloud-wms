import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Col,
  DatePicker,
  Descriptions,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Radio,
  Row,
  Select,
  Space,
  Statistic,
  Table,
  Tag,
  message,
} from 'antd';
import { DollarOutlined, PlusOutlined } from '@ant-design/icons';
import { financeApi } from '../../api';
import { useList } from '../../hooks/useList';
import { PermGate, PermPage, PriceText, ResponsiveTable, DockAction } from '../../components';
import { exportCsv, today } from '../../utils/exportCsv';
import { dayVal } from '../../utils/date';

interface Doc {
  docType: 'receipt' | 'return';
  docId: number;
  returnNo: string | null;
  docDate: string;
  docAmount: number;
  unsettledAmount: number;
  itemSummary: string;
}

export default function SettlementPage() {
  return (
    <PermPage permission="finance.settle.view">
      <SettlementInner />
    </PermPage>
  );
}

function SettlementInner() {
  const { list, total, loading, params, patchParams, reload } = useList<any>((p) =>
    financeApi.settlements(p),
  );
  const [payables, setPayables] = useState<any[]>([]);
  const [open, setOpen] = useState(false);

  // 新建付款单的表单状态
  const [supplierId, setSupplierId] = useState<number | undefined>();
  const [docs, setDocs] = useState<Doc[]>([]);
  const [settleDate, setSettleDate] = useState(today());
  const [method, setMethod] = useState('转账');
  const [amount, setAmount] = useState<number>(0);
  const [mode, setMode] = useState<'auto' | 'manual'>('auto');
  const [manual, setManual] = useState<Record<string, number>>({});
  const [preview, setPreview] = useState<any>(null);
  const [remark, setRemark] = useState('');
  const [detail, setDetail] = useState<any>(null);

  const loadPayables = () =>
    financeApi
      .payables()
      .then(setPayables)
      .catch(() => setPayables([]));

  useEffect(() => {
    loadPayables();
  }, []);

  const totalPayable = useMemo(
    () => payables.reduce((s, p) => s + Number(p.payableAmount ?? 0), 0),
    [payables],
  );

  const selected = useMemo(
    () => payables.find((p) => p.supplierId === supplierId),
    [payables, supplierId],
  );

  // 自动核销试算：金额或供应商变化时即时刷新（防抖 300ms）
  useEffect(() => {
    if (mode !== 'auto' || !supplierId || !(amount > 0)) {
      setPreview(null);
      return;
    }
    const t = setTimeout(() => {
      financeApi
        .previewSettle({ supplierId, amount })
        .then(setPreview)
        .catch(() => setPreview(null));
    }, 300);
    return () => clearTimeout(t);
  }, [mode, supplierId, amount]);

  async function openCreate() {
    setSupplierId(undefined);
    setDocs([]);
    setAmount(0);
    setMode('auto');
    setManual({});
    setPreview(null);
    setRemark('');
    setSettleDate(today());
    setMethod('转账');
    setOpen(true);
  }

  async function pickSupplier(id: number) {
    setSupplierId(id);
    setManual({});
    try {
      const r = await financeApi.payableDocs(id);
      setDocs(r.docs ?? []);
    } catch (e: any) {
      message.error(e.message);
      setDocs([]);
    }
  }

  const manualTotal = useMemo(
    () => Object.values(manual).reduce((s, v) => s + Math.abs(Number(v ?? 0)), 0),
    [manual],
  );

  async function submit() {
    if (!supplierId) return message.warning('请选择供应商');
    if (!(amount > 0)) return message.warning('请输入付款金额');
    if (mode === 'manual' && manualTotal <= 0) return message.warning('请至少勾选一张单据并填写核销金额');

    try {
      await financeApi.createSettlement({
        supplierId,
        settleDate,
        method,
        amount,
        mode,
        allocations: Object.entries(manual)
          .filter(([, v]) => Number(v) !== 0)
          .map(([k, v]) => {
            const [docType, docId] = k.split('-');
            return { docType, docId: Number(docId), applyAmount: Number(v) };
          }),
        remark,
      });
      message.success('付款单已登记，应付余额已更新');
      setOpen(false);
      reload();
      loadPayables();
    } catch (e: any) {
      message.error(e.message);
    }
  }

  return (
    <>
      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col xs={24} sm={8}>
          <Card>
            <Statistic
              title="应付余额合计"
              value={totalPayable}
              precision={2}
              prefix={<DollarOutlined />}
              valueStyle={{ color: totalPayable > 0 ? '#cf1322' : undefined }}
            />
          </Card>
        </Col>
        <Col xs={24} sm={8}>
          <Card>
            <Statistic title="待结算供应商" value={payables.filter((p) => Number(p.payableAmount) > 0).length} suffix={`/ ${payables.length}`} />
          </Card>
        </Col>
        <Col xs={24} sm={8}>
          <Card>
            <Statistic title="已登记付款单" value={total} />
          </Card>
        </Col>
      </Row>

      <Card
        title="供应商应付汇总"
        extra={
          <Space>
            <Button
              onClick={() =>
                exportCsv(`应付汇总_${today()}`, [
                  { title: '供应商编码', key: 'supplierCode' },
                  { title: '供应商名称', key: 'supplierName' },
                  { title: '入库金额', key: 'receiptAmount' },
                  { title: '退货金额', key: 'returnAmount' },
                  { title: '已结算', key: 'settledAmount' },
                  { title: '应付余额', key: 'payableAmount' },
                  { title: '待结算单据数', key: 'pendingCount' },
                ], payables)
              }
            >
              导出
            </Button>
            <PermGate permission="finance.settle.audit">
              <DockAction icon={<PlusOutlined />} onClick={openCreate}>登记付款</DockAction>
            </PermGate>
          </Space>
        }
      >
        <ResponsiveTable
          rowKey="supplierId"
          size="small"
          dataSource={payables}
          pagination={false}
          scroll={{ x: 900 }}
          columns={[
            { title: '供应商编码', dataIndex: 'supplierCode', width: 120 },
            { title: '供应商名称', dataIndex: 'supplierName' },
            { title: '入库金额', dataIndex: 'receiptAmount', width: 120, align: 'right', render: (v) => <PriceText value={v} /> },
            { title: '退货冲减', dataIndex: 'returnAmount', width: 120, align: 'right', render: (v) => <PriceText value={v} /> },
            { title: '已结算', dataIndex: 'settledAmount', width: 120, align: 'right', render: (v) => <PriceText value={v} /> },
            {
              title: '应付余额',
              dataIndex: 'payableAmount',
              width: 130,
              align: 'right',
              render: (v) => <strong style={{ color: Number(v) > 0 ? '#cf1322' : undefined }}><PriceText value={v} /></strong>,
            },
            { title: '待结算单据', dataIndex: 'pendingCount', width: 100, align: 'right' },
          ]}
        />
      </Card>

      <Card title="付款单记录" style={{ marginTop: 16 }}>
        <ResponsiveTable
          rowKey="id"
          size="small"
          loading={loading}
          dataSource={list}
          scroll={{ x: 1100 }}
          pagination={{
            current: params.page,
            pageSize: params.pageSize,
            total,
            onChange: (page, pageSize) => patchParams({ page, pageSize }),
          }}
          columns={[
            { title: '付款单号', dataIndex: 'settle_no', width: 170 },
            { title: '付款日期', dataIndex: 'settle_date', width: 110 },
            { title: '供应商', dataIndex: 'supplier_name', width: 200 },
            { title: '方式', dataIndex: 'method', width: 80 },
            { title: '付款金额', dataIndex: 'amount', width: 120, align: 'right', render: (v) => <PriceText value={v} /> },
            { title: '已核销', dataIndex: 'applied_amount', width: 120, align: 'right', render: (v) => <PriceText value={v} /> },
            { title: '经办人', dataIndex: 'operator_name', width: 110 },
            {
              title: '状态',
              dataIndex: 'status',
              width: 90,
              render: (v) => <Tag color={v === '有效' ? 'green' : 'default'}>{v}</Tag>,
            },
            {
              title: '操作',
              width: 170,
              render: (_, r) => (
                <Space size={0}>
                  <Button
                    type="link"
                    size="small"
                    onClick={async () => {
                      try {
                        setDetail(await financeApi.settlementDetail(r.id));
                      } catch (e: any) {
                        message.error(e.message);
                      }
                    }}
                  >
                    核销明细
                  </Button>
                  {r.canUndo && (
                    <Popconfirm
                      title="确认撤销该付款单？"
                      description="撤销后将恢复各单据的未结算金额"
                      onConfirm={async () => {
                        try {
                          await financeApi.undoSettlement(r.id);
                          message.success('已撤销');
                          reload();
                          loadPayables();
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
      </Card>

      <Modal
        open={open}
        title="登记付款"
        onCancel={() => setOpen(false)}
        onOk={submit}
        width={960}
        okText="确认付款"
        destroyOnClose
      >
        <Descriptions size="small" column={{ xs: 1, sm: 2, md: 3 }} style={{ marginBottom: 12 }}>
          <Descriptions.Item label="付款日期">
            <DatePicker
              size="small"
              value={dayVal(settleDate)}
              onChange={(d) => setSettleDate(d ? d.format('YYYY-MM-DD') : today())}
            />
          </Descriptions.Item>
          <Descriptions.Item label="付款方式">
            <Select
              size="small"
              style={{ width: 110 }}
              value={method}
              onChange={setMethod}
              options={['现金', '转账', '承兑', '其他'].map((v) => ({ value: v, label: v }))}
            />
          </Descriptions.Item>
          <Descriptions.Item label="供应商">
            <Select
              size="small"
              showSearch
              style={{ width: 260 }}
              placeholder="选择供应商"
              value={supplierId}
              onChange={pickSupplier}
              optionFilterProp="label"
              options={payables.map((p) => ({
                value: p.supplierId,
                label: `${p.supplierName}（应付 ${Number(p.payableAmount ?? 0).toFixed(2)}）`,
              }))}
            />
          </Descriptions.Item>
        </Descriptions>

        {selected && (
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 12 }}
            message={`该供应商应付余额 ${Number(selected.payableAmount).toFixed(2)}，待结算单据 ${docs.length} 张`}
          />
        )}

        <Space wrap style={{ marginBottom: 12 }}>
          <InputNumber
            addonBefore="付款金额"
            min={0}
            precision={2}
            style={{ width: 220 }}
            value={amount}
            onChange={(v) => setAmount(Number(v ?? 0))}
          />
          <Radio.Group value={mode} onChange={(e) => setMode(e.target.value)}>
            <Radio.Button value="auto">自动核销（按日期先后）</Radio.Button>
            <Radio.Button value="manual">手动指定</Radio.Button>
          </Radio.Group>
          {selected && (
            <Button
              size="small"
              onClick={() => setAmount(Number(selected.payableAmount))}
            >
              按应付余额填充
            </Button>
          )}
        </Space>

        {mode === 'auto' && preview && (
          <Alert
            type={preview.remain > 0.005 ? 'warning' : 'success'}
            showIcon
            style={{ marginBottom: 12 }}
            message={
              preview.remain > 0.005
                ? `本次付款可核销 ${preview.allocations.length} 张单据，剩余 ${Number(preview.remain).toFixed(2)} 将作为预付款留待下次核销`
                : `本次付款将核销 ${preview.allocations.length} 张单据，无剩余`
            }
          />
        )}

        <ResponsiveTable
          size="small"
          rowKey={(r) => `${r.docType}-${r.docId}`}
          dataSource={docs}
          pagination={false}
          scroll={{ y: 260 }}
          rowSelection={
            mode === 'manual'
              ? {
                  selectedRowKeys: Object.keys(manual),
                  onChange: (keys) => {
                    const next: Record<string, number> = {};
                    for (const k of keys as string[]) {
                      const d = docs.find((x) => `${x.docType}-${x.docId}` === k);
                      next[k] = manual[k] ?? Math.abs(Number(d?.unsettledAmount ?? 0));
                    }
                    setManual(next);
                  },
                }
              : undefined
          }
          columns={[
            {
              title: '单据',
              dataIndex: 'itemSummary',
              render: (v, r) => (
                <span>
                  {v}
                  {r.docType === 'return' && <Tag color="orange" style={{ marginLeft: 6 }}>退货冲减</Tag>}
                </span>
              ),
            },
            { title: '日期', dataIndex: 'docDate', width: 110 },
            {
              title: '单据金额',
              dataIndex: 'docAmount',
              width: 110,
              align: 'right',
              render: (v) => <PriceText value={v} />,
            },
            {
              title: '未结算',
              dataIndex: 'unsettledAmount',
              width: 110,
              align: 'right',
              render: (v) => <PriceText value={v} />,
            },
            ...(mode === 'manual'
              ? [
                  {
                    title: '本次核销',
                    width: 140,
                    render: (_v: any, r: Doc) => {
                      const key = `${r.docType}-${r.docId}`;
                      return (
                        <InputNumber
                          size="small"
                          min={0}
                          precision={2}
                          style={{ width: '100%' }}
                          value={manual[key] ?? 0}
                          onChange={(v) =>
                            setManual((prev) => ({ ...prev, [key]: Number(v ?? 0) }))
                          }
                        />
                      );
                    },
                  },
                ]
              : [
                  {
                    title: '本次核销',
                    width: 120,
                    align: 'right' as const,
                    render: (_v: any, r: Doc) => {
                      const hit = preview?.allocations?.find(
                        (a: any) => a.docType === r.docType && a.docId === r.docId,
                      );
                      return hit ? <PriceText value={hit.applyAmount} /> : <span>-</span>;
                    },
                  },
                ]),
          ]}
        />

        {mode === 'manual' && (
          <div style={{ marginTop: 8, textAlign: 'right' }}>
            核销合计：<strong>{manualTotal.toFixed(2)}</strong> / 付款金额 {Number(amount).toFixed(2)}
          </div>
        )}

        <Input.TextArea
          rows={2}
          style={{ marginTop: 12 }}
          placeholder="备注"
          value={remark}
          onChange={(e) => setRemark(e.target.value)}
        />
      </Modal>

      <Modal
        open={!!detail}
        title="付款单核销明细"
        onCancel={() => setDetail(null)}
        footer={null}
        width={800}
        destroyOnClose
      >
        {detail && (
          <>
            <Descriptions size="small" column={{ xs: 1, sm: 2, md: 3 }} style={{ marginBottom: 12 }}>
              <Descriptions.Item label="付款单号">{detail.settlement.settle_no}</Descriptions.Item>
              <Descriptions.Item label="供应商">{detail.settlement.supplier_name}</Descriptions.Item>
              <Descriptions.Item label="付款金额">
                <PriceText value={detail.settlement.amount} />
              </Descriptions.Item>
            </Descriptions>
            <ResponsiveTable
              size="small"
              rowKey="id"
              dataSource={detail.items}
              pagination={false}
              columns={[
                {
                  title: '类型',
                  dataIndex: 'doc_type',
                  width: 90,
                  render: (v) => <Tag color={v === 'receipt' ? 'blue' : 'orange'}>{v === 'receipt' ? '采购入库' : '采购退货'}</Tag>,
                },
                { title: '单据编号', dataIndex: 'return_no', width: 170, render: (v) => v || '—' },
                { title: '日期', dataIndex: 'doc_date', width: 110 },
                { title: '单据金额', dataIndex: 'doc_amount', width: 120, align: 'right', render: (v) => <PriceText value={v} /> },
                { title: '本次核销', dataIndex: 'apply_amount', width: 120, align: 'right', render: (v) => <PriceText value={v} /> },
              ]}
            />
          </>
        )}
      </Modal>
    </>
  );
}
