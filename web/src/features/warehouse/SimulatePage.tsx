import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Alert, Button, Card, Empty, InputNumber, Select, Space, Table, Tag, message } from 'antd';
import { archiveApi, warehouseApi } from '../../api';
import { exportCsv, today } from '../../utils/exportCsv';
import { ResponsiveTable } from '../../components';

interface Row { key: string; productId?: number; qty: number; stock?: number }

/** 模拟出货与排产建议：测算缺口 → 一键转工单 / 跳转采购（需求 3.7.3） */
export default function SimulatePage() {
  const navigate = useNavigate();
  const [products, setProducts] = useState<any[]>([]);
  const [rows, setRows] = useState<Row[]>([]);
  const [result, setResult] = useState<any>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    archiveApi.productOptions().then(setProducts).catch(() => undefined);
  }, []);

  async function run() {
    const lines = rows.filter((r) => r.productId && r.qty > 0);
    if (lines.length === 0) return message.warning('请至少录入一条出货需求');
    setLoading(true);
    try {
      const res = await warehouseApi.simulate(lines.map((r) => ({ productId: r.productId, qty: r.qty })));
      setResult(res);
    } catch (e: any) {
      message.error(e.message);
    } finally {
      setLoading(false);
    }
  }

  async function toWorkOrders() {
    const need = (result?.products ?? []).filter((p: any) => p.needProduce > 0);
    if (need.length === 0) return message.warning('没有需要排产的成品');
    try {
      const res = await warehouseApi.simulateToWorkOrders(
        need.map((p: any) => ({ productId: p.productId, planQty: p.needProduce })),
      );
      message.success(`已生成 ${res.count} 张生产工单`);
      navigate('/production/work-orders');
    } catch (e: any) {
      message.error(e.message);
    }
  }

  function toPurchase() {
    const gaps = (result?.materials ?? []).filter((m: any) => m.gapQty > 0);
    if (gaps.length === 0) return message.info('当前没有缺料，无需采购');
    navigate('/purchase/orders', { state: { prefill: { materialIds: gaps.map((m: any) => m.materialId) } } });
  }

  return (
    <Card
      title="模拟出货与排产建议"
      extra={
        <Space>
          <Button disabled={!result} onClick={() => exportCsv(`排产分析报告_${today()}`, [
            { title: '成品编码', key: 'code' },
            { title: '成品名称', key: 'name' },
            { title: '需求数量', key: 'requireQty' },
            { title: '现有库存', key: 'stock' },
            { title: '待生产量', key: 'needProduce' },
          ], result?.products ?? [])}>导出排产报告</Button>
          <Button disabled={!result} onClick={toPurchase}>按缺料去采购</Button>
          <Button type="primary" disabled={!result} onClick={toWorkOrders}>一键生成生产工单</Button>
        </Space>
      }
    >
      <Alert type="info" showIcon style={{ marginBottom: 12 }}
        message="输入出货需求，系统比对成品库存后按缺口展开 BOM，计算子物料总需求量与缺口，可直接转工单或发起采购" />

      <Space style={{ marginBottom: 12 }}>
        <Select
          style={{ width: 320 }}
          placeholder="选择成品加入出货需求"
          value={undefined}
          showSearch
          optionFilterProp="label"
          options={products.map((p) => ({ value: p.id, label: `${p.code} ${p.name}` }))}
          onSelect={(v) => {
            const p = products.find((x) => x.id === v);
            if (rows.some((r) => r.productId === v)) return;
            setRows((prev) => [...prev, { key: String(v), productId: v, qty: 100, stock: p?.current_stock }]);
          }}
        />
        <Button onClick={run} loading={loading}>开始测算</Button>
      </Space>

      <ResponsiveTable
        size="small"
        rowKey="key"
        dataSource={rows}
        pagination={false}
        style={{ marginBottom: 16 }}
        locale={{ emptyText: <Empty description="请从上方选择成品加入出货需求" /> }}
        columns={[
          { title: '成品', dataIndex: 'productId', render: (v) => products.find((p) => p.id === v)?.name ?? v },
          { title: '现有库存', dataIndex: 'stock', width: 110, className: 'mono' },
          { title: '出货需求量', dataIndex: 'qty', width: 140, render: (v, r) => (
            <InputNumber min={0} value={v} style={{ width: '100%' }} onChange={(nv) => setRows((prev) => prev.map((x) => (x.key === r.key ? { ...x, qty: Number(nv ?? 0) } : x)))} />
          ) },
          { title: '操作', width: 70, render: (_, r) => (
            <Button type="link" size="small" danger onClick={() => setRows((prev) => prev.filter((x) => x.key !== r.key))}>移除</Button>
          ) },
        ]}
      />

      {result && (
        <>
          <div style={{ fontWeight: 500, marginBottom: 8 }}>成品缺口分析</div>
          <ResponsiveTable size="small" rowKey="productId" dataSource={result.products} pagination={false} style={{ marginBottom: 16 }}
            columns={[
              { title: '编码', dataIndex: 'code', width: 110 },
              { title: '成品名称', dataIndex: 'name' },
              { title: '需求量', dataIndex: 'requireQty', width: 100, className: 'mono' },
              { title: '现有库存', dataIndex: 'stock', width: 100, className: 'mono' },
              { title: '待生产量', dataIndex: 'needProduce', width: 110, className: 'mono',
                render: (v) => <span style={{ color: Number(v) > 0 ? '#cf1322' : undefined }}>{v}</span> },
              { title: '结论', width: 120, render: (_v, r: any) => r.needProduce > 0 ? <Tag color="red">需排产</Tag> : <Tag color="green">库存充足</Tag> },
            ]} />

          <div style={{ fontWeight: 500, marginBottom: 8 }}>子物料需求与缺口</div>
          <ResponsiveTable size="small" rowKey="materialId" dataSource={result.materials} pagination={false}
            columns={[
              { title: '编码', dataIndex: 'code', width: 110 },
              { title: '物料名称', dataIndex: 'name' },
              { title: '规格', dataIndex: 'spec', width: 150 },
              { title: '总需求量', dataIndex: 'needQty', width: 110, className: 'mono' },
              { title: '现有库存', dataIndex: 'stock', width: 100, className: 'mono' },
              { title: '缺口', dataIndex: 'gapQty', width: 100, className: 'mono',
                render: (v) => <span style={{ color: Number(v) > 0 ? '#cf1322' : undefined }}>{v}</span> },
              { title: '结论', width: 120, render: (_v, r: any) => r.gapQty > 0 ? <Tag color="red">需采购</Tag> : <Tag color="green">充足</Tag> },
            ]} />
        </>
      )}
    </Card>
  );
}
