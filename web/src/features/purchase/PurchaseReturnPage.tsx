import { useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  DatePicker,
  Empty,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  message,
} from 'antd';
import { PlusOutlined } from '@ant-design/icons';
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
  FilterBar,
} from '../../components';
import { exportCsv, today } from '../../utils/exportCsv';
import { dayVal } from '../../utils/date';

interface ItemRow {
  key: string;
  materialId?: number;
  name?: string;
  spec?: string;
  unit?: string;
  qty: number;
  price: number;
}

export default function PurchaseReturnPage() {
  const { list, total, loading, params, patchParams, reload } = useList<any>((p) => purchaseApi.returns(p));
  const [receipts, setReceipts] = useState<any[]>([]);
  const [suppliers, setSuppliers] = useState<any[]>([]);
  const [open, setOpen] = useState(false);
  const [receiptId, setReceiptId] = useState<number | undefined>();
  const [returnDate, setReturnDate] = useState(today());
  const [remark, setRemark] = useState('');
  const [items, setItems] = useState<ItemRow[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    purchaseApi
      .receipts({ pageSize: 200 })
      .then((r) => setReceipts(r.list.filter((x: any) => x.status === '有效')))
      .catch(() => undefined);
    archiveApi.supplierOptions().then(setSuppliers).catch(() => undefined);
  }, []);

  async function pickReceipt(id: number) {
    setReceiptId(id);
    try {
      const detail = await purchaseApi.receiptDetail(id);
      setItems(
        detail.items.map((i: any, idx: number) => ({
          key: `r-${idx}`,
          materialId: i.material_id,
          name: i.name,
          spec: i.spec,
          unit: i.unit,
          qty: i.qty,
          price: i.price,
        })),
      );
    } catch (e: any) {
      message.error(e.message);
    }
  }

  async function submit() {
    const lines = items.filter((i) => i.materialId && i.qty > 0);
    if (lines.length === 0) {
      message.warning('请至少录入一条退货明细');
      return;
    }
    setSaving(true);
    try {
      await purchaseApi.createReturn({
        receiptId: receiptId ?? null,
        returnDate,
        remark,
        items: lines.map((i) => ({ materialId: i.materialId, qty: i.qty, price: i.price })),
      });
      message.success('退货单已生成，库存已扣减');
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
      title="采购退货"
      extra={
        <Space>
          <Input.Search
            placeholder="单号 / 供应商"
            allowClear
            style={{ width: 220 }}
            onSearch={(keyword) => patchParams({ keyword })}
          />
          <Button
            onClick={async () => {
              // 需求 8：导出跟随筛选结果
              const res = await purchaseApi.returns({ ...params, page: 1, pageSize: 50000 });
              exportCsv(`采购退货_${today()}`, [
                { title: '退货单号', key: 'return_no' },
                { title: '退货日期', key: 'return_date' },
                { title: '供应商', key: 'supplier_name' },
                { title: '退货内容', key: 'material_names' },
                { title: '金额', key: 'total_amount' },
                { title: '状态', key: 'status' },
              ], res.list ?? []);
            }}
          >
            导出
          </Button>
          <PermGate permission="purchase.return.create">
            <DockAction icon={<PlusOutlined />} onClick={() => {
                setReceiptId(undefined);
                setItems([]);
                setRemark('');
                setReturnDate(today());
                setOpen(true);
              }}>新增退货</DockAction>
          </PermGate>
        </Space>
      }
    >
      {/* 需求 8：日期区间 + 供应商 + 物料包含字筛选 */}
      <FilterBar
        onReset={() =>
          patchParams({ keyword: '', supplierId: '', materialKeyword: '', dateFrom: '', dateTo: '' })
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
        scroll={{ x: 1100 }}
        pagination={{
          current: params.page,
          pageSize: params.pageSize,
          total,
          onChange: (page, pageSize) => patchParams({ page, pageSize }),
        }}
        columns={[
          { title: '退货单号', dataIndex: 'return_no', width: 160, render: (v) => <CopyableCode value={v} /> },
          { title: '退货日期', dataIndex: 'return_date', width: 110 },
          { title: '供应商', dataIndex: 'supplier_name', width: 200 },
          { title: '退货内容', dataIndex: 'material_names', ellipsis: true },
          { title: '金额', dataIndex: 'total_amount', width: 110, render: (v) => <PriceText value={v} /> },
          { title: '操作人', dataIndex: 'operator_name', width: 110 },
          { title: '状态', dataIndex: 'status', width: 90, render: (v) => <StatusTag status={v} /> },
          {
            title: '操作',
            width: 160,
            render: (_, r: any) => (
              <Space size={0}>
                <PrintButton docType="purchase_return" id={r.id} />
                {r.canUndo ? (
                  <Popconfirm
                    title="确认撤销该退货单？"
                    onConfirm={async () => {
                      try {
                        await purchaseApi.undoReturn(r.id);
                        message.success('已撤销');
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

      <Modal open={open} title="新增采购退货" onCancel={() => setOpen(false)} onOk={submit} confirmLoading={saving} width={860} destroyOnClose>
        <Alert type="info" showIcon style={{ marginBottom: 12 }} message="退货需关联原入库单，提交后扣减物料库存并冲减应付账款" />
        <Space wrap style={{ marginBottom: 12 }}>
          <Select
            style={{ width: 380 }}
            placeholder="选择原入库单"
            showSearch
            optionFilterProp="label"
            value={receiptId}
            onChange={(v) => v && pickReceipt(v)}
            options={receipts.map((r: any) => ({
              value: r.id,
              label: `${r.receipt_date} · ${r.purchaseContent ?? r.supplier_name ?? ''} · ${r.supplier_name ?? ''}`,
            }))}
          />
          <DatePicker value={dayVal(returnDate)} onChange={(d) => setReturnDate(d ? d.format('YYYY-MM-DD') : today())} />
        </Space>

        <ResponsiveTable
          size="small"
          rowKey="key"
          dataSource={items}
          pagination={false}
          scroll={{ y: 260 }}
          locale={{ emptyText: <Empty description="请先选择原入库单" /> }}
          columns={[
            { title: '物料名称', dataIndex: 'name' },
            { title: '规格', dataIndex: 'spec', width: 140 },
            { title: '单位', dataIndex: 'unit', width: 70 },
            {
              title: '退货数量',
              dataIndex: 'qty',
              width: 130,
              render: (v, r) => (
                <InputNumber
                  min={0}
                  value={v}
                  style={{ width: '100%' }}
                  onChange={(nv) => setItems((prev) => prev.map((x) => (x.key === r.key ? { ...x, qty: Number(nv ?? 0) } : x)))}
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
                  onChange={(nv) => setItems((prev) => prev.map((x) => (x.key === r.key ? { ...x, price: Number(nv ?? 0) } : x)))}
                />
              ),
            },
            {
              title: '操作',
              width: 70,
              render: (_, r) => (
                <Button type="link" size="small" danger onClick={() => setItems((prev) => prev.filter((x) => x.key !== r.key))}>
                  移除
                </Button>
              ),
            },
          ]}
        />
        <Input.TextArea rows={2} style={{ marginTop: 12 }} placeholder="备注" value={remark} onChange={(e) => setRemark(e.target.value)} />
      </Modal>
    </Card>
  );
}
