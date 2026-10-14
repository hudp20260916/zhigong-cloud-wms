import { useEffect, useState } from 'react';
import { Button, Card, Divider, Input, InputNumber, Select, Space, Tabs, message } from 'antd';
import { EditOutlined } from '@ant-design/icons';
import { archiveApi, inventoryApi } from '../../api';
import { useList } from '../../hooks/useList';
import {
  PermPage,
  PriceText,
  ResponsiveTable,
  ImportExcelModal,
  FilterBar,
  CopyableCode,
  TopActionBar,
  RowActionButton,
  useRowSelect,
  WarehouseSelect,
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
  /** 多仓库：这批期初落在哪个仓；不传时服务端按对象品类归默认仓（物料→物料库、成品→成品库） */
  const [warehouseId, setWarehouseId] = useState<number | null>(null);
  /** 顶部操作区：先选中一行，再点按钮（与生产工单页同一套交互） */
  // 已录清单的主键是 item_id（不是 id），所以给 keyOf，选中态才能对上
  const { selectedId, clearSelection, rowSelection, onRowClick } = useRowSelect(
    (r: any) => r.item_id,
  );
  const selected = list.find((r) => r.item_id === selectedId) ?? null;

  // 切换 Tab 时刷新已录清单
  useEffect(() => {
    patchParams({ page: 1 });
    clearSelection(); // 换 Tab 就是换一批数据，清空选中避免误操作到另一类对象
    setWarehouseId(null); // 换品类可选仓跟着变，清掉避免把物料期初落到成品仓
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

  /** 顶部「修改」：把已录清单里选中的记录带进下方录入区，改完再统一提交（设定语义，覆盖旧值） */
  function editRow(row: any) {
    const key = `${tab}-${row.item_id}`;
    if (rows.some((r) => r.key === key)) {
      message.warning('该对象已在录入清单中');
      return;
    }
    setRows((prev) => [
      ...prev,
      {
        key,
        itemId: Number(row.item_id),
        itemType: tab,
        code: row.code,
        name: row.name,
        unit: row.unit,
        qty: Number(row.initial_qty ?? 0),
        price: Number(row.initial_price ?? 0),
      },
    ]);
    clearSelection();
  }

  async function submit() {
    if (rows.length === 0) {
      message.warning('请至少录入一条期初库存');
      return;
    }
    setSaving(true);
    try {
      await inventoryApi.initial(
        rows.map((r) => ({
          itemType: r.itemType,
          itemId: r.itemId,
          qty: r.qty,
          price: r.price,
          warehouseId: warehouseId ?? undefined,
        })),
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

        <FilterBar
          onReset={() => patchParams({ keyword: '' })}
          extra={
            /* 操作区与筛选控件同一行、靠右。已录清单原来是纯只读、没有任何操作入口，
               统一成「先选中一行，再点按钮」后，由这里把选中记录带进下方录入区修改。 */
            <TopActionBar>
              <RowActionButton
                text="修改"
                icon={<EditOutlined />}
                selected={selected}
                tipName="期初记录"
                onAction={(row) => editRow(row)}
              />
            </TopActionBar>
          }
        >
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
          rowSelection={rowSelection}
          // 移动端卡片模式「点卡片即选中」的入口（keyOf 已在 useRowSelect 里指定为 item_id）
          onRowClick={onRowClick}
          selectedRowKeys={selectedId === null ? [] : [selectedId]}
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
          <div>
            <div style={{ marginBottom: 4, fontSize: 12, color: '#595959' }}>期初仓库</div>
            <WarehouseSelect
              itemType={tab}
              value={warehouseId}
              onChange={setWarehouseId}
              style={{ width: 200 }}
            />
          </div>
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
