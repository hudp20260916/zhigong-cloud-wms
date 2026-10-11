import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, Col, Row, Select, Space, Statistic, Table, Tag, Button, message } from 'antd';
import { warehouseApi } from '../../api';
import { PermGate, PriceText, ResponsiveTable } from '../../components';
import { exportCsv, today } from '../../utils/exportCsv';
import type { ItemType } from '@shared/enums';

const LEVEL_COLOR: Record<string, string> = {
  安全库存告警: 'red',
  严重缺货: '#a8071a',
  超储预警: 'orange',
  呆滞库存: 'blue',
};

/** 库存预警看板：四级卡片 + 多维筛选 + 处置入口（需求 3.7.4） */
export default function AlarmPage() {
  const navigate = useNavigate();
  const [itemType, setItemType] = useState<ItemType>('material');
  const [level, setLevel] = useState<string>('');
  const [data, setData] = useState<any>(null);

  const load = () =>
    warehouseApi
      .alarm({ itemType, level })
      .then(setData)
      .catch((e: any) => message.error(e.message));

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemType, level]);

  return (
    <Card
      title="库存预警看板"
      extra={
        <Space>
          <Select style={{ width: 120 }} value={itemType} onChange={setItemType}
            options={[{ value: 'material', label: '物料' }, { value: 'product', label: '成品' }]} />
          <Select style={{ width: 150 }} allowClear placeholder="全部等级" value={level || undefined} onChange={(v) => setLevel(v ?? '')}
            options={[
              { value: '安全库存告警', label: '安全库存告警' },
              { value: '严重缺货', label: '严重缺货' },
              { value: '超储预警', label: '超储预警' },
              { value: '呆滞库存', label: '呆滞库存' },
            ]} />
          <Button onClick={() => exportCsv(`库存预警_${today()}`, [
            { title: '编码', key: 'code' },
            { title: '名称', key: 'name' },
            { title: '规格', key: 'spec' },
            { title: '当前库存', key: 'current_stock' },
            { title: '安全库存', key: 'safety_stock' },
            { title: '预警等级', key: 'level' },
          ], data?.list ?? [])}>导出</Button>
        </Space>
      }
    >
      <Row gutter={12} style={{ marginBottom: 16 }}>
        <Col xs={12} sm={6}>
          <Card size="small" style={{ borderLeft: '3px solid #cf1322' }}>
            <Statistic title="安全库存告警" value={data?.cards?.['安全库存告警'] ?? 0} suffix="项"
              valueStyle={{ color: '#cf1322' }} />
          </Card>
        </Col>
        <Col xs={12} sm={6}>
          <Card size="small" style={{ borderLeft: '3px solid #a8071a' }}>
            <Statistic title="严重缺货告警" value={data?.cards?.['严重缺货'] ?? 0} suffix="项"
              valueStyle={{ color: '#a8071a' }} />
          </Card>
        </Col>
        <Col xs={12} sm={6}>
          <Card size="small" style={{ borderLeft: '3px solid #faad14' }}>
            <Statistic title="超储预警" value={data?.cards?.['超储预警'] ?? 0} suffix="项"
              valueStyle={{ color: '#faad14' }} />
          </Card>
        </Col>
        <Col xs={12} sm={6}>
          <Card size="small" style={{ borderLeft: '3px solid #1677ff' }}>
            <Statistic title="呆滞库存" value={data?.cards?.['呆滞库存'] ?? 0} suffix="项"
              valueStyle={{ color: '#1677ff' }} />
          </Card>
        </Col>
      </Row>

      <ResponsiveTable
        rowKey={(r: any) => `${r.itemType}-${r.id}`}
        size="small"
        dataSource={data?.list ?? []}
        scroll={{ x: 1100 }}
        pagination={{ pageSize: 20 }}
        columns={[
          { title: '编码', dataIndex: 'code', width: 120 },
          { title: '名称', dataIndex: 'name', width: 200 },
          { title: '规格', dataIndex: 'spec', width: 150 },
          { title: '单位', dataIndex: 'unit', width: 70 },
          { title: '当前库存', dataIndex: 'current_stock', width: 110, className: 'mono' },
          { title: '安全库存', dataIndex: 'safety_stock', width: 100, className: 'mono' },
          ...(itemType === 'material'
            ? [{ title: '加权成本', dataIndex: 'avg_cost', width: 100, render: (v: any) => <PriceText value={v} /> }]
            : []),
          {
            title: '预警等级',
            dataIndex: 'level',
            width: 130,
            render: (v) => <Tag color={LEVEL_COLOR[v] ?? 'default'}>{v}</Tag>,
          },
          {
            title: '处置',
            width: 180,
            render: (_v, r: any) => {
              const isShortage = r.level === '安全库存告警' || r.level === '严重缺货';
              if (isShortage && itemType === 'material') {
                return (
                  <PermGate permission="purchase.order.create">
                    <Button type="link" size="small" onClick={() =>
                      navigate('/purchase/orders', { state: { prefill: { materialIds: [r.id] } } })
                    }>去采购</Button>
                  </PermGate>
                );
              }
              if (isShortage && itemType === 'product') {
                return (
                  <PermGate permission="production.wo.create">
                    <Button type="link" size="small" onClick={() =>
                      navigate('/production/work-orders', { state: { prefill: { productId: r.id } } })
                    }>去创建工单</Button>
                  </PermGate>
                );
              }
              if (r.level === '呆滞库存') {
                return (
                  <Space size={0}>
                    <PermGate permission="warehouse.materialSale.create">
                      {/* 需求 22：带出物料，跳过去直接就是这张单 */}
                      <Button type="link" size="small" onClick={() => navigate('/warehouse/material-sales', {
                        state: { prefill: { materialId: r.id, materialName: r.name } },
                      })}>销售处理</Button>
                    </PermGate>
                    <PermGate permission="warehouse.defective.create">
                      <Button type="link" size="small" onClick={() => navigate('/warehouse/defectives', {
                        state: { prefill: { materialId: r.id, materialName: r.name } },
                      })}>不良品处理</Button>
                    </PermGate>
                  </Space>
                );
              }
              return <span style={{ color: '#8c8c8c' }}>建议控制采购节奏</span>;
            },
          },
        ]}
      />
    </Card>
  );
}
