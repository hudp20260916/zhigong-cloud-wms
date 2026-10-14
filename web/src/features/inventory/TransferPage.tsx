import { useEffect, useMemo, useState } from 'react';
import {
  Button,
  Card,
  DatePicker,
  Empty,
  Input,
  InputNumber,
  Select,
  Space,
  Tag,
  Typography,
  message,
} from 'antd';
import { SwapOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { inventoryApi, archiveApi } from '../../api';
import {
  ResponsiveTable,
  TopActionBar,
  RowActionButton,
  PermGate,
  useRowSelect,
  Modal as DragModal,
} from '../../components';
import { clearWarehouseOptionsCache, useWarehouseOptions } from '../../components';
import { useList } from '../../hooks/useList';
import type { ItemType } from '@shared/enums';

/**
 * 仓库调拨。
 *
 * 库存口径（与服务端一致）：
 *  - 调出仓 −数量、调入仓 +数量，**总库存不变**；
 *  - 两仓各写一条流水（调拨出库 / 调拨入库），撤销时原路退回；
 *  - 按「调出仓」的存量校验，调出仓不够就整单拦下，不会把别的仓的货挪过来。
 */

interface TransferLine {
  key: string;
  itemType: ItemType;
  itemId: number | null;
  batchNo: string;
  qty: number;
  remark: string;
}

const ITEM_LABEL: Record<ItemType, string> = { material: '物料', product: '成品' };

export default function TransferPage() {
  const { list, total, loading, params, patchParams, reload } = useList<any>(
    (p) => inventoryApi.transfers(p),
    {},
  );
  const { selectedId, clearSelection, rowSelection, onRowClick } = useRowSelect();
  const selected = list.find((r) => r.id === selectedId) ?? null;

  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [lines, setLines] = useState<TransferLine[]>([emptyLine()]);
  const [fromWh, setFromWh] = useState<number | null>(null);
  const [toWh, setToWh] = useState<number | null>(null);
  const [date, setDate] = useState<any>(dayjs());
  const [remark, setRemark] = useState('');
  const [reloadFlag, setReloadFlag] = useState(0);

  const { options: matWhs } = useWarehouseOptions('material');
  const { options: prodWhs } = useWarehouseOptions('product');
  const [matOpts, setMatOpts] = useState<any[]>([]);
  const [prodOpts, setProdOpts] = useState<any[]>([]);

  useEffect(() => {
    // 明细里的对象下拉：物料与成品各拉一份全量（档案量级在千级以内，一次拉够）
    Promise.all([archiveApi.materials({ pageSize: 5000 }), archiveApi.products({ pageSize: 5000 })])
      .then(([m, p]: any) => {
        setMatOpts(m?.list ?? []);
        setProdOpts(p?.list ?? []);
      })
      .catch(() => {
        setMatOpts([]);
        setProdOpts([]);
      });
  }, []);

  // 全仓列表（不分品类）用于列表页筛选与调拨弹窗的「调出/调入」两个下拉
  const allWhs = useMemo(() => {
    const map = new Map<number, any>();
    for (const w of [...matWhs, ...prodWhs]) if (!map.has(w.id)) map.set(w.id, w);
    return [...map.values()].filter((w) => w.status === '启用');
  }, [matWhs, prodWhs, reloadFlag]);

  function resetForm() {
    setLines([emptyLine()]);
    setFromWh(null);
    setToWh(null);
    setDate(dayjs());
    setRemark('');
  }

  function updateLine(key: string, patch: Partial<TransferLine>) {
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }

  /** 明细行的对象下拉：按该行的品类给对应档案 */
  function itemOptionsOf(itemType: ItemType) {
    return (itemType === 'material' ? matOpts : prodOpts).map((r: any) => ({
      value: r.id,
      label: `${r.code} ${r.name}`,
    }));
  }

  async function submit() {
    if (!fromWh) return message.warning('请选择调出仓库');
    if (!toWh) return message.warning('请选择调入仓库');
    if (fromWh === toWh) return message.warning('调出仓库与调入仓库不能相同');

    const valid = lines.filter((l) => l.itemId && Number(l.qty) > 0);
    if (valid.length === 0) return message.warning('请至少添加一条有效的调拨明细（对象 + 数量）');
    const bad = lines.find((l) => l.itemId && !(Number(l.qty) > 0));
    if (bad) return message.warning('调拨数量必须大于 0');

    setSubmitting(true);
    try {
      await inventoryApi.createTransfer({
        fromWarehouseId: fromWh,
        toWarehouseId: toWh,
        transferDate: (date ?? dayjs()).format('YYYY-MM-DD'),
        remark,
        items: valid.map((l) => ({
          itemType: l.itemType,
          itemId: l.itemId,
          batchNo: l.batchNo,
          qty: Number(l.qty),
          remark: l.remark,
        })),
      });
      message.success('调拨单已保存，双方仓库库存已同步调整');
      setOpen(false);
      resetForm();
      reload();
    } catch (e: any) {
      message.error(e?.message ?? '保存失败，请重试');
    } finally {
      setSubmitting(false);
    }
  }

  const columns = [
    { title: '调拨单号', dataIndex: 'transfer_no', width: 180 },
    { title: '调拨日期', dataIndex: 'transfer_date', width: 110 },
    { title: '调出仓', dataIndex: 'from_warehouse_name', width: 130 },
    { title: '调入仓', dataIndex: 'to_warehouse_name', width: 130 },
    { title: '明细数', dataIndex: 'item_count', width: 90, className: 'mono' },
    { title: '合计数量', dataIndex: 'total_qty', width: 100, className: 'mono' },
    { title: '经办人', dataIndex: 'operator_name', width: 110 },
    {
      title: '状态',
      dataIndex: 'status',
      width: 90,
      render: (v: string) => <Tag color={v === '有效' ? 'green' : 'default'}>{v}</Tag>,
    },
  ];

  return (
    <Card
      title="仓库调拨"
      extra={
        <Space>
          <Input.Search
            placeholder="单号 / 备注"
            allowClear
            style={{ width: 200 }}
            onSearch={(keyword) => patchParams({ keyword })}
          />
        </Space>
      }
    >
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
        <TopActionBar>
          {/* 新增不依赖选中行，用普通按钮 + 权限门控 */}
          <PermGate permission="stock.transfer.create">
            <Button
              type="primary"
              icon={<SwapOutlined />}
              onClick={() => {
                resetForm();
                clearWarehouseOptionsCache();
                setReloadFlag((n) => n + 1);
                setOpen(true);
              }}
            >
              新增调拨
            </Button>
          </PermGate>
          <RowActionButton
            text="撤销"
            danger
            permission="stock.transfer.undo"
            selected={selected}
            tipName="调拨单"
            disabledReason={(row) => (row.status === '有效' ? null : '该调拨单已撤销')}
            confirm={() => ({
              title: '确认撤销调拨单',
              content: '撤销后调出仓与调入仓的库存将原路退回，且不可恢复。',
            })}
            onAction={async (row) => {
              try {
                await inventoryApi.undoTransfer(row.id);
                message.success('已撤销，库存已原路退回');
                clearSelection();
                reload();
              } catch (e: any) {
                message.error(e?.message ?? '撤销失败');
              }
            }}
          />
        </TopActionBar>
      </div>

      <ResponsiveTable
        rowKey="id"
        size="small"
        loading={loading}
        dataSource={list}
        columns={columns as any}
        rowSelection={rowSelection}
        onRowClick={onRowClick}
        selectedRowKeys={selectedId === null ? [] : [selectedId]}
        scroll={{ x: 1100 }}
        pagination={{
          current: params.page,
          pageSize: params.pageSize,
          total,
          onChange: (page, pageSize) => patchParams({ page, pageSize }),
          showSizeChanger: true,
        }}
      />

      <DragModal
        open={open}
        title="新增调拨单"
        width={860}
        onCancel={() => setOpen(false)}
        onOk={submit}
        confirmLoading={submitting}
        okText="保存"
        cancelText="取消"
        destroyOnClose={false}
        forceRender
      >
        <Space size={16} wrap style={{ marginBottom: 12 }}>
          <div>
            <div style={{ marginBottom: 4 }}>调出仓库</div>
            <Select
              style={{ width: 200 }}
              value={fromWh ?? undefined}
              onChange={setFromWh}
              placeholder="请选择"
              options={allWhs.map((w) => ({ value: w.id, label: w.name }))}
            />
          </div>
          <SwapOutlined style={{ marginTop: 26, color: '#8c8c8c' }} />
          <div>
            <div style={{ marginBottom: 4 }}>调入仓库</div>
            <Select
              style={{ width: 200 }}
              value={toWh ?? undefined}
              onChange={setToWh}
              placeholder="请选择"
              options={allWhs.map((w) => ({ value: w.id, label: w.name }))}
            />
          </div>
          <div>
            <div style={{ marginBottom: 4 }}>调拨日期</div>
            <DatePicker value={date} onChange={setDate} style={{ width: 160 }} />
          </div>
        </Space>

        {lines.length === 0 ? (
          <Empty description="暂无调拨明细" />
        ) : (
          <div>
            {lines.map((l, idx) => (
              <Space key={l.key} size={8} wrap style={{ marginBottom: 8, alignItems: 'flex-start' }}>
                <span style={{ width: 24, lineHeight: '32px', color: '#8c8c8c' }}>{idx + 1}</span>
                <Select
                  style={{ width: 90 }}
                  value={l.itemType}
                  onChange={(v) => updateLine(l.key, { itemType: v, itemId: null })}
                  options={[
                    { value: 'material', label: '物料' },
                    { value: 'product', label: '成品' },
                  ]}
                />
                <Select
                  style={{ width: 240 }}
                  showSearch
                  optionFilterProp="label"
                  value={l.itemId ?? undefined}
                  onChange={(v) => updateLine(l.key, { itemId: v })}
                  placeholder={`选择${ITEM_LABEL[l.itemType]}`}
                  options={itemOptionsOf(l.itemType)}
                />
                <Input
                  style={{ width: 130 }}
                  value={l.batchNo}
                  onChange={(e) => updateLine(l.key, { batchNo: e.target.value })}
                  placeholder="批次号（选填）"
                  maxLength={50}
                />
                <InputNumber
                  style={{ width: 110 }}
                  min={0}
                  value={l.qty}
                  onChange={(v) => updateLine(l.key, { qty: Number(v ?? 0) })}
                  placeholder="数量"
                />
                <Input
                  style={{ width: 160 }}
                  value={l.remark}
                  onChange={(e) => updateLine(l.key, { remark: e.target.value })}
                  placeholder="备注（选填）"
                  maxLength={200}
                />
                <a
                  onClick={() => setLines((prev) => (prev.length === 1 ? prev : prev.filter((x) => x.key !== l.key)))}
                  style={{ lineHeight: '32px' }}
                >
                  删除
                </a>
              </Space>
            ))}
          </div>
        )}

        <Space style={{ marginTop: 8 }}>
          <a
            onClick={() =>
              setLines((prev) => [...prev, { ...emptyLine(), itemType: prev[prev.length - 1]?.itemType ?? 'material' }])
            }
          >
            + 添加明细
          </a>
        </Space>

        <div style={{ marginTop: 12 }}>
          <div style={{ marginBottom: 4 }}>备注</div>
          <Input.TextArea rows={2} maxLength={200} value={remark} onChange={(e) => setRemark(e.target.value)} />
        </div>

        <Typography.Text type="secondary" style={{ display: 'block', marginTop: 8, fontSize: 12 }}>
          保存后：调出仓库存减少、调入仓库存增加，总库存不变；两侧各记一条流水，可在流水台账里按仓查询。
        </Typography.Text>
      </DragModal>
    </Card>
  );
}

let seq = 0;
function emptyLine(): TransferLine {
  seq += 1;
  return { key: `L${seq}`, itemType: 'material', itemId: null, batchNo: '', qty: 0, remark: '' };
}
