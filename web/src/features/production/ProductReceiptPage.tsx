import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  Alert,
  Button,
  Card,
  DatePicker,
  Divider,
  Empty,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  Typography,
  message,
} from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { archiveApi, productionApi } from '../../api';
import { ApiError } from '../../api/client';
import { useList } from '../../hooks/useList';
import { PermGate, StatusTag, PrintButton, ResponsiveTable, DockAction, CopyableCode } from '../../components';
import { exportCsv, today } from '../../utils/exportCsv';
import { dayVal } from '../../utils/date';

const RECEIPT_TYPES = ['成品入库（直接扣料）', '生产入库（已领料）', '售后返修入库'] as const;
type ReceiptType = (typeof RECEIPT_TYPES)[number];

interface ItemRow {
  key: string;
  productId?: number;
  qty: number;
}

export default function ProductReceiptPage() {
  const { list, total, loading, params, patchParams, reload } = useList<any>((p) =>
    productionApi.receipts(p),
  );
  const navigate = useNavigate();
  const location = useLocation();

  const [products, setProducts] = useState<any[]>([]);
  const [woOptions, setWoOptions] = useState<any[]>([]);
  const [issueOptions, setIssueOptions] = useState<any[]>([]);
  const [open, setOpen] = useState(false);
  const [receiptType, setReceiptType] = useState<ReceiptType>('成品入库（直接扣料）');
  const [woId, setWoId] = useState<number | undefined>();
  const [issueId, setIssueId] = useState<number | undefined>();
  const [receiptDate, setReceiptDate] = useState(today());
  const [remark, setRemark] = useState('');
  const [items, setItems] = useState<ItemRow[]>([]);
  const [locked, setLocked] = useState(false);
  const [saving, setSaving] = useState(false);
  const [shortages, setShortages] = useState<any[] | null>(null);

  useEffect(() => {
    archiveApi.productOptions().then(setProducts).catch(() => undefined);
    productionApi.workOrderOptions().then(setWoOptions).catch(() => undefined);
    productionApi
      .issues({ pageSize: 200 })
      .then((r) => setIssueOptions(r.list.filter((i: any) => i.status === '有效')))
      .catch(() => undefined);
  }, []);

  /** 两条去入库分流（需求 4.6） */
  useEffect(() => {
    const st: any = location.state;
    if (st?.workOrderId) {
      productionApi
        .forReceiptByWo(st.workOrderId)
        .then((d) => {
          setReceiptType(d.receiptType as ReceiptType);
          setWoId(st.workOrderId);
          setIssueId(undefined);
          setLocked(false);
          setItems([{ key: 'wo', productId: d.productId, qty: d.suggestQty }]);
          setReceiptDate(today());
          setRemark('');
          setOpen(true);
        })
        .catch((e: any) => message.error(e.message));
      navigate('/production/receipts', { replace: true, state: null });
    }
    if (st?.issueId) {
      productionApi
        .forReceiptByIssue(st.issueId)
        .then((d) => {
          setReceiptType(d.receiptType as ReceiptType);
          setWoId(d.workOrderId);
          setIssueId(st.issueId);
          setLocked(true); // 类型与数量锁定，只读
          setItems([{ key: 'issue', productId: d.productId, qty: d.lockQty }]);
          setReceiptDate(today());
          setRemark('');
          setOpen(true);
        })
        .catch((e: any) => message.error(e.message));
      navigate('/production/receipts', { replace: true, state: null });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.state]);

  function openBlank() {
    setReceiptType('成品入库（直接扣料）');
    setWoId(undefined);
    setIssueId(undefined);
    setLocked(false);
    setItems([]);
    setReceiptDate(today());
    setRemark('');
    setOpen(true);
  }

  async function doSave(skipProductIds: number[] = []) {
    const lines = items.filter((i) => i.productId && i.qty > 0);
    if (lines.length === 0) {
      message.warning('请至少录入一条入库明细');
      return;
    }
    setSaving(true);
    try {
      await productionApi.createReceipt({
        receiptType,
        woId: woId ?? null,
        issueId: issueId ?? null,
        receiptDate,
        remark,
        skipProductIds,
        items: lines.map((i) => ({ productId: i.productId, qty: i.qty })),
      });
      message.success('成品入库成功');
      setOpen(false);
      setShortages(null);
      reload();
    } catch (e: any) {
      // 局部缺料：展示短缺成品并让用户选择剔除后继续（需求 4.7）
      if (e instanceof ApiError && e.code === 'SHORTAGE_PARTIAL') {
        setShortages(e.detail?.shortages ?? []);
        return;
      }
      message.error(e.message);
    } finally {
      setSaving(false);
    }
  }

  const isDirect = receiptType === '成品入库（直接扣料）';
  const isIssued = receiptType === '生产入库（已领料）';

  return (
    <Card
      title="成品入库"
      extra={
        <Space>
          <Input.Search
            placeholder="工单号 / 成品名称"
            allowClear
            style={{ width: 220 }}
            onSearch={(keyword) => patchParams({ keyword })}
          />
          <Button
            onClick={() =>
              exportCsv(`成品入库_${today()}`, [
                { title: '入库日期', key: 'receipt_date' },
                { title: '入库类型', key: 'receipt_type' },
                { title: '入库内容', key: 'content' },
                { title: '总数', key: 'total_qty' },
                { title: '关联工单', key: 'wo_no' },
                { title: '关联领料单', key: 'issue_no' },
                { title: '操作人', key: 'operator_name' },
                { title: '状态', key: 'status' },
              ], list)
            }
          >
            导出
          </Button>
          <PermGate permission="production.receipt.create">
            <DockAction icon={<PlusOutlined />} onClick={openBlank}>新增入库</DockAction>
          </PermGate>
        </Space>
      }
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="成品入库单号在全系统前端不可见（列表、导出、打印均已移除），后台保留唯一 ID 用于追溯与撤销"
      />
      <ResponsiveTable
        rowKey="id"
        size="small"
        loading={loading}
        dataSource={list}
        scroll={{ x: 1300 }}
        pagination={{
          current: params.page,
          pageSize: params.pageSize,
          total,
          onChange: (page, pageSize) => patchParams({ page, pageSize }),
          showSizeChanger: true,
        }}
        columns={[
          { title: '入库日期', dataIndex: 'receipt_date', width: 110 },
          {
            title: '入库类型',
            dataIndex: 'receipt_type',
            width: 170,
            render: (v) => <Tag color={v === '成品入库（直接扣料）' ? 'blue' : v === '生产入库（已领料）' ? 'green' : 'purple'}>{v}</Tag>,
          },
          { title: '入库内容', dataIndex: 'content', ellipsis: true },
          { title: '总数', dataIndex: 'total_qty', width: 90, className: 'mono' },
          { title: '关联工单', dataIndex: 'wo_no', width: 150, render: (v) => <CopyableCode value={v} /> },
          { title: '关联领料单', dataIndex: 'issue_no', width: 150, render: (v) => <CopyableCode value={v} /> },
          { title: '操作人', dataIndex: 'operator_name', width: 110 },
          { title: '状态', dataIndex: 'status', width: 90, render: (v) => <StatusTag status={v} /> },
          {
            title: '操作',
            width: 160,
            fixed: 'right',
            render: (_, r) => (
              <Space size={0}>
                <PrintButton docType="product_receipt" id={r.id} />
                {r.canUndo ? (
                  <Popconfirm
                    title="确认撤销该成品入库单？"
                    onConfirm={async () => {
                      try {
                        await productionApi.undoReceipt(r.id);
                        message.success('已撤销，库存与工单已入库量已回滚');
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
                ) : (
                  '-'
                )}
              </Space>
            ),
          },
        ]}
      />

      <Modal
        open={open}
        title="新增成品入库"
        onCancel={() => setOpen(false)}
        onOk={() => doSave()}
        confirmLoading={saving}
        width={900}
        destroyOnClose
      >
        <Space wrap style={{ marginBottom: 12 }}>
          <Select
            style={{ width: 260 }}
            value={receiptType}
            onChange={(v) => {
              setReceiptType(v);
              setLocked(false);
              if (v !== '成品入库（直接扣料）') setItems([]);
            }}
            disabled={locked}
            options={RECEIPT_TYPES.map((t) => ({ value: t, label: t }))}
          />
          {isIssued && (
            <Select
              style={{ width: 300 }}
              placeholder="选择领料单（必填）"
              value={issueId}
              onChange={(v) => {
                setIssueId(v);
                productionApi
                  .forReceiptByIssue(v)
                  .then((d) => {
                    setWoId(d.workOrderId);
                    setLocked(true);
                    setItems([{ key: 'issue', productId: d.productId, qty: d.lockQty }]);
                  })
                  .catch((e: any) => message.error(e.message));
              }}
              optionFilterProp="label"
              options={issueOptions.map((i: any) => ({
                value: i.id,
                label: `${i.issue_no} · ${i.productName} · ${i.produce_qty}`,
              }))}
            />
          )}
          <Select
            style={{ width: 260 }}
            placeholder="关联生产工单（可选）"
            allowClear
            value={woId}
            onChange={setWoId}
            disabled={isIssued}
            optionFilterProp="label"
            options={woOptions.map((o) => ({ value: o.id, label: `${o.wo_no} · ${o.product_name}` }))}
          />
          <DatePicker value={dayVal(receiptDate)} onChange={(d) => setReceiptDate(d ? d.format('YYYY-MM-DD') : today())} />
        </Space>

        {locked && (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 12 }}
            message="已领料工单：入库类型与数量由系统锁定（领料数量与可入库余量取小值），不可修改，防止超产与重复刷库存"
          />
        )}

        <Space style={{ marginBottom: 8 }}>
          <Button
            size="small"
            disabled={locked}
            onClick={() => setItems((prev) => [...prev, { key: `n-${Date.now()}`, qty: 1 }])}
          >
            添加成品
          </Button>
          {isDirect && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              支持多个产品同时入库，相同成品自动合并；缺料成品会被单独拦截
            </Typography.Text>
          )}
        </Space>

        <ResponsiveTable
          size="small"
          rowKey="key"
          dataSource={items}
          pagination={false}
          scroll={{ y: 260 }}
          locale={{ emptyText: <Empty description="请添加入库成品" /> }}
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
                  disabled={locked}
                  options={products.map((p) => ({ value: p.id, label: `${p.code} ${p.name}` }))}
                  onChange={(nv) => setItems((prev) => prev.map((x) => (x.key === r.key ? { ...x, productId: nv } : x)))}
                />
              ),
            },
            {
              title: '入库数量',
              dataIndex: 'qty',
              width: 140,
              render: (v, r) => (
                <InputNumber
                  min={0}
                  value={v}
                  disabled={locked}
                  style={{ width: '100%' }}
                  onChange={(nv) => setItems((prev) => prev.map((x) => (x.key === r.key ? { ...x, qty: Number(nv ?? 0) } : x)))}
                />
              ),
            },
            {
              title: '操作',
              width: 70,
              render: (_, r) => (
                <Button
                  type="link"
                  size="small"
                  danger
                  disabled={locked}
                  onClick={() => setItems((prev) => prev.filter((x) => x.key !== r.key))}
                >
                  移除
                </Button>
              ),
            },
          ]}
        />

        <Divider style={{ margin: '12px 0' }} />
        <Input.TextArea rows={2} placeholder="备注" value={remark} onChange={(e) => setRemark(e.target.value)} />
      </Modal>

      {/* 局部缺料拦截（需求 4.7） */}
      <Modal
        open={!!shortages}
        title="部分成品子物料不足"
        onCancel={() => setShortages(null)}
        okText="移除缺料成品并继续入库"
        cancelText="取消本次入库"
        onOk={() => {
          const ids = (shortages ?? []).map((s) => s.productId);
          setShortages(null);
          doSave(ids);
        }}
        width={680}
      >
        <Typography.Paragraph>
          以下成品的子物料库存不足，系统会将其剔除，其余库存充足的成品继续入库。
        </Typography.Paragraph>
        {(shortages ?? []).map((s) => (
          <div key={s.productId} style={{ marginBottom: 12 }}>
            <b>{s.productName}</b>
            <ResponsiveTable
              size="small"
              rowKey="materialId"
              pagination={false}
              dataSource={s.details}
              style={{ marginTop: 6 }}
              columns={[
                { title: '物料', dataIndex: 'materialName' },
                { title: '需要', dataIndex: 'need', width: 90, className: 'mono' },
                { title: '可用', dataIndex: 'available', width: 90, className: 'mono' },
                {
                  title: '缺口',
                  dataIndex: 'shortage',
                  width: 90,
                  className: 'mono',
                  render: (v) => <span style={{ color: '#cf1322' }}>{v}</span>,
                },
              ]}
            />
          </div>
        ))}
      </Modal>
    </Card>
  );
}
