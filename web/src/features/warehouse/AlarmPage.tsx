import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Card, Col, Row, Select, Space, Statistic, Tag, message } from 'antd';
import { DeleteOutlined, ShoppingOutlined, ToolOutlined } from '@ant-design/icons';
import { warehouseApi } from '../../api';
import {
  PriceText,
  ResponsiveTable,
  TopActionBar,
  RowActionButton,
  useRowSelect,
} from '../../components';
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
  /** 顶部操作区：先选中一行，再点按钮（与生产工单页同一套交互）。
      本表 rowKey 是复合主键 `itemType-id`，所以必须给 keyOf，否则选中态对不上。 */
  const keyOf = (r: any) => `${r.itemType}-${r.id}`;
  const { selectedId, clearSelection, rowSelection, onRowClick } = useRowSelect(keyOf);
  const selected = (data?.list ?? []).find((r: any) => keyOf(r) === selectedId) ?? null;
  /** 缺货类等级才需要补货 / 排产 */
  const isShortage = (r: any) => r?.level === '安全库存告警' || r?.level === '严重缺货';

  const load = () =>
    warehouseApi
      .alarm({ itemType, level })
      .then(setData)
      .catch((e: any) => message.error(e.message));

  useEffect(() => {
    load();
    clearSelection(); // 筛选条件变了，行数据跟着变，选中态必须清掉
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

      {/* 操作区：原处置按钮在每行末尾，统一集中到表格上方右侧（先选中一行再操作） */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
        <TopActionBar>
          <RowActionButton
            text="去采购"
            icon={<ShoppingOutlined />}
            permission="purchase.order.create"
            selected={selected}
            tipName="预警记录"
            disabledReason={(r) => {
              if (r.itemType !== 'material') return '请先切换到「物料」维度';
              return isShortage(r) ? null : '该记录无需采购处置';
            }}
            onAction={(r) => navigate('/purchase/orders', { state: { prefill: { materialIds: [r.id] } } })}
          />
          <RowActionButton
            text="去创建工单"
            icon={<ToolOutlined />}
            permission="production.wo.create"
            selected={selected}
            tipName="预警记录"
            disabledReason={(r) => {
              if (r.itemType !== 'product') return '请先切换到「成品」维度';
              return isShortage(r) ? null : '该记录无需排产处置';
            }}
            onAction={(r) => navigate('/production/work-orders', { state: { prefill: { productId: r.id } } })}
          />
          {/* 呆滞库存的两条处置路径：卖掉 或 报不良 */}
          <RowActionButton
            text="销售处理"
            icon={<ShoppingOutlined />}
            permission="warehouse.materialSale.create"
            selected={selected}
            tipName="预警记录"
            disabledReason={(r) => (r.level === '呆滞库存' ? null : '仅呆滞库存需要销售处置')}
            onAction={(r) =>
              navigate('/warehouse/material-sales', {
                state: { prefill: { materialId: r.id, materialName: r.name } },
              })
            }
          />
          <RowActionButton
            text="不良品处理"
            icon={<DeleteOutlined />}
            permission="warehouse.defective.create"
            selected={selected}
            tipName="预警记录"
            disabledReason={(r) => (r.level === '呆滞库存' ? null : '仅呆滞库存需要不良品处置')}
            onAction={(r) =>
              navigate('/warehouse/defectives', {
                state: { prefill: { materialId: r.id, materialName: r.name } },
              })
            }
          />
        </TopActionBar>
      </div>

      <ResponsiveTable
        rowKey={(r: any) => `${r.itemType}-${r.id}`}
        size="small"
        dataSource={data?.list ?? []}
        scroll={{ x: 1100 }}
        rowSelection={rowSelection}
        onRowClick={onRowClick}
        selectedRowKeys={selectedId === null ? [] : [selectedId]}
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
        ]}
      />
    </Card>
  );
}
