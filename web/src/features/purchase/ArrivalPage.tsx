import { useEffect, useMemo, useState } from 'react';
import { Button, Card, DatePicker, Input, Select, Space, Tag, Tooltip } from 'antd';
import { archiveApi, purchaseApi } from '../../api';
import { useList } from '../../hooks/useList';
import {
  PriceText,
  ResponsiveTable,
  CopyableCode,
  FilterBar,
  ColumnSettings,
  columnKeyOf,
  visibleColumnsOf,
  useColumnHidden,
} from '../../components';
import { exportCsv, today } from '../../utils/exportCsv';
import { dayVal } from '../../utils/date';

/**
 * 到货核对的全量列定义。
 *
 * 提成模块级常量是为了让「列显示设置」能拿到完整清单（面板里的顺序 = 这里的顺序），
 * 表格实际渲染的是 `visibleColumnsOf(ARRIVAL_COLUMNS, hiddenKeys)` 过滤后的结果。
 */
const ARRIVAL_COLUMNS: any[] = [
  { title: '订单编号', dataIndex: 'order_no', width: 150, render: (v: any) => <CopyableCode value={v} /> },
  { title: '父订单号', dataIndex: 'parent_order_no', width: 140, render: (v: any) => <CopyableCode value={v} /> },
  {
    title: '采购内容',
    dataIndex: 'purchaseContent',
    width: 180,
    ellipsis: true,
    render: (v: any) => (
      <Tooltip title={v || '-'}>
        <span>{v || '-'}</span>
      </Tooltip>
    ),
  },
  { title: '供应商', dataIndex: 'supplier_name', width: 190, render: (v: any) => v || '待分配' },
  { title: '物料编码', dataIndex: 'material_code', width: 110 },
  { title: '物料名称', dataIndex: 'material_name', width: 160 },
  { title: '规格', dataIndex: 'spec', width: 130 },
  { title: '下单量', dataIndex: 'order_qty', width: 90, className: 'mono' },
  { title: '已入库', dataIndex: 'received_qty', width: 90, className: 'mono' },
  {
    title: '未入库',
    dataIndex: 'pendingQty',
    width: 90,
    className: 'mono',
    render: (v: any) => <span style={{ color: Number(v) > 0 ? '#cf1322' : undefined }}>{v}</span>,
  },
  { title: '单价', dataIndex: 'price', width: 90, render: (v: any) => <PriceText value={v} /> },
  { title: '下单日期', dataIndex: 'order_date', width: 110 },
  { title: '预计到货', dataIndex: 'expected_date', width: 110, render: (v: any) => v || '-' },
  {
    title: '到货状态',
    dataIndex: 'arrivalStatus',
    width: 100,
    render: (v: any) => (
      <Tag color={v === '已到齐' ? 'success' : v === '部分到货' ? 'warning' : 'default'}>{v}</Tag>
    ),
  },
];

const ALL_KEYS = ARRIVAL_COLUMNS.map((c, i) => columnKeyOf(c, i));

/** 到货核对：采购内容列 + 主产品/物料名称搜索 + 导出同步包含采购内容（需求 3.4.5） */
export default function ArrivalPage() {
  const { list, total, loading, params, patchParams } = useList<any>((p) => purchaseApi.arrivals(p));
  const [suppliers, setSuppliers] = useState<any[]>([]);

  // 列显示设置：本地持久化，刷新后仍生效；订单编号被锁定为固定列，保证不会整表空白
  const { hiddenKeys, setHiddenKeys } = useColumnHidden({
    storageKey: 'zgwms.arrival.columns',
    validKeys: ALL_KEYS,
  });
  const columns = useMemo(() => visibleColumnsOf(ARRIVAL_COLUMNS, hiddenKeys), [hiddenKeys]);
  // 隐藏列后横向滚动宽度跟着收，避免留一大段空白
  const scrollX = useMemo(
    () => columns.reduce((s, c) => s + (Number(c.width) || 120), 0),
    [columns],
  );

  useEffect(() => {
    archiveApi.supplierOptions().then(setSuppliers).catch(() => undefined);
  }, []);

  return (
    <Card
      title="采购订单到货核对"
      extra={
        <Space>
          <Input.Search
            placeholder="主产品名称 / 物料名称 / 订单号"
            allowClear
            style={{ width: 260 }}
            onSearch={(keyword) => patchParams({ keyword })}
          />
          <Button
            onClick={async () => {
              // 需求 7：导出跟随筛选结果
              const res = await purchaseApi.arrivals({ ...params, page: 1, pageSize: 50000 });
              exportCsv(
                `到货核对_${today()}`,
                [
                  { title: '订单编号', key: 'order_no' },
                  { title: '父订单号', key: 'parent_order_no' },
                  { title: '采购内容', key: 'purchaseContent' },
                  { title: '供应商', key: 'supplier_name' },
                  { title: '物料编码', key: 'material_code' },
                  { title: '物料名称', key: 'material_name' },
                  { title: '规格', key: 'spec' },
                  { title: '下单量', key: 'order_qty' },
                  { title: '已入库', key: 'received_qty' },
                  { title: '未入库', key: 'pendingQty' },
                  { title: '单价', key: 'price' },
                  { title: '到货状态', key: 'arrivalStatus' },
                ],
                res.list ?? [],
              );
            }}
          >
            导出
          </Button>
          {/* 列显示设置：勾选哪些列在表格里显示，关闭浮层立即生效 */}
          <ColumnSettings
            columns={ARRIVAL_COLUMNS}
            hiddenKeys={hiddenKeys}
            onChange={setHiddenKeys}
            lockedKeys={['order_no']}
          />
        </Space>
      }
    >
      {/* 需求 7：日期区间（下单日期）+ 供应商 + 物料包含字筛选 */}
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
        rowKey="item_id"
        size="small"
        loading={loading}
        dataSource={list}
        scroll={{ x: scrollX }}
        pagination={{
          current: params.page,
          pageSize: params.pageSize,
          total,
          onChange: (page, pageSize) => patchParams({ page, pageSize }),
          showSizeChanger: true,
        }}
        columns={columns}
      />
    </Card>
  );
}
