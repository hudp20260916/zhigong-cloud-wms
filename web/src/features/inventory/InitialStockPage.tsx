import { useEffect, useState } from 'react';
import { Button, Card, Divider, Input, InputNumber, Select, Space, Tabs, message } from 'antd';
import { archiveApi, inventoryApi } from '../../api';
import { useList } from '../../hooks/useList';
import {
  PermPage,
  PriceText,
  ResponsiveTable,
  ImportExcelModal,
  FilterBar,
  CopyableCode,
} from '../../components';
import { exportCsv, today } from '../../utils/exportCsv';
import type { ItemType } from '@shared/enums';

interface Row {
  key: string;
  itemId: number;
  itemType: ItemType;
  code: string;
  name: string;
  unit: string;
  qty: number;
  price: number;
}

/**
 * 需求 20：期初库存（子物料 / 主产品）支持筛选、导出、Excel 导入与模板下载。
 *
 * 页面拆成两块：
 *  1. 上半部分是「已录期初清单」——只读，来源于流水台账的期初合计，支持按编码/名称/规格筛选与导出；
 *  2. 下半部分是原来的「录入 / 修改」区，保留手动逐条设定的能力。
 * 两者共用同一个 setInitialStock 语义（设定，非累加），不会打架。
 */
export default function InitialStockPage() {
  const [tab, setTab] = useState<ItemType>('material');
  const { list, total, loading, params, patchParams, reload } = useList<any>((p) =>
    inventoryApi.initialList({ ...p, itemType: tab }),
  );
  const [options, setOptions] = useState<any[]>([]);
  const [rows, setRows] = useState<Row[]>([]);
  const [pickId, setPickId] = useState<number | undefined>();
  const [saving, setSaving] = useState(false);

  // 切换 Tab 时刷新已录清单
  useEffect(() => {
    patchParams({ page: 1 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  useEffect(() => {
    (tab === 'material' ? archiveApi.materialOptions() : archiveApi.productOptions())
      .then(setOptions)
      .catch(() => undefined);
  }, [tab]);

  function addItem() {
    if (!pickId) return;
    const opt = options.find((o) => o.id === pickId);
    if (!opt) return;
    if (rows.some((r) => r.itemId === pickId && r.itemType === tab)) {
      message.warning('该对象已在列表中');
      return;
    }
    setRows((prev) => [
      ...prev,
      {
        key: `${tab}-${pickId}`,
        itemId: pickId,
        itemType: tab,
        code: opt.code,
        name: opt.name,
        unit: opt.unit,
        qty: 0,
        price: Number(opt.avg_cost ?? 0),
      },
    ]);
    setPickId(undefined);
  }

  async function submit() {
    if (rows.length === 0) {
      message.warning('请至少录入一条期初库存');
      return;
    }
    setSaving(true);
    try {
      await inventoryApi.initial(
        rows.map((r) => ({ itemType: r.itemType, itemId: r.itemId, qty: r.qty, price: r.price })),
      );
      message.success(`已录入 ${rows.length} 条期初库存`);
      setRows([]);
      reload();
    } catch (e: any) {
      message.error(e.message);
    } finally {
      setSaving(false);
    }
  }

  const label = tab === 'material' ? '子物料' : '主产品';

  return (
    <PermPage permission="stock.initial.manage">
      <Card
        title="期初库存"
        extra={
          <Space>
            <Input.Search
              placeholder="编码 / 名称 / 规格"
              allowClear
              style={{ width: 220 }}
              onSearch={(keyword) => patchParams({ keyword })}
            />
            {/* 需求 20：导出跟随筛选结果 */}
            <Button
              onClick={async () => {
                const res = await inventoryApi.initialList({ ...params, itemType: tab, page: 1, pageSize: 50000 });
                exportCsv(`${label}期初库存_${today()}`, [
                  { title: '编码', key: 'code' },
                  { title: '名称', key: 'name' },
                  { title: '规格', key: 'spec' },
                  { title: '单位', key: 'unit' },
                  { title: '期初数量', key: 'initial_qty' },
                  ...(tab === 'material' ? [{ title: '期初单价', key: 'initial_price' }] : []),
                  { title: '当前库存', key: 'current_stock' },
                  { title: '最近更新', key: 'updated_at' },
                ], res.list ?? []);
              }}
            >
              导出
            </Button>
            {/* 需求 20：期初库存 Excel 导入（自带模板下载） */}
            <ImportExcelModal kind="initial_stock" onSuccess={reload} />
            <Button type="primary" loading={saving} onClick={submit} disabled={rows.length === 0}>
              提交期初库存
            </Button>
          </Space>
        }
      >
        <Tabs
          activeKey={tab}
          onChange={(k) => setTab(k as ItemType)}
          items={[
            { key: 'material', label: '子物料期初' },
            { key: 'product', label: '主产品期初' },
          ]}
        />

        <FilterBar onReset={() => patchParams({ keyword: '' })}>
          <Input
            allowClear
            style={{ width: 240 }}
            placeholder={`${label}编码 / 名称 / 规格包含`}
            value={params.keyword ?? ''}
            onChange={(e) => patchParams({ keyword: e.target.value })}
          />
        </FilterBar>

        <ResponsiveTable
          rowKey="item_id"
          size="small"
          loading={loading}
          dataSource={list}
          scroll={{ x: 900 }}
          pagination={{
            current: params.page,
            pageSize: params.pageSize,
            total,
            onChange: (page, pageSize) => patchParams({ page, pageSize }),
          }}
          locale={{ emptyText: '尚未录入期初库存' }}
          columns={[
            { title: '编码', dataIndex: 'code', width: 130, render: (v) => <CopyableCode value={v} /> },
            { title: '名称', dataIndex: 'name' },
            { title: '规格', dataIndex: 'spec', width: 160, render: (v) => v || '-' },
            { title: '单位', dataIndex: 'unit', width: 80 },
            { title: '期初数量', dataIndex: 'initial_qty', width: 110, className: 'mono' },
            ...(tab === 'material'
              ? [
                  {
                    title: '期初单价',
                    dataIndex: 'initial_price',
                    width: 110,
                    render: (v: any) => <PriceText value={v} />,
                  },
                ]
              : []),
            { title: '当前库存', dataIndex: 'current_stock', width: 110, className: 'mono' },
            { title: '最近更新', dataIndex: 'updated_at', width: 170, render: (v) => String(v ?? '').slice(0, 19) || '-' },
          ]}
        />

        <Divider orientation="left" plain style={{ marginTop: 20 }}>
          录入 / 修改期初库存
        </Divider>

        <Space style={{ marginBottom: 12 }}>
          <Select
            showSearch
            style={{ width: 360 }}
            placeholder="选择物料 / 成品加入期初录入"
            value={pickId}
            onChange={setPickId}
            optionFilterProp="label"
            options={options.map((o) => ({ value: o.id, label: `${o.code} ${o.name}` }))}
          />
          <Button onClick={addItem}>添加</Button>
        </Space>

        <ResponsiveTable
          rowKey="key"
          size="small"
          dataSource={rows}
          pagination={false}
          locale={{ emptyText: '请从上方选择对象加入期初录入清单' }}
          columns={[
            { title: '编码', dataIndex: 'code', width: 120 },
            { title: '名称', dataIndex: 'name' },
            { title: '单位', dataIndex: 'unit', width: 80 },
            {
              title: '期初数量',
              dataIndex: 'qty',
              width: 160,
              render: (v, r) => (
                <InputNumber
                  min={0}
                  value={v}
                  style={{ width: '100%' }}
                  onChange={(nv) =>
                    setRows((prev) => prev.map((x) => (x.key === r.key ? { ...x, qty: Number(nv ?? 0) } : x)))
                  }
                />
              ),
            },
            ...(tab === 'material'
              ? [
                  {
                    title: '期初单价',
                    dataIndex: 'price',
                    width: 160,
                    render: (v: any, r: Row) => (
                      <InputNumber
                        min={0}
                        step={0.01}
                        value={v}
                        style={{ width: '100%' }}
                        onChange={(nv) =>
                          setRows((prev) =>
                            prev.map((x) => (x.key === r.key ? { ...x, price: Number(nv ?? 0) } : x)),
                          )
                        }
                      />
                    ),
                  },
                ]
              : []),
            {
              title: '操作',
              width: 80,
              render: (_, r) => (
                <Button
                  type="link"
                  size="small"
                  danger
                  onClick={() => setRows((prev) => prev.filter((x) => x.key !== r.key))}
                >
                  移除
                </Button>
              ),
            },
          ]}
        />
        <div style={{ marginTop: 12, color: '#8c8c8c', fontSize: 12 }}>
          说明：期初库存采用「设定」而非「累加」，重复提交同一对象会以最新录入值为准并同步回滚历史期初流水。
        </div>
      </Card>
    </PermPage>
  );
}
