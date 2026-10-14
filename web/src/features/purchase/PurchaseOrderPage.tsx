import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  Alert,
  Button,
  Card,
  DatePicker,
  Divider,
  Empty,
  Form,
  Input,
  InputNumber,
  Radio,
  Select,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd';
import {
  DeleteOutlined,
  EditOutlined,
  ImportOutlined,
  PlusOutlined,
} from '@ant-design/icons';
import { archiveApi, purchaseApi } from '../../api';
import { useList } from '../../hooks/useList';
import { useRowDetail } from '../../hooks/useRowDetail';
import {
  PermGate,
  StatusTag,
  PriceText,
  PrintButton,
  ResponsiveTable,
  DockAction,
  CopyableCode,
  DetailTable,
  FilterBar,
  Modal,
  TopActionBar,
  RowActionButton,
  RowActionGate,
  useRowSelect,
} from '../../components';
import { exportCsv, today } from '../../utils/exportCsv';
import { dayVal } from '../../utils/date';
import { summarize } from '@shared/enums';

interface OrderRow {
  id: number;
  order_no: string;
  product_name?: string;
  summary?: string;
  supplier_name?: string;
  order_date: string;
  expected_date?: string;
  creator_name?: string;
  status: string;
  canReceive: boolean;
  canEdit: boolean;
  canDelete: boolean;
  isParent: boolean;
}

/**
 * 采购明细行。
 *
 * BOM 模式下除物料本身，还带「单位用量 / 需求量 / 已占用 / 可用库存 / 缺料数量」，
 * 全部由服务端 `GET /purchase/orders/bom-preview` 算好，前端只展示与回填，
 * 保证与生产领料扣料的口径一致（都是多级 BOM 展开后的结果）。
 */
interface ItemRow {
  key: string;
  materialId?: number;
  code?: string;
  name?: string;
  spec?: string;
  unit?: string;
  /** 采购数量 */
  qty: number;
  price: number;
  /** 现有库存 */
  stock?: number;
  /** 单件成品耗用量（多级展开汇总） */
  qtyPerUnit?: number;
  /** 需求量 = 单位用量 × 计划产量 */
  requireQty?: number;
  /** 已占用量：未完工工单未领料部分的需求 */
  occupiedQty?: number;
  /** 可用库存 = max(0, 现有库存 − 已占用量) */
  availableQty?: number;
  /** 缺料数量 = max(0, 需求量 − 可用库存) */
  shortageQty?: number;
  /** 建议采购数量 = 缺料数量按单位取整后的值（点「计算」时回填到 qty） */
  purchaseQty?: number;
  /** 采购在途（仅展示，不参与计算） */
  inTransitQty?: number;
  isCarton?: boolean;
}

export default function PurchaseOrderPage() {
  const { list, total, loading, params, patchParams, reload } = useList<OrderRow>((p) =>
    purchaseApi.orders(p),
  );
  const navigate = useNavigate();
  const location = useLocation();

  // 需求 5：点击行展开采购明细。按行 id 缓存，展开过的行不重复请求。
  const detail = useRowDetail((id: number) => purchaseApi.orderDetail(id));

  const [materials, setMaterials] = useState<any[]>([]);
  const [products, setProducts] = useState<any[]>([]);
  const [suppliers, setSuppliers] = useState<any[]>([]);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<OrderRow | null>(null);
  const [mode, setMode] = useState<'bom' | 'direct'>('direct');
  const [items, setItems] = useState<ItemRow[]>([]);
  const [productId, setProductId] = useState<number | undefined>();
  const [planQty, setPlanQty] = useState<number>(100);
  const [bomVersion, setBomVersion] = useState<string>('');
  /**
   * 是否已点过「计算」。
   * 未计算 → 采购数量 = 计划产量（先选品、后填产量时的占位值）；
   * 已计算 → 采购数量 = 服务端算出的缺料数量（取整后）。
   */
  const [calculated, setCalculated] = useState(false);
  /** 服务端测算结果（含 BOM 版本、缺料数量等） */
  const [preview, setPreview] = useState<any>(null);
  const [bomLoading, setBomLoading] = useState(false);
  /** 从排产页「按缺料采购」跳进来时置 true：拿到测算结果后自动按缺料回填一次 */
  const [autoCalc, setAutoCalc] = useState(false);
  /** 手动刷新计数器：BOM 在别处被改过后，用它强制重新拉一次测算 */
  const [bomNonce, setBomNonce] = useState(0);
  const [header, setHeader] = useState<{ orderDate: string; expectedDate: string; remark: string }>({
    orderDate: today(),
    expectedDate: '',
    remark: '',
  });
  const [saving, setSaving] = useState(false);
  /** 顶部操作区：先选中一行，再点按钮（与生产工单页同一套交互） */
  const { selectedId, clearSelection, rowSelection, onRowClick } = useRowSelect();
  const selected = list.find((r) => r.id === selectedId) ?? null;

  useEffect(() => {
    archiveApi.materialOptions().then(setMaterials).catch(() => undefined);
    archiveApi.productOptions().then(setProducts).catch(() => undefined);
    archiveApi.supplierOptions().then(setSuppliers).catch(() => undefined);
  }, []);

  /**
   * 从模拟出货排产页「按缺料采购」跳过来：直接带出主产品 + 计划产量，
   * 切到 BOM 模式并自动按缺料数量回填，用户不用再选品、也不用再点「计算」。
   */
  useEffect(() => {
    const st: any = location.state;
    if (st?.prefill?.productId) {
      setEditing(null);
      setMode('bom');
      setProductId(Number(st.prefill.productId));
      setPlanQty(Number(st.prefill.planQty ?? 0) || 0);
      setCalculated(false);
      setPreview(null);
      setAutoCalc(true);
      setItems([]);
      setBomVersion('');
      setHeader({ orderDate: today(), expectedDate: '', remark: '' });
      setOpen(true);
      navigate('/purchase/orders', { replace: true, state: null });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.state]);

  // 从库存页「去采购」跳转过来时自动带出物料
  useEffect(() => {
    const st: any = location.state;
    if (st?.prefill?.materialIds?.length) {
      setMode('direct');
      setEditing(null);
      setItems(
        st.prefill.materialIds
          .map((id: number) => {
            const m = materials.find((x) => x.id === id);
            if (!m) return null;
            return {
              key: String(id),
              materialId: id,
              code: m.code,
              name: m.name,
              spec: m.spec,
              unit: m.unit,
              qty: 0,
              price: Number(m.avg_cost ?? 0),
              stock: m.current_stock,
            };
          })
          .filter(Boolean),
      );
      setOpen(true);
      navigate('/purchase/orders', { replace: true, state: null });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.state, materials]);

  const materialOptions = useMemo(
    () => materials.map((m) => ({ value: m.id, label: `${m.code} ${m.name}${m.spec ? ` / ${m.spec}` : ''}` })),
    [materials],
  );

  const previewSummary = useMemo(
    () =>
      summarize(
        items.filter((i) => i.materialId).map((i) => i.name ?? ''),
      ),
    [items],
  );

  function addMaterial(id?: number) {
    setItems((prev) => [
      ...prev,
      { key: `n-${Date.now()}-${prev.length}`, materialId: id, qty: 1, price: 0 },
    ]);
  }

  /**
   * 选好主产品 / 改了计划产量 → 自动向服务端要一次「物料需求测算」，
   * 明细行直接铺出来，不需要再点「展开 BOM」。
   *
   * 计算为什么放服务端：需求量要走多级 BOM 展开 + 虚拟件穿透 + 已占用量汇总，
   * 前端自己按单层 BOM 算会和领料扣料的口径对不上，出现「提示充足、一投产就缺料」。
   *
   * 300ms 防抖：计划产量是 InputNumber，边输边请求会把接口打满。
   */
  useEffect(() => {
    if (mode !== 'bom' || !open || !productId) {
      if (mode !== 'bom') setPreview(null);
      return;
    }
    let cancelled = false;
    setBomLoading(true);
    const timer = setTimeout(() => {
      purchaseApi
        .bomPreview({ productId: productId as number, planQty })
        .then((res) => {
          if (cancelled) return;
          setPreview(res);
          setBomVersion(res.bomVersion ?? '');
          const plan = Number(res.planQty ?? planQty) || 0;
          const rows = (res.items ?? []).map((it: any) => ({
            key: `bom-${it.materialId}`,
            materialId: it.materialId,
            code: it.materialCode,
            name: it.materialName,
            spec: it.spec,
            unit: it.unit,
            // 未点「计算」→ 采购数量 = 计划产量；已点 → 采购数量 = 缺料数量
            qty: calculated ? Number(it.purchaseQty ?? 0) : plan,
            price: Number(it.price ?? 0),
            stock: it.stock,
            qtyPerUnit: it.qtyPerUnit,
            requireQty: it.requireQty,
            occupiedQty: it.occupiedQty,
            availableQty: it.availableQty,
            shortageQty: it.shortageQty,
            purchaseQty: it.purchaseQty,
            inTransitQty: it.inTransitQty,
            isCarton: !!it.isCarton,
          }));
          setItems((prev) => {
            // 编辑已保存的订单：只把测算列（需求量 / 缺料数量 …）贴回原行，
            // 采购数量保持单据原值，不能被测算结果顶掉。
            if (editing) {
              const byId = new Map<string, ItemRow>(rows.map((r: ItemRow) => [String(r.materialId), r]));
              return prev.map((x) => {
                const hit = byId.get(String(x.materialId));
                if (!hit) return x;
                return { ...x, ...hit, key: x.key, qty: x.qty, price: x.price };
              });
            }
            return rows;
          });
          // 排产页带参数跳进来时，直接把缺料数量回填成采购数量，用户不用再点一次「计算」
          if (autoCalc) {
            setCalculated(true);
            setAutoCalc(false);
            setItems((prev) =>
              prev.map((x) => ({ ...x, qty: Number(x.purchaseQty ?? x.shortageQty ?? 0) })),
            );
            const n = (res.items ?? []).filter((i: any) => Number(i.shortageQty) > 0).length;
            message.success(
              n > 0
                ? `已带出主产品与计划产量，并按缺料数量回填 ${n} 行采购数量`
                : '已带出主产品与计划产量，当前库存充足、采购数量为 0',
            );
          }
          if (res.bomMissing && !res.bomError) {
            message.warning('该主产品尚未配置 BOM 清单，请先在成品档案里维护');
          }
        })
        .catch((e: any) => {
          if (!cancelled) message.error(e?.message ?? '物料需求测算失败');
        })
        .finally(() => {
          if (!cancelled) setBomLoading(false);
        });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // calculated 变化也要重算一次：点「计算」后采购数量要从「计划产量」切到「缺料数量」
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, open, productId, planQty, calculated, autoCalc, bomNonce, editing]);

  /** 点击「计算」：把各行采购数量回填为缺料数量（库存充足的行为 0） */
  function applyCalculated() {
    if (!productId) {
      message.warning('请先选择主产品');
      return;
    }
    setCalculated(true);
    // 已有测算结果时立刻回填，不等下一次请求往返
    if (preview?.items) {
      setItems((prev) =>
        prev.map((x) => ({ ...x, qty: Number(x.purchaseQty ?? x.shortageQty ?? 0) })),
      );
      const n = (preview.items ?? []).filter((i: any) => Number(i.shortageQty) > 0).length;
      message.success(
        n > 0 ? `已按缺料数量回填 ${n} 行采购数量，其余行库存充足、采购数量为 0` : '当前库存充足，各行采购数量均为 0',
      );
    }
  }

  /** BOM 在别处被改动后手动刷新一次（选品 / 改产量会自动重算，这个只是兜底入口） */
  function refreshBom() {
    if (!productId) {
      message.warning('请先选择主产品');
      return;
    }
    setBomNonce((n) => n + 1);
    message.info('已重新展开 BOM');
  }

  async function openEdit(row: OrderRow) {
    try {
      const detail = await purchaseApi.orderDetail(row.id);
      setEditing(row);
      setMode(detail.order.mode ?? 'direct');
      setProductId(detail.order.product_id ?? undefined);
      setPlanQty(detail.order.plan_qty ?? 100);
      setBomVersion(detail.order.bom_version ?? '');
      setHeader({
        orderDate: detail.order.order_date,
        expectedDate: detail.order.expected_date ?? '',
        remark: detail.order.remark ?? '',
      });
      setItems(
        detail.items.map((i: any) => ({
          key: String(i.id),
          materialId: i.material_id,
          code: i.code,
          name: i.name,
          spec: i.spec,
          unit: i.unit,
          qty: i.qty,
          price: i.price,
        })),
      );
      setOpen(true);
    } catch (e: any) {
      message.error(e.message);
    }
  }

  function openCreate() {
    setEditing(null);
    setMode('direct');
    setItems([]);
    setProductId(undefined);
    setPlanQty(100);
    setBomVersion('');
    setCalculated(false);
    setPreview(null);
    setAutoCalc(false);
    setHeader({ orderDate: today(), expectedDate: '', remark: '' });
    setOpen(true);
  }

  async function submit() {
    const lines = items.filter((i) => i.materialId && i.qty > 0);
    if (lines.length === 0) {
      message.warning('请至少录入一条采购明细，且数量大于 0');
      return;
    }
    setSaving(true);
    try {
      const payload = {
        mode,
        items: lines.map((i) => ({ materialId: i.materialId, qty: i.qty, price: i.price })),
        productId: mode === 'bom' ? productId ?? null : null,
        planQty: mode === 'bom' ? planQty : null,
        // 后端已放开 nullish，这里同步改成「不传」更符合可选项语义，双保险
        bomVersion: mode === 'bom' ? bomVersion || undefined : undefined,
        orderDate: header.orderDate,
        expectedDate: header.expectedDate,
        remark: header.remark,
      };
      if (editing) {
        await purchaseApi.updateOrder(editing.id, payload);
        message.success('订单已更新（原单号不变）');
      } else {
        const res = await purchaseApi.createOrder(payload);
        message.success(`采购订单已创建：${res.orderNo}`);
      }
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
      title="采购订单"
      extra={
        <Space>
          <Input.Search
            placeholder="单号 / 摘要 / 供应商 / 主产品 / 物料"
            allowClear
            style={{ width: 280 }}
            onSearch={(keyword) => patchParams({ keyword })}
          />
          <Button
            onClick={async () => {
              // 需求 5：导出跟随筛选结果 —— 带同样的筛选条件再请求一次并放大 pageSize，
              // 否则导出的只是当前这一页。
              const res = await purchaseApi.orders({ ...params, page: 1, pageSize: 50000 });
              exportCsv(
                `采购订单_${today()}`,
                [
                  { title: '订单编号', key: 'order_no' },
                  { title: '主产品名称', key: 'product_name' },
                  { title: '采购摘要', key: 'summary' },
                  { title: '供应商', key: 'supplier_name' },
                  { title: '下单日期', key: 'order_date' },
                  { title: '预计到货', key: 'expected_date' },
                  { title: '制单人', key: 'creator_name' },
                  { title: '状态', key: 'status' },
                ],
                res.list ?? [],
              );
            }}
          >
            导出
          </Button>
          <PermGate permission="purchase.order.create">
            <DockAction icon={<PlusOutlined />} onClick={openCreate}>新增采购订单</DockAction>
          </PermGate>
        </Space>
      }
    >
      {/* 需求 5：供应商 + 物料包含字筛选 */}
      <FilterBar
        onReset={() =>
          patchParams({ keyword: '', status: '', supplierId: '', materialKeyword: '' })
        }
        extra={
          /* 选中行操作组：先在列表中点行选中，再点这里执行。
             原按钮在每行末尾重复展示，几十条数据时很杂乱，故集中到顶部。
             可用状态由列表接口返回的 canEdit / canReceive / canDelete 决定（后端算好，含权限）。 */
          <TopActionBar>
            <RowActionGate
              selected={selected}
              tipName="采购订单"
              disabledReason={(r) => (r.isParent ? '汇总父单不支持打印' : null)}
            >
              <PrintButton
                docType="purchase_order"
                id={selected?.id ?? 0}
                type="default"
                className="btn-action"
              />
            </RowActionGate>
            <RowActionButton
              text="去入库"
              icon={<ImportOutlined />}
              selected={selected}
              tipName="采购订单"
              disabledReason={(r) => (r.canReceive ? null : '该订单当前不可入库')}
              onAction={(r) => navigate('/purchase/receipts', { state: { receiveOrderId: r.id } })}
            />
            <RowActionButton
              text="编辑"
              icon={<EditOutlined />}
              selected={selected}
              tipName="采购订单"
              disabledReason={(r) => (r.canEdit ? null : '该订单当前不可编辑')}
              onAction={(r) => openEdit(r)}
            />
            <RowActionButton
              text="删除"
              icon={<DeleteOutlined />}
              danger
              selected={selected}
              tipName="采购订单"
              disabledReason={(r) => (r.canDelete ? null : '该订单当前不可删除')}
              confirm={(r) => ({
                title: '确认删除该采购订单？',
                content: `订单「${r.order_no}」删除后不可恢复。`,
              })}
              onAction={async (r) => {
                try {
                  await purchaseApi.deleteOrder(r.id);
                  message.success('已删除');
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
        <Select
          allowClear
          showSearch
          optionFilterProp="label"
          style={{ width: 200 }}
          placeholder="供应商"
          value={params.supplierId || undefined}
          onChange={(v) => patchParams({ supplierId: v ?? '' })}
          options={suppliers.map((s) => ({ value: s.id, label: s.name }))}
        />
        <Input
          allowClear
          style={{ width: 200 }}
          placeholder="物料名称 / 编码包含"
          value={params.materialKeyword ?? ''}
          onChange={(e) => patchParams({ materialKeyword: e.target.value })}
        />
        <Select
          allowClear
          style={{ width: 130 }}
          placeholder="订单状态"
          value={params.status || undefined}
          onChange={(v) => patchParams({ status: v ?? '' })}
          options={[
            { value: '进行中', label: '进行中' },
            { value: '已到齐', label: '已到齐' },
            { value: '部分到货', label: '部分到货' },
            { value: '未到货', label: '未到货' },
            { value: '已关闭', label: '已关闭' },
          ]}
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
        scroll={{ x: 1400 }}
        // 需求 5：点击行展开该订单的采购明细
        expandable={{
          expandedRowRender: (r) => (
            <DetailTable
              loading={detail.loading[r.id]}
              items={detail.cache[r.id]?.items ?? []}
              emptyText={r.isParent ? '汇总父单本身不含明细，请查看拆分后的子单' : '该订单没有明细'}
              columns={[
                { title: '物料编码', dataIndex: 'code', width: 130 },
                { title: '物料名称', dataIndex: 'name', width: 180 },
                { title: '规格', dataIndex: 'spec', width: 150 },
                { title: '单位', dataIndex: 'unit', width: 70 },
                { title: '采购数量', dataIndex: 'qty', width: 100, className: 'mono' },
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
          { title: '订单编号', dataIndex: 'order_no', width: 160, render: (v) => <CopyableCode value={v} /> },
          {
            title: '主产品名称',
            dataIndex: 'product_name',
            width: 180,
            ellipsis: true,
            // 直接采购物料的订单没有主产品
            render: (v) => (v ? <Tooltip title={v}>{v}</Tooltip> : <Typography.Text type="secondary">-</Typography.Text>),
          },
          {
            title: '采购摘要',
            dataIndex: 'summary',
            width: 220,
            ellipsis: true,
            render: (v) => (
              <Tooltip title={v || '-'}>
                <span>{v || '-'}</span>
              </Tooltip>
            ),
          },
          { title: '供应商', dataIndex: 'supplier_name', width: 200, render: (v) => v || '待分配' },
          { title: '下单日期', dataIndex: 'order_date', width: 110 },
          { title: '预计到货', dataIndex: 'expected_date', width: 110, render: (v) => v || '-' },
          { title: '制单人', dataIndex: 'creator_name', width: 110 },
          {
            title: '订单状态',
            dataIndex: 'status',
            width: 100,
            render: (v, r) => (r.isParent ? <Tag>汇总父单</Tag> : <StatusTag status={v} />),
          },
        ]}
      />

      <Modal
        open={open}
        title={editing ? `编辑采购订单 ${editing.order_no}` : '新增采购订单'}
        onCancel={() => setOpen(false)}
        onOk={submit}
        confirmLoading={saving}
        width={1000}
        destroyOnClose
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message={`采购摘要预览：${previewSummary || '尚未选择物料'}`}
          description="多项采购内容在列表与导出中统一展示为「A、B等N项」格式"
        />

        <Radio.Group
          value={mode}
          onChange={(e) => {
            setMode(e.target.value);
            setItems([]);
            // 换采购模式：清空测算状态，避免把 BOM 模式的缺料数量带进直接采购
            setCalculated(false);
            setPreview(null);
            setAutoCalc(false);
          }}
          disabled={!!editing}
        >
          <Radio.Button value="bom">按主产品 BOM 采购</Radio.Button>
          <Radio.Button value="direct">直接采购物料</Radio.Button>
        </Radio.Group>

        {mode === 'bom' && (
          <>
            <Space style={{ marginTop: 12 }} wrap>
              <Select
                showSearch
                style={{ width: 320 }}
                placeholder="按名称 / 编码 / 拼音首字母检索主产品"
                value={productId}
                onChange={(v) => {
                  setProductId(v);
                  // 换主产品 = 重新展开，采购数量回到「未计算」状态
                  setCalculated(false);
                }}
                filterOption={(input, option) => {
                  const p = products.find((x) => x.id === option?.value);
                  if (!p) return false;
                  const kw = input.toLowerCase();
                  return [p.name, p.code, p.pinyin, p.spec].filter(Boolean).join(' ').toLowerCase().includes(kw);
                }}
                notFoundContent="未找到匹配主产品"
                options={products.map((p) => ({ value: p.id, label: `${p.code} ${p.name}` }))}
              />
              <InputNumber
                min={0}
                value={planQty}
                // 允许清空：计划产量为空 / 0 时只展开 BOM 结构，需求量全部为 0
                onChange={(v) => setPlanQty(Number(v ?? 0))}
                addonBefore="计划产量"
              />
              <Button type="primary" loading={bomLoading} onClick={applyCalculated}>
                计算
              </Button>
              <Button onClick={refreshBom}>重新展开</Button>
              {bomVersion ? <Tag color="blue">BOM {bomVersion}</Tag> : null}
              {preview?.deepExpanded ? <Tag color="purple">已展开多级 BOM</Tag> : null}
            </Space>
            <div style={{ marginTop: 8 }}>
              {bomLoading ? (
                <Typography.Text type="secondary">正在展开 BOM 并测算物料需求…</Typography.Text>
              ) : preview?.bomError ? (
                <Alert type="error" showIcon message={`BOM 展开失败：${preview.bomError}`} />
              ) : preview?.bomMissing ? (
                <Alert
                  type="warning"
                  showIcon
                  message="该主产品尚未配置 BOM 清单，请先在成品档案里维护后再计算"
                />
              ) : calculated ? (
                <Typography.Text type="secondary">
                  已按缺料数量回填采购数量（需求量 = 计划产量 × 单位用量，缺料 = 需求量 − 可用库存，
                  库存充足的行为 0）
                </Typography.Text>
              ) : (
                <Typography.Text type="secondary">
                  BOM 已自动展开；采购数量暂按计划产量占位，点「计算」后按缺料数量回填
                </Typography.Text>
              )}
            </div>
          </>
        )}

        {mode === 'direct' && (
          <Space style={{ marginTop: 12 }}>
            <Select
              showSearch
              style={{ width: 340 }}
              placeholder="选择物料后添加（可多选）"
              optionFilterProp="label"
              options={materialOptions}
              onSelect={(v) => addMaterial(v)}
              value={undefined}
            />
            <Button onClick={() => addMaterial()}>添加空行</Button>
          </Space>
        )}

        <Divider style={{ margin: '12px 0' }} />

        <ResponsiveTable
          size="small"
          rowKey="key"
          dataSource={items}
          pagination={false}
          scroll={{ y: 280, x: mode === 'bom' ? 1700 : 1100 }}
          locale={{ emptyText: <Empty description="尚未添加采购明细" /> }}
          columns={[
            {
              title: '物料',
              dataIndex: 'materialId',
              width: 300,
              render: (v, r) => (
                <Select
                  style={{ width: '100%' }}
                  value={v}
                  showSearch
                  optionFilterProp="label"
                  options={materialOptions}
                  onChange={(nv) => {
                    const m = materials.find((x) => x.id === nv);
                    setItems((prev) =>
                      prev.map((x) =>
                        x.key === r.key
                          ? {
                              ...x,
                              materialId: nv,
                              code: m?.code,
                              name: m?.name,
                              spec: m?.spec,
                              unit: m?.unit,
                              price: Number(m?.avg_cost ?? 0),
                              stock: m?.current_stock ?? 0,
                            }
                          : x,
                      ),
                    );
                  }}
                />
              ),
            },
            { title: '规格', dataIndex: 'spec', width: 140 },
            { title: '单位', dataIndex: 'unit', width: 70 },
            // 以下测算列只在「按主产品 BOM 采购」时出现，全部由服务端 bom-preview 算好
            ...(mode === 'bom'
              ? [
                  {
                    title: '单位用量',
                    dataIndex: 'qtyPerUnit',
                    width: 90,
                    className: 'mono',
                    render: (v: any, r: ItemRow) =>
                      r.isCarton ? (
                        <Tooltip title="外箱耗材：按装箱规格折算，非线性用量">
                          <span>{v ?? '-'}*</span>
                        </Tooltip>
                      ) : (
                        (v ?? '-')
                      ),
                  },
                  { title: '需求量', dataIndex: 'requireQty', width: 90, className: 'mono' },
                  {
                    title: '已占用',
                    dataIndex: 'occupiedQty',
                    width: 90,
                    className: 'mono',
                    render: (v: any) => (
                      <Tooltip title="未完工工单未领料部分对该物料的需求量">
                        <span>{v ?? '-'}</span>
                      </Tooltip>
                    ),
                  },
                  { title: '可用库存', dataIndex: 'availableQty', width: 90, className: 'mono' },
                  {
                    title: '缺料数量',
                    dataIndex: 'shortageQty',
                    width: 100,
                    className: 'mono',
                    render: (v: any, r: ItemRow) => {
                      const n = Number(v ?? 0);
                      if (n <= 0) return <Tag color="green">充足</Tag>;
                      return <span style={{ color: '#cf1322', fontWeight: 600 }}>{n}</span>;
                    },
                  },
                  {
                    title: '采购在途',
                    dataIndex: 'inTransitQty',
                    width: 90,
                    className: 'mono',
                    render: (v: any) => (
                      <Tooltip title="已下单未到货数量，仅作参考，不参与缺料计算">
                        <span>{v ?? '-'}</span>
                      </Tooltip>
                    ),
                  },
                ]
              : []),
            { title: '当前库存', dataIndex: 'stock', width: 90, className: 'mono' },
            {
              title: '采购数量',
              dataIndex: 'qty',
              width: 130,
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
              width: 120,
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
        <Space wrap>
          <DatePicker
            value={dayVal(header.orderDate)}
            onChange={(d) => setHeader((h) => ({ ...h, orderDate: d ? d.format('YYYY-MM-DD') : '' }))}
          />
          <DatePicker
            placeholder="预计到货日期"
            value={dayVal((header.expectedDate || undefined))}
            onChange={(d) => setHeader((h) => ({ ...h, expectedDate: d ? d.format('YYYY-MM-DD') : '' }))}
          />
          <Input
            style={{ width: 260 }}
            placeholder="备注"
            value={header.remark}
            onChange={(e) => setHeader((h) => ({ ...h, remark: e.target.value }))}
          />
        </Space>
        <div style={{ marginTop: 8, color: '#8c8c8c', fontSize: 12 }}>
          提交时系统按各物料的默认供应商自动拆分为多个子订单；未维护默认供应商的物料归集为待分配子单，需手工指定供应商。
        </div>
      </Modal>
    </Card>
  );
}
