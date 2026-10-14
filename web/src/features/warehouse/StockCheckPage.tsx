import { useEffect, useState } from 'react';
import { Alert, Button, Card, DatePicker, Input, InputNumber, Select, Space, Table, Tag, message } from 'antd';
import { CheckCircleOutlined, EyeOutlined, PlusOutlined, RollbackOutlined } from '@ant-design/icons';
import { archiveApi, warehouseApi } from '../../api';
import { useList } from '../../hooks/useList';
import {
  PermGate,
  PriceText,
  StatusTag,
  ResponsiveTable,
  DockAction,
  CopyableCode,
  FilterBar,
  Modal,
  TopActionBar,
  RowActionButton,
  useRowSelect,
} from '../../components';
import { exportCsv, today } from '../../utils/exportCsv';
import { dayVal } from '../../utils/date';
import type { ItemType } from '@shared/enums';

interface Row { key: string; itemType: ItemType; itemId?: number; name?: string; bookQty: number; actualQty: number }

export default function StockCheckPage() {
  const { list, total, loading, params, patchParams, reload } = useList<any>((p) => warehouseApi.checks(p));
  const [options, setOptions] = useState<any[]>([]);
  const [open, setOpen] = useState(false);
  const [checkDate, setCheckDate] = useState(today());
  const [remark, setRemark] = useState('');
  const [rows, setRows] = useState<Row[]>([]);
  const [detail, setDetail] = useState<any>(null);
  /** 顶部操作区：先选中一行，再点按钮（与生产工单页同一套交互） */
  const { selectedId, clearSelection, rowSelection, onRowClick } = useRowSelect();
  const selected = list.find((r) => r.id === selectedId) ?? null;

  useEffect(() => {
    Promise.all([archiveApi.materialOptions(), archiveApi.productOptions()])
      .then(([m, p]) =>
        setOptions([
          ...m.map((x: any) => ({ value: `material-${x.id}`, itemType: 'material' as ItemType, itemId: x.id, label: `[物料] ${x.code} ${x.name}`, stock: x.current_stock })),
          ...p.map((x: any) => ({ value: `product-${x.id}`, itemType: 'product' as ItemType, itemId: x.id, label: `[成品] ${x.code} ${x.name}`, stock: x.current_stock })),
        ]),
      )
      .catch(() => undefined);
  }, []);

  async function submit() {
    const lines = rows.filter((r) => r.itemId);
    if (lines.length === 0) return message.warning('请至少录入一条实盘数据');
    try {
      await warehouseApi.createCheck({
        checkDate,
        remark,
        items: lines.map((r) => ({ itemType: r.itemType, itemId: r.itemId, actualQty: r.actualQty })),
      });
      message.success('盘点单已录入，等待管理员审核；盘点期间该对象出入库已锁定');
      setOpen(false);
      reload();
    } catch (e: any) { message.error(e.message); }
  }

  return (
    <Card
      title="库存盘点"
      extra={
        <Space>
          <Input.Search placeholder="盘点单号" allowClear style={{ width: 190 }} onSearch={(keyword) => patchParams({ keyword })} />
          {/* 需求 24：导出跟随筛选结果 */}
          <Button onClick={async () => {
            const res = await warehouseApi.checks({ ...params, page: 1, pageSize: 50000 });
            exportCsv(`库存盘点_${today()}`, [
              { title: '盘点单号', key: 'check_no' },
              { title: '盘点日期', key: 'check_date' },
              { title: '明细数', key: 'item_count' },
              { title: '录入人', key: 'operator_name' },
              { title: '审核人', key: 'auditor_name' },
              { title: '状态', key: 'status' },
            ], res.list ?? []);
          }}>导出</Button>
          <PermGate permission="warehouse.check.create">
            <DockAction icon={<PlusOutlined />} onClick={() => { setRows([]); setCheckDate(today()); setRemark(''); setOpen(true); }}>录入实盘数据</DockAction>
          </PermGate>
        </Space>
      }
    >
      <Alert type="warning" showIcon style={{ marginBottom: 12 }}
        message="盘点单录入后即进入待审核状态，被盘点对象的出入库将被锁定；管理员审核后系统按差异自动生成调整流水" />

      {/* 需求 24：日期区间 + 状态 + 盘点对象包含字筛选 */}
      <FilterBar
        onReset={() => patchParams({ status: '', itemKeyword: '', dateFrom: '', dateTo: '' })}
        extra={
          /* 选中行操作组：先在列表中点行选中，再点这里执行。
             原「查看明细 / 审核 / 撤销」在每行末尾重复展示，几十条数据时很杂乱，故集中到顶部。
             是否可审核 / 可撤销由列表接口返回的 canAudit / canUndo 决定（后端算好，含权限）。 */
          <TopActionBar>
            <RowActionButton
              text="查看明细"
              icon={<EyeOutlined />}
              selected={selected}
              tipName="盘点单"
              onAction={async (r) => {
                try {
                  setDetail(await warehouseApi.checkDetail(r.id));
                } catch (e: any) {
                  message.error(e.message);
                }
              }}
            />
            <RowActionButton
              text="审核"
              icon={<CheckCircleOutlined />}
              selected={selected}
              tipName="盘点单"
              disabledReason={(r) => (r.canAudit ? null : '该盘点单当前不可审核')}
              confirm={(r) => ({
                title: '确认审核该盘点单？',
                content: `盘点单「${r.check_no}」审核后将按差异自动生成库存调整流水。`,
              })}
              onAction={async (r) => {
                try {
                  await warehouseApi.auditCheck(r.id);
                  message.success('已审核，调整流水已生成');
                  clearSelection();
                  reload();
                } catch (e: any) {
                  message.error(e.message);
                }
              }}
            />
            <RowActionButton
              text="撤销"
              icon={<RollbackOutlined />}
              danger
              selected={selected}
              tipName="盘点单"
              disabledReason={(r) => (r.canUndo ? null : '该盘点单当前不可撤销')}
              confirm={(r) => ({
                title: '确认撤销该盘点单？',
                content: `盘点单「${r.check_no}」撤销后不可恢复。`,
              })}
              onAction={async (r) => {
                try {
                  await warehouseApi.undoCheck(r.id);
                  message.success('已撤销');
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
          style={{ width: 130 }}
          placeholder="状态"
          value={params.status || undefined}
          onChange={(v) => patchParams({ status: v ?? '' })}
          options={[
            { value: '待审核', label: '待审核' },
            { value: '已审核', label: '已审核' },
            { value: '已撤销', label: '已撤销' },
          ]}
        />
        <Input
          allowClear
          style={{ width: 190 }}
          placeholder="盘点对象名称 / 编码包含"
          value={params.itemKeyword ?? ''}
          onChange={(e) => patchParams({ itemKeyword: e.target.value })}
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
        scroll={{ x: 1100 }}
        pagination={{ current: params.page, pageSize: params.pageSize, total, onChange: (page, pageSize) => patchParams({ page, pageSize }) }}
        columns={[
          { title: '盘点单号', dataIndex: 'check_no', width: 160, render: (v) => <CopyableCode value={v} /> },
          { title: '盘点日期', dataIndex: 'check_date', width: 110 },
          { title: '明细数', dataIndex: 'item_count', width: 90, className: 'mono' },
          { title: '录入人', dataIndex: 'operator_name', width: 110 },
          { title: '审核人', dataIndex: 'auditor_name', width: 110, render: (v) => v || '-' },
          {
            title: '状态',
            dataIndex: 'status',
            width: 100,
            render: (v) => <Tag color={v === '待审核' ? 'orange' : v === '已审核' ? 'green' : 'default'}>{v}</Tag>,
          },
        ]}
      />

      <Modal open={open} title="录入实盘数据" onCancel={() => setOpen(false)} onOk={submit} width={900} destroyOnClose>
        <Space wrap style={{ marginBottom: 12 }}>
          <DatePicker value={dayVal(checkDate)} onChange={(d) => setCheckDate(d ? d.format('YYYY-MM-DD') : today())} />
          <Select
            style={{ width: 340 }}
            placeholder="选择物料 / 成品加入盘点"
            value={undefined}
            showSearch
            optionFilterProp="label"
            options={options.map((o) => ({ value: o.value, label: o.label }))}
            onSelect={(v?: string) => {
              const key = String(v ?? '');
              if (!key) return;
              const opt = options.find((o) => o.value === key);
              if (!opt) return;
              if (rows.some((r) => `${r.itemType}-${r.itemId}` === key)) return message.warning('该对象已在盘点清单中');
              const qty = Number(opt.stock ?? 0);
              setRows((prev) => [...prev, { key, itemType: opt.itemType, itemId: opt.itemId, name: opt.label, bookQty: qty, actualQty: qty }]);
            }}
          />
        </Space>
        <ResponsiveTable size="small" rowKey="key" dataSource={rows} pagination={false} scroll={{ y: 280 }} columns={[
          { title: '库存对象', dataIndex: 'name' },
          { title: '账面数量', dataIndex: 'bookQty', width: 110, className: 'mono' },
          { title: '实盘数量', dataIndex: 'actualQty', width: 140, render: (v, r) => (
            <InputNumber min={0} value={v} style={{ width: '100%' }} onChange={(nv) => setRows((prev) => prev.map((x) => (x.key === r.key ? { ...x, actualQty: Number(nv ?? 0) } : x)))} />
          ) },
          { title: '差异', width: 100, className: 'mono', render: (_v, r) => {
            const d = Number(r.actualQty) - Number(r.bookQty);
            return <span style={{ color: d > 0 ? '#3B6D11' : d < 0 ? '#cf1322' : undefined }}>{d > 0 ? `+${d}` : d}</span>;
          } },
          { title: '操作', width: 70, render: (_, r) => (
            <Button type="link" size="small" danger onClick={() => setRows((prev) => prev.filter((x) => x.key !== r.key))}>移除</Button>
          ) },
        ]} />
        <Input.TextArea rows={2} style={{ marginTop: 12 }} placeholder="备注" value={remark} onChange={(e) => setRemark(e.target.value)} />
      </Modal>

      <Modal open={!!detail} title="盘点明细" onCancel={() => setDetail(null)} footer={null} width={800} destroyOnClose>
        <ResponsiveTable size="small" rowKey="id" dataSource={detail?.items ?? []} pagination={false} columns={[
          { title: '编码', dataIndex: 'item_code', width: 120 },
          { title: '名称', dataIndex: 'item_name' },
          { title: '类型', dataIndex: 'item_type', width: 80, render: (v) => (v === 'material' ? '物料' : '成品') },
          { title: '账面数量', dataIndex: 'book_qty', width: 100, className: 'mono' },
          { title: '实盘数量', dataIndex: 'actual_qty', width: 100, className: 'mono' },
          { title: '差异', dataIndex: 'diff_qty', width: 100, className: 'mono', render: (v) => (
            <span style={{ color: Number(v) > 0 ? '#3B6D11' : Number(v) < 0 ? '#cf1322' : undefined }}>{v}</span>
          ) },
        ]} />
      </Modal>
    </Card>
  );
}
