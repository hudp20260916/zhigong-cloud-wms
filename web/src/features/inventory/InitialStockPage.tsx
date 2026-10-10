import { useEffect, useState } from 'react';
import { Button, Card, InputNumber, Select, Space, Table, Tabs, message } from 'antd';
import { archiveApi, inventoryApi } from '../../api';
import { PermPage, ResponsiveTable } from '../../components';
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

export default function InitialStockPage() {
  const [tab, setTab] = useState<ItemType>('material');
  const [options, setOptions] = useState<any[]>([]);
  const [rows, setRows] = useState<Row[]>([]);
  const [pickId, setPickId] = useState<number | undefined>();
  const [saving, setSaving] = useState(false);

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
    } catch (e: any) {
      message.error(e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <PermPage permission="stock.initial.manage">
      <Card
        title="期初库存录入"
        extra={
          <Space>
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
