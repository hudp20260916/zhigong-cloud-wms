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
  Modal,
  Popconfirm,
  Radio,
  Select,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { archiveApi, purchaseApi } from '../../api';
import { useList } from '../../hooks/useList';
import { PermGate, StatusTag, PrintButton, ResponsiveTable, DockAction, CopyableCode } from '../../components';
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

interface ItemRow {
  key: string;
  materialId?: number;
  code?: string;
  name?: string;
  spec?: string;
  unit?: string;
  qty: number;
  price: number;
  stock?: number;
  need?: number;
}

export default function PurchaseOrderPage() {
  const { list, total, loading, params, patchParams, reload } = useList<OrderRow>((p) =>
    purchaseApi.orders(p),
  );
  const navigate = useNavigate();
  const location = useLocation();

  const [materials, setMaterials] = useState<any[]>([]);
  const [products, setProducts] = useState<any[]>([]);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<OrderRow | null>(null);
  const [mode, setMode] = useState<'bom' | 'direct'>('direct');
  const [items, setItems] = useState<ItemRow[]>([]);
  const [productId, setProductId] = useState<number | undefined>();
  const [planQty, setPlanQty] = useState<number>(100);
  const [bomVersion, setBomVersion] = useState<string>('');
  const [bomSource, setBomSource] = useState<any[]>([]);
  const [header, setHeader] = useState<{ orderDate: string; expectedDate: string; remark: string }>({
    orderDate: today(),
    expectedDate: '',
    remark: '',
  });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    archiveApi.materialOptions().then(setMaterials).catch(() => undefined);
    archiveApi.productOptions().then(setProducts).catch(() => undefined);
  }, []);

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

  /** 按主产品 BOM 展开：勾选所需子物料，数量按计划产量换算 */
  async function expandBom() {
    if (!productId) {
      message.warning('请先选择主产品');
      return;
    }
    try {
      const detail = await archiveApi.productDetail(productId);
      setBomVersion(detail.bom_version ?? 'V1.0');
      setBomSource(detail.bom ?? []);
      const rows: ItemRow[] = (detail.bom ?? []).map((b: any, i: number) => {
        const m = materials.find((x) => x.id === b.materialId);
        return {
          key: `bom-${i}`,
          materialId: b.materialId,
          code: b.materialCode,
          name: b.materialName,
          spec: b.spec,
          unit: b.unit,
          qty: Number(b.qtyPerUnit) * (planQty || 0),
          price: Number(m?.avg_cost ?? 0),
          stock: m?.current_stock ?? 0,
          need: Number(b.qtyPerUnit) * (planQty || 0),
        };
      });
      setItems(rows);
      message.success(`已展开 BOM，共 ${rows.length} 项物料`);
    } catch (e: any) {
      message.error(e.message);
    }
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
    setBomSource([]);
    setProductId(undefined);
    setPlanQty(100);
    setBomVersion('');
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
            onClick={() =>
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
                list,
              )
            }
          >
            导出
          </Button>
          <PermGate permission="purchase.order.create">
            <DockAction icon={<PlusOutlined />} onClick={openCreate}>新增采购订单</DockAction>
          </PermGate>
        </Space>
      }
    >
      <ResponsiveTable
        rowKey="id"
        size="small"
        loading={loading}
        dataSource={list}
        scroll={{ x: 1400 }}
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
          {
            title: '操作',
            width: 220,
            fixed: 'right',
            render: (_, r) => (
              <Space size={0}>
                {/* 汇总父单没有明细行，不提供打印 */}
                {!r.isParent && <PrintButton docType="purchase_order" id={r.id} />}
                {/* 去入库：仅进行中且有未入库明细的非父单显示（需求 4.1） */}
                {r.canReceive && (
                  <Tooltip title="跳转采购入库并自动带出该订单">
                    <Button
                      type="link"
                      size="small"
                      onClick={() =>
                        navigate('/purchase/receipts', { state: { receiveOrderId: r.id } })
                      }
                    >
                      去入库
                    </Button>
                  </Tooltip>
                )}
                {r.canEdit && (
                  <Button type="link" size="small" onClick={() => openEdit(r)}>
                    编辑
                  </Button>
                )}
                {r.canDelete && (
                  <Popconfirm
                    title="确认删除该采购订单？"
                    description="删除后不可恢复"
                    onConfirm={async () => {
                      try {
                        await purchaseApi.deleteOrder(r.id);
                        message.success('已删除');
                        reload();
                      } catch (e: any) {
                        message.error(e.message);
                      }
                    }}
                  >
                    <Button type="link" size="small" danger>
                      删除
                    </Button>
                  </Popconfirm>
                )}
                {!r.canEdit && !r.canReceive && !r.canDelete && <Typography.Text type="secondary">-</Typography.Text>}
              </Space>
            ),
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
            setBomSource([]);
          }}
          disabled={!!editing}
        >
          <Radio.Button value="bom">按主产品 BOM 采购</Radio.Button>
          <Radio.Button value="direct">直接采购物料</Radio.Button>
        </Radio.Group>

        {mode === 'bom' && (
          <Space style={{ marginTop: 12 }} wrap>
            <Select
              showSearch
              style={{ width: 320 }}
              placeholder="按名称 / 编码 / 拼音首字母检索主产品"
              value={productId}
              onChange={setProductId}
              filterOption={(input, option) => {
                const p = products.find((x) => x.id === option?.value);
                if (!p) return false;
                const kw = input.toLowerCase();
                return [p.name, p.code, p.pinyin, p.spec].filter(Boolean).join(' ').toLowerCase().includes(kw);
              }}
              notFoundContent="未找到匹配主产品"
              options={products.map((p) => ({ value: p.id, label: `${p.code} ${p.name}` }))}
            />
            <InputNumber min={1} value={planQty} onChange={(v) => setPlanQty(Number(v ?? 0))} addonBefore="计划产量" />
            <Button onClick={expandBom}>展开 BOM</Button>
            {bomVersion && <Tag color="blue">BOM {bomVersion}</Tag>}
          </Space>
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
          scroll={{ y: 280 }}
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
