import { useEffect, useState } from 'react';
import { DatePicker, Descriptions, Select, Space, Table, Tag, message } from 'antd';
import { inventoryApi } from '../../api';
import { useAuthStore } from '../../stores/auth';
import { exportCsv, today } from '../../utils/exportCsv';
import type { ItemType } from '@shared/enums';
import { ResponsiveTable, Modal } from '../../components';

interface Props {
  open: boolean;
  onClose: () => void;
  itemType: ItemType;
  itemId: number;
  itemName: string;
}

/**
 * 出入库详情弹窗。
 * 净额口径由服务端统一给出（撤销记录不计入），这里只负责展示与导出。
 */
export default function StockDetailModal({ open, onClose, itemType, itemId, itemName }: Props) {
  const [data, setData] = useState<any>(null);
  const [direction, setDirection] = useState<string>('');
  const [range, setRange] = useState<any>(null);
  // 需求 18/19：出入库详情按业务类型筛选
  const [bizType, setBizType] = useState<string>('');
  const has = useAuthStore((s) => s.has);
  const canViewPrice = has('price.view');
  const canExport = has('export.data');

  const load = async () => {
    try {
      const res = await inventoryApi.detail({
        itemType,
        itemId,
        direction,
        bizType,
        from: range?.[0]?.format('YYYY-MM-DD'),
        to: range?.[1]?.format('YYYY-MM-DD'),
      });
      setData(res);
    } catch (e: any) {
      message.error(e.message);
    }
  };

  useEffect(() => {
    if (open) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, itemId, direction, bizType, range]);

  function doExport() {
    if (!canExport) {
      message.warning('无数据导出权限');
      return;
    }
    const rows = data?.list ?? [];
    // 无价格权限时导出文件直接剔除单价与金额列（需求 5）
    const columns: any[] = [
      { title: '业务类型', key: 'biz_type' },
      { title: '方向', key: 'direction', render: (r: any) => (r.direction === 'in' ? '入库' : '出库') },
      { title: '数量', key: 'qty' },
      { title: '结存', key: 'balance_after' },
      { title: '操作人', key: 'operator_name' },
      { title: '时间', key: 'created_at', render: (r: any) => String(r.created_at).slice(0, 19).replace('T', ' ') },
    ];
    if (canViewPrice) {
      columns.splice(4, 0, { title: '单价', key: 'unit_price' }, { title: '金额', key: 'amount' });
    }
    exportCsv(`${itemName}_出入库详情_${today()}`, columns, rows);
  }

  return (
    <Modal
      open={open}
      title={`${itemName} · 出入库详情`}
      onCancel={onClose}
      footer={null}
      width={960}
      destroyOnClose
    >
      <Space style={{ marginBottom: 12 }} wrap>
        <Select
          style={{ width: 130 }}
          value={direction}
          onChange={setDirection}
          options={[
            { value: '', label: '全部方向' },
            { value: 'in', label: '仅入库' },
            { value: 'out', label: '仅出库' },
          ]}
        />
        <DatePicker.RangePicker value={range} onChange={(v) => setRange(v)} />
        {/* 需求 18/19：业务类型筛选 */}
        <Select
          style={{ width: 170 }}
          placeholder="业务类型"
          value={bizType}
          onChange={setBizType}
          options={[
            { value: '', label: '全部业务类型' },
            { value: '采购入库', label: '采购入库' },
            { value: '采购退货', label: '采购退货' },
            { value: '生产领料', label: '生产领料' },
            { value: '成品入库', label: '成品入库' },
            { value: '销售出库', label: '销售出库' },
            { value: '销售退货', label: '销售退货' },
            { value: '期初库存', label: '期初库存' },
            { value: '物料销售', label: '物料销售' },
            { value: '不良品出库', label: '不良品出库' },
            { value: '库存盘点', label: '库存盘点' },
          ]}
        />
        <button
          onClick={doExport}
          style={{
            border: '1px solid var(--border-2, #d9d9d9)',
            background: 'var(--bg-container, #fff)',
            borderRadius: 6,
            padding: '4px 12px',
            cursor: 'pointer',
          }}
        >
          导出明细
        </button>
      </Space>

      <Descriptions size="small" bordered column={{ xs: 1, sm: 2, lg: 4 }} style={{ marginBottom: 12 }}>
        <Descriptions.Item label="期初库存">{data?.summary?.initialQty ?? '-'}</Descriptions.Item>
        <Descriptions.Item label="入库合计">{data?.summary?.inQty ?? '-'}</Descriptions.Item>
        <Descriptions.Item label="出库合计">{data?.summary?.outQty ?? '-'}</Descriptions.Item>
        <Descriptions.Item label="当前结存">
          <b>{data?.summary?.balanceQty ?? '-'}</b>
        </Descriptions.Item>
      </Descriptions>

      <ResponsiveTable
        size="small"
        rowKey="id"
        dataSource={data?.list ?? []}
        scroll={{ y: 340 }}
        pagination={false}
        locale={{ emptyText: '暂无出入库记录' }}
        rowClassName={(r: any) => (r.status === '已撤销' || r.is_reversal === 1 ? 'voided-row' : '')}
        columns={[
          {
            title: '业务类型',
            dataIndex: 'biz_type',
            width: 110,
            render: (v, r: any) => (
              <span style={{ textDecoration: r.status === '已撤销' ? 'line-through' : undefined }}>{v}</span>
            ),
          },
          {
            title: '方向',
            dataIndex: 'direction',
            width: 80,
            render: (v) => <Tag color={v === 'in' ? 'red' : 'green'}>{v === 'in' ? '入库' : '出库'}</Tag>,
          },
          { title: '数量', dataIndex: 'qty', width: 90, className: 'mono' },
          { title: '结存', dataIndex: 'balance_after', width: 90, className: 'mono' },
          ...(canViewPrice
            ? [
                { title: '单价', dataIndex: 'unit_price', width: 90, className: 'mono' },
                { title: '金额', dataIndex: 'amount', width: 100, className: 'mono' },
              ]
            : [
                { title: '单价', width: 90, render: () => '***' },
                { title: '金额', width: 100, render: () => '***' },
              ]),
          { title: '操作人', dataIndex: 'operator_name', width: 110 },
          {
            title: '时间',
            dataIndex: 'created_at',
            width: 160,
            render: (v) => String(v).slice(0, 19).replace('T', ' '),
          },
          {
            title: '状态',
            dataIndex: 'status',
            width: 90,
            render: (v, r: any) => (r.is_reversal === 1 ? <Tag>撤销对冲</Tag> : <Tag color="blue">{v}</Tag>),
          },
        ]}
      />
    </Modal>
  );
}
