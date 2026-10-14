import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  Alert,
  Button,
  Card,
  Checkbox,
  DatePicker,
  Divider,
  Empty,
  Input,
  InputNumber,
  Select,
  Space,
  Table,
  Tag,
  Tooltip,
  message,
} from 'antd';
import {
  EditOutlined,
  PlusOutlined,
  RollbackOutlined,
  ScanOutlined,
} from '@ant-design/icons';
import { archiveApi, purchaseApi } from '../../api';
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
  SearchableSelect,
  Modal,
  TopActionBar,
  RowActionButton,
  RowActionGate,
  useRowSelect,
  WarehouseSelect,
} from '../../components';
import { useRowDetail } from '../../hooks/useRowDetail';
import { exportCsv, today } from '../../utils/exportCsv';
import { dayVal } from '../../utils/date';
import OcrImportModal, { type OcrDraft } from './OcrImportModal';

interface ItemRow {
  key: string;
  materialId?: number;
  code?: string;
  name?: string;
  spec?: string;
  unit?: string;
  qty: number;
  price: number;
  pending?: number;
  isGift: boolean;
}

export default function PurchaseReceiptPage() {
  const { list, total, loading, params, patchParams, reload } = useList<any>((p) =>
    purchaseApi.receipts(p),
  );
  // 需求 6：点击行展开入库明细
  const detail = useRowDetail((id: number) => purchaseApi.receiptDetail(id));
  const navigate = useNavigate();
  const location = useLocation();

  const [materials, setMaterials] = useState<any[]>([]);
  const [suppliers, setSuppliers] = useState<any[]>([]);
  const [orders, setOrders] = useState<any[]>([]);
  const [open, setOpen] = useState(false);
  const [orderId, setOrderId] = useState<number | undefined>();
  const [supplierId, setSupplierId] = useState<number | undefined>();
  const [receiptDate, setReceiptDate] = useState(today());
  const [remark, setRemark] = useState('');
  const [items, setItems] = useState<ItemRow[]>([]);
  const [pendingInfo, setPendingInfo] = useState<any>(null);
  const [saving, setSaving] = useState(false);
  const [ocrOpen, setOcrOpen] = useState(false);
  /** OCR 识别请求号：随建单一起提交，便于回写 ocr_logs 统计采纳率 */
  const [ocrRequestId, setOcrRequestId] = useState<string | undefined>();
  /** 多仓库：入到哪个仓；不传时服务端按物料默认仓（物料库）兜底 */
  const [warehouseId, setWarehouseId] = useState<number | null>(null);

  // 需求：物料单价允许 0、价格后补——补录/修改已入库单据单价
  const [repriceOpen, setRepriceOpen] = useState(false);
  const [repriceId, setRepriceId] = useState<number | null>(null);
  const [repriceNo, setRepriceNo] = useState('');
  const [repriceItems, setRepriceItems] = useState<any[]>([]);
  const [repricePrices, setRepricePrices] = useState<Record<number, number | string>>({});
  const [repriceSaving, setRepriceSaving] = useState(false);
  /** 顶部操作区：先选中一行，再点按钮（与生产工单页同一套交互） */
  const { selectedId, clearSelection, rowSelection, onRowClick } = useRowSelect();
  const selected = list.find((r) => r.id === selectedId) ?? null;

  useEffect(() => {
    archiveApi.materialOptions().then(setMaterials).catch(() => undefined);
    archiveApi.supplierOptions().then(setSuppliers).catch(() => undefined);
  }, []);

  useEffect(() => {
    purchaseApi
      .orders({ pageSize: 200 })
      .then((r) => setOrders(r.list.filter((o: any) => !o.isParent)))
      .catch(() => undefined);
  }, []);

  /** 从采购订单列表「去入库」跳转：自动带出订单与待入库明细（需求 4.1） */
  useEffect(() => {
    const st: any = location.state;
    if (st?.receiveOrderId) {
      openForOrder(st.receiveOrderId);
      navigate('/purchase/receipts', { replace: true, state: null });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.state]);

  async function openForOrder(id: number) {
    try {
      const res = await purchaseApi.pending(id);
      setPendingInfo(res);
      setOrderId(id);
      setSupplierId(res.order.supplier_id ?? undefined);
      setReceiptDate(today());
      setRemark('');
      setItems(
        res.items.map((i: any, idx: number) => ({
          key: `p-${idx}`,
          materialId: i.materialId,
          code: i.materialCode,
          name: i.materialName,
          spec: i.spec,
          unit: i.unit,
          qty: i.pendingQty,
          price: i.price,
          pending: i.pendingQty,
          isGift: false,
        })),
      );
      setOpen(true);
    } catch (e: any) {
      message.error(e.message);
    }
  }

  function openBlank() {
    setPendingInfo(null);
    setOrderId(undefined);
    setSupplierId(undefined);
    setReceiptDate(today());
    setRemark('');
    setItems([]);
    setOcrRequestId(undefined);
    setWarehouseId(null);
    setOpen(true);
  }

  /** OCR 识别结果回填建单表单：仍停留在表单里让人工复核，不直接落库 */
  function applyOcr(draft: OcrDraft) {
    setPendingInfo(null);
    setOrderId(undefined);
    setSupplierId(draft.supplierId ?? undefined);
    setReceiptDate(today());
    setRemark('');
    setOcrRequestId(draft.requestId);
    setWarehouseId(null);
    setItems(
      draft.lines.map((l, idx) => ({
        key: `ocr-${idx}`,
        materialId: l.materialId ?? undefined,
        code: l.materialCode,
        name: l.materialName,
        spec: l.spec,
        unit: l.unit,
        qty: l.qty,
        price: l.price,
        isGift: false,
      })),
    );
    setOcrOpen(false);
    setOpen(true);
    message.success(`已填入 ${draft.lines.length} 行识别结果，请核对后提交`);
  }

  async function submit() {
    const lines = items.filter((i) => i.materialId && i.qty > 0);
    if (lines.length === 0) {
      message.warning('请至少录入一条入库明细');
      return;
    }
    setSaving(true);
    try {
      await purchaseApi.createReceipt({
        orderId: orderId ?? null,
        supplierId: supplierId ?? null,
        receiptDate,
        remark,
        source: orderId ? 'order' : 'ocr',
        ocrRequestId,
        warehouseId: warehouseId ?? undefined,
        items: lines.map((i) => ({
          materialId: i.materialId,
          qty: i.qty,
          price: i.price,
          isGift: i.isGift,
        })),
      });
      message.success('入库成功，库存已增加并重算移动加权成本');
      setOpen(false);
      reload();
    } catch (e: any) {
      message.error(e.message);
    } finally {
      setSaving(false);
    }
  }

  /** 打开补录单价弹窗：载入该单明细，默认带出当前单价（允许改为 0 或真实价） */
  async function openReprice(r: any) {
    try {
      const res = await purchaseApi.receiptDetail(r.id);
      const rows: any[] = res.items ?? [];
      setRepriceId(r.id);
      setRepriceNo(r.receipt_no ?? r.receiptNo ?? '');
      setRepriceItems(rows);
      const init: Record<number, number | string> = {};
      for (const it of rows) init[it.material_id ?? it.materialId] = Number(it.price ?? 0);
      setRepricePrices(init);
      setRepriceOpen(true);
    } catch (e: any) {
      message.error(e.message);
    }
  }

  async function submitReprice() {
    if (!repriceId) return;
    const prices = repriceItems.map((it) => ({
      materialId: it.material_id ?? it.materialId,
      price: Number(repricePrices[it.material_id ?? it.materialId] ?? 0) || 0,
    }));
    setRepriceSaving(true);
    try {
      const res = await purchaseApi.repriceReceipt(repriceId, prices);
      message.success(`单价已补录，单据金额更新为 ${Number(res.totalAmount).toFixed(2)}`);
      setRepriceOpen(false);
      // 刷新展开明细缓存
      if (repriceId && detail.cache[repriceId]) void detail.load(repriceId);
      reload();
    } catch (e: any) {
      message.error(e.message);
    } finally {
      setRepriceSaving(false);
    }
  }

  return (
    <Card
      title="采购入库"
      extra={
        <Space>
          <Input.Search
            placeholder="供应商 / 物料"
            allowClear
            style={{ width: 220 }}
            onSearch={(keyword) => patchParams({ keyword })}
          />
          <Button
            onClick={async () => {
              // 需求 6：导出跟随筛选结果
              const res = await purchaseApi.receipts({ ...params, page: 1, pageSize: 50000 });
              exportCsv(
                `采购入库_${today()}`,
                [
                  { title: '入库日期', key: 'receipt_date' },
                  { title: '采购内容', key: 'purchaseContent' },
                  { title: '供应商', key: 'supplier_name' },
                  { title: '关联订单', key: 'order_no' },
                  { title: '金额', key: 'total_amount' },
                  { title: '状态', key: 'status' },
                  { title: '操作人', key: 'operator_name' },
                ],
                res.list ?? [],
              );
            }}
          >
            导出
          </Button>
          <PermGate permission="purchase.receipt.create">
            <Button icon={<ScanOutlined />} onClick={() => setOcrOpen(true)}>
              OCR 识别建单
            </Button>
          </PermGate>
          <PermGate permission="purchase.receipt.create">
            <DockAction icon={<PlusOutlined />} onClick={openBlank}>新增入库</DockAction>
          </PermGate>
        </Space>
      }
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="入库单号在全系统前端不可见（列表、导出、打印均已移除），后台保留唯一 ID 用于追溯与回滚"
      />

      {/* 需求 6：日期区间 + 供应商 + 物料包含字筛选 */}
      <FilterBar
        onReset={() =>
          patchParams({ keyword: '', supplierId: '', materialKeyword: '', dateFrom: '', dateTo: '' })
        }
        extra={
          /* 选中行操作组：先在列表中点行选中，再点这里执行。
             原「打印 / 撤销」在每行末尾重复展示，几十条数据时很杂乱，故集中到顶部。
             是否可撤销由列表接口返回的 canUndo 决定（后端算好，含权限）。 */
          <TopActionBar>
            <RowActionGate selected={selected} tipName="采购入库单">
              <PrintButton
                docType="purchase_receipt"
                id={selected?.id ?? 0}
                type="default"
                className="btn-action"
              />
            </RowActionGate>
            {/* 补录 / 修改单价：原来藏在「展开明细」里，统一提到顶部操作区 */}
            <RowActionButton
              text="补录单价"
              icon={<EditOutlined />}
              selected={selected}
              tipName="采购入库单"
              disabledReason={(r) => (r.canUndo ? null : '该入库单当前不可修改单价')}
              onAction={(r) => openReprice(r)}
            />
            <RowActionButton
              text="撤销"
              icon={<RollbackOutlined />}
              danger
              selected={selected}
              tipName="采购入库单"
              disabledReason={(r) => (r.canUndo ? null : '该入库单当前不可撤销')}
              confirm={(r) => ({
                title: '确认撤销该入库单？',
                content: `入库单「${r.purchaseContent ?? r.supplier_name ?? ''}」撤销后库存将回滚至入库前，且不可恢复。`,
              })}
              onAction={async (r) => {
                try {
                  await purchaseApi.undoReceipt(r.id);
                  message.success('已撤销，库存已回滚');
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
        <Select
          allowClear
          showSearch
          optionFilterProp="label"
          style={{ width: 180 }}
          placeholder="供应商"
          value={params.supplierId || undefined}
          onChange={(v) => patchParams({ supplierId: v ?? '' })}
          options={suppliers.map((s) => ({ value: s.id, label: s.name }))}
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
        scroll={{ x: 1300 }}
        // 需求 6：点击行展开入库明细
        expandable={{
          expandedRowRender: (r) => (
            <div>
              <DetailTable
                loading={detail.loading[r.id]}
                items={detail.cache[r.id]?.items ?? []}
                columns={[
                  { title: '物料编码', dataIndex: 'code', width: 130 },
                  { title: '物料名称', dataIndex: 'name', width: 180 },
                  { title: '规格', dataIndex: 'spec', width: 150 },
                  { title: '单位', dataIndex: 'unit', width: 70 },
                  { title: '入库数量', dataIndex: 'qty', width: 100, className: 'mono' },
                  { title: '单价', dataIndex: 'price', width: 100, render: (v) => <PriceText value={v} /> },
                  {
                    title: '金额',
                    width: 110,
                    className: 'mono',
                    render: (_v, it) => (
                      <PriceText value={Number(it.qty ?? 0) * Number(it.price ?? 0)} />
                    ),
                  },
                  { title: '备注', dataIndex: 'remark' },
                ]}
              />
              {/* 需求：单价允许 0、价格后补。入口已统一提到顶部操作区「补录单价」，
                  这里不再重复放按钮（避免同一操作两处入口、样式不一致）。 */}
            </div>
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
          { title: '入库日期', dataIndex: 'receipt_date', width: 110 },
          {
            title: '采购内容',
            dataIndex: 'purchaseContent',
            width: 220,
            ellipsis: true,
            render: (v) => (
              <Tooltip title={v || '-'}>
                <span>{v || '-'}</span>
              </Tooltip>
            ),
          },
          { title: '供应商', dataIndex: 'supplier_name', width: 200, render: (v) => v || '-' },
          { title: '关联订单', dataIndex: 'order_no', width: 150, render: (v) => (v ? <CopyableCode value={v} /> : '无关联订单') },
          {
            title: '金额',
            dataIndex: 'total_amount',
            width: 110,
            render: (v) => <PriceText value={v} />,
          },
          { title: '来源', dataIndex: 'source', width: 90, render: (v) => (v === 'ocr' ? <Tag color="purple">识别入库</Tag> : <Tag>关联订单</Tag>) },
          { title: '操作人', dataIndex: 'operator_name', width: 110 },
          { title: '状态', dataIndex: 'status', width: 90, render: (v) => <StatusTag status={v} /> },
        ]}
      />

      <Modal
        open={open}
        title={orderId ? '关联订单入库' : '直接入库'}
        onCancel={() => setOpen(false)}
        onOk={submit}
        confirmLoading={saving}
        width={1000}
        destroyOnClose
      >
        <Space wrap style={{ marginBottom: 12 }}>
          <Select
            style={{ width: 340 }}
            placeholder="关联采购订单（可选）"
            allowClear
            showSearch
            optionFilterProp="label"
            value={orderId}
            onChange={(v) => {
              setOrderId(v);
              if (v) openForOrder(v);
              else {
                setPendingInfo(null);
                setItems([]);
              }
            }}
            options={orders.map((o: any) => ({
              value: o.id,
              label: `${o.order_no} · ${o.summary ?? ''} · ${o.supplier_name ?? '待分配'}`,
            }))}
          />
          <SearchableSelect
            style={{ width: 240 }}
            placeholder="供应商"
            allowClear
            value={supplierId}
            onChange={setSupplierId}
            options={suppliers.map((s) => ({ value: s.id, label: s.name }))}
          />
          <DatePicker
            value={dayVal(receiptDate)}
            onChange={(d) => setReceiptDate(d ? d.format('YYYY-MM-DD') : today())}
          />
          <div>
            <div style={{ marginBottom: 4, fontSize: 12, color: '#595959' }}>入库仓库</div>
            <WarehouseSelect
              itemType="material"
              value={warehouseId}
              onChange={setWarehouseId}
              style={{ width: 200 }}
            />
          </div>
        </Space>

        {pendingInfo && (
          <Alert
            type="success"
            showIcon
            style={{ marginBottom: 12 }}
            message={`已带出订单 ${pendingInfo.order.order_no}（${pendingInfo.order.supplier_name ?? '待分配供应商'}）的待入库明细`}
          />
        )}

        <Space style={{ marginBottom: 8 }}>
          <Button
            size="small"
            onClick={() =>
              setItems((prev) => [
                ...prev,
                { key: `n-${Date.now()}`, qty: 1, price: 0, isGift: false },
              ])
            }
          >
            添加明细行
          </Button>
        </Space>

        <ResponsiveTable
          size="small"
          rowKey="key"
          dataSource={items}
          pagination={false}
          scroll={{ y: 300 }}
          locale={{ emptyText: <Empty description="请添加入库明细" /> }}
          columns={[
            {
              title: '物料',
              dataIndex: 'materialId',
              width: 280,
              render: (v, r) => (
                <Select
                  style={{ width: '100%' }}
                  value={v}
                  showSearch
                  optionFilterProp="label"
                  options={materials.map((m) => ({
                    value: m.id,
                    label: `${m.code} ${m.name}`,
                  }))}
                  onChange={(nv) => {
                    const m = materials.find((x) => x.id === nv);
                    setItems((prev) =>
                      prev.map((x) =>
                        x.key === r.key
                          ? { ...x, materialId: nv, code: m?.code, name: m?.name, spec: m?.spec, unit: m?.unit }
                          : x,
                      ),
                    );
                  }}
                />
              ),
            },
            { title: '规格', dataIndex: 'spec', width: 130 },
            { title: '单位', dataIndex: 'unit', width: 70 },
            {
              title: '待入库',
              dataIndex: 'pending',
              width: 90,
              className: 'mono',
              render: (v) => v ?? '-',
            },
            {
              title: '入库数量',
              dataIndex: 'qty',
              width: 120,
              render: (v, r) => (
                <InputNumber
                  min={0}
                  value={v}
                  style={{ width: '100%' }}
                  onChange={(nv) =>
                    setItems((prev) => prev.map((x) => (x.key === r.key ? { ...x, qty: Number(nv ?? 0) } : x)))
                  }
                />
              ),
            },
            {
              title: '单价',
              dataIndex: 'price',
              width: 110,
              render: (v, r) => (
                <InputNumber
                  min={0}
                  step={0.01}
                  value={v}
                  style={{ width: '100%' }}
                  onChange={(nv) =>
                    setItems((prev) => prev.map((x) => (x.key === r.key ? { ...x, price: Number(nv ?? 0) } : x)))
                  }
                />
              ),
            },
            {
              title: '赠品',
              dataIndex: 'isGift',
              width: 70,
              render: (v, r) => (
                <Checkbox
                  checked={v}
                  onChange={(e) =>
                    setItems((prev) =>
                      prev.map((x) => (x.key === r.key ? { ...x, isGift: e.target.checked } : x)),
                    )
                  }
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
                  onClick={() => setItems((prev) => prev.filter((x) => x.key !== r.key))}
                >
                  移除
                </Button>
              ),
            },
          ]}
        />

        <Divider style={{ margin: '12px 0' }} />
        <Input.TextArea
          rows={2}
          placeholder="备注"
          value={remark}
          onChange={(e) => setRemark(e.target.value)}
        />
        <div style={{ marginTop: 8, color: '#8c8c8c', fontSize: 12 }}>
          超过订单数量的入库会被标记为「超量待结算」，不阻断入库；赠品行按 0 成本计入库存。
        </div>
      </Modal>

      <OcrImportModal open={ocrOpen} onCancel={() => setOcrOpen(false)} onApply={applyOcr} />

      {/* 需求：物料单价允许 0、价格后补 —— 补录/修改已入库单据单价 */}
      <Modal
        open={repriceOpen}
        title={`补录 / 修改单价${repriceNo ? ` · ${repriceNo}` : ''}`}
        onCancel={() => setRepriceOpen(false)}
        onOk={submitReprice}
        okText="确认改价"
        okButtonProps={{ loading: repriceSaving }}
        width={720}
        destroyOnClose
      >
        <div style={{ marginBottom: 8, color: '#8c8c8c', fontSize: 12 }}>
          可把 0 价改为真实单价，也可整体改价。改价会重算单据金额与对应物料的移动加权成本。
        </div>
        <ResponsiveTable
          size="small"
          rowKey={(r) => String(r.material_id ?? r.materialId)}
          dataSource={repriceItems}
          pagination={false}
          scroll={{ y: 320 }}
          columns={[
            { title: '物料', width: 220, render: (_v, r) => `${r.code ?? ''} ${r.name ?? ''}` },
            { title: '数量', dataIndex: 'qty', width: 90, className: 'mono' },
            {
              title: '新单价',
              width: 150,
              render: (_v, r) => {
                const mid = r.material_id ?? r.materialId;
                return (
                  <InputNumber
                    min={0}
                    step={0.01}
                    style={{ width: '100%' }}
                    value={repricePrices[mid] ?? 0}
                    onChange={(nv) =>
                      setRepricePrices((prev) => ({ ...prev, [mid]: nv ?? 0 }))
                    }
                  />
                );
              },
            },
            {
              title: '新金额',
              width: 110,
              className: 'mono',
              render: (_v, r) => {
                const mid = r.material_id ?? r.materialId;
                return Number(((repricePrices[mid] ?? 0) as number) * Number(r.qty ?? 0)).toFixed(2);
              },
            },
          ]}
        />
      </Modal>
    </Card>
  );
}
