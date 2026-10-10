import { useEffect, useState } from 'react';
import { Card, Col, Empty, Row, Space, Statistic, Table, Tag, Typography, message } from 'antd';
import {
  AlertOutlined,
  ArrowDownOutlined,
  ArrowUpOutlined,
  InboxOutlined,
  ScheduleOutlined,
} from '@ant-design/icons';
import { dashboardApi } from '../../api';
import { useAuthStore } from '../../stores/auth';
import { ResponsiveTable } from '../../components';

/** 快捷入口：把最常用的建单动作集中到大屏，减少菜单层级跳转 */
const QUICK_LINKS = [
  { label: '采购订单', path: '/purchase/orders', permission: 'purchase.order.create' },
  { label: '采购入库', path: '/purchase/receipts', permission: 'purchase.receipt.create' },
  { label: '生产工单', path: '/production/work-orders', permission: 'production.wo.create' },
  { label: '销售开单', path: '/sale/orders', permission: 'sale.order.create' },
  { label: '库存查询', path: '/inventory/stock', permission: 'stock.view' },
  { label: '预警看板', path: '/warehouse/alarm', permission: 'warehouse.alarm.view' },
];

export default function DashboardPage() {
  const [data, setData] = useState<any>(null);
  const has = useAuthStore((s) => s.has);

  useEffect(() => {
    dashboardApi
      .summary()
      .then(setData)
      .catch((e: any) => message.error(e.message));
  }, []);

  if (!data) return <Card loading />;

  const { metrics, todo, todayFlow, trend, alarmTop, canViewPrice } = data;

  return (
    <>
      <Row gutter={[12, 12]}>
        <MetricCol label="物料总品类" value={metrics.materialKinds} suffix="种" />
        <MetricCol label="成品库存" value={metrics.productStock} suffix="台" />
        <MetricCol label="物料库存" value={metrics.materialStock} />
        <MetricCol
          label="安全库存告警"
          value={metrics.alarmMaterials}
          suffix="种"
          danger={metrics.alarmMaterials > 0}
        />
        {canViewPrice && <MetricCol label="物料库存金额" value={metrics.materialStockAmount} prefix="¥" precision={2} />}
        {canViewPrice && <MetricCol label="本月采购额" value={metrics.monthPurchaseAmount} prefix="¥" precision={2} />}
        {canViewPrice && <MetricCol label="本月销售额" value={metrics.monthSaleAmount} prefix="¥" precision={2} />}
        <MetricCol label="今日入库 / 出库" value={metrics.todayIn} suffix={` / ${metrics.todayOut} 笔`} />
      </Row>

      <Row gutter={[12, 12]} style={{ marginTop: 12 }}>
        <Col xs={24} xl={10}>
          <Card
            title={
              <Space>
                <ScheduleOutlined />
                待办事项
              </Space>
            }
          >
            <Row gutter={[8, 8]}>
              <TodoCard label="待到货采购单" value={todo.pendingPurchase} path="/purchase/orders" />
              <TodoCard label="待入库单据" value={todo.pendingReceipt} path="/purchase/receipts" />
              <TodoCard label="待出库销售单" value={todo.pendingSale} path="/sale/deliveries" />
              <TodoCard label="待审核盘点单" value={todo.pendingCheck} path="/warehouse/checks" />
              <TodoCard label="待结算入库单" value={todo.pendingSettle} path="/finance/settlements" />
            </Row>

            <div style={{ marginTop: 16 }}>
              <Typography.Text type="secondary">快捷入口</Typography.Text>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
                {QUICK_LINKS.filter((q) => has(q.permission)).map((q) => (
                  <a
                    key={q.path}
                    href={`#${q.path}`}
                    style={{
                      padding: '6px 12px',
                      border: '1px solid #d9d9d9',
                      borderRadius: 6,
                      fontSize: 13,
                      color: '#1677ff',
                    }}
                  >
                    {q.label}
                  </a>
                ))}
              </div>
            </div>
          </Card>
        </Col>

        <Col xs={24} xl={14}>
          <Card
            title={
              <Space>
                <InboxOutlined />
                今日出入库流水
              </Space>
            }
          >
            <ResponsiveTable
              size="small"
              rowKey="id"
              dataSource={todayFlow}
              locale={{ emptyText: <Empty description="今日暂无出入库记录" /> }}
              pagination={false}
              scroll={{ y: 240, x: 620 }}
              columns={[
                { title: '品名', dataIndex: 'item_name', width: 160 },
                { title: '类型', dataIndex: 'biz_type', width: 110 },
                {
                  title: '方向',
                  dataIndex: 'direction',
                  width: 80,
                  render: (v) => (
                    <Tag color={v === 'in' ? 'red' : 'green'} icon={v === 'in' ? <ArrowUpOutlined /> : <ArrowDownOutlined />}>
                      {v === 'in' ? '入库' : '出库'}
                    </Tag>
                  ),
                },
                { title: '数量', dataIndex: 'qty', width: 90, className: 'mono' },
                { title: '结存', dataIndex: 'balance_after', width: 90, className: 'mono' },
                {
                  title: '时间',
                  dataIndex: 'created_at',
                  width: 90,
                  render: (v) => String(v).slice(11, 19),
                },
              ]}
            />
          </Card>
        </Col>
      </Row>

      <Row gutter={[12, 12]} style={{ marginTop: 12 }}>
        <Col xs={24} xl={16}>
          <Card title="近 7 日出入库趋势">
            <TrendChart data={trend} />
          </Card>
        </Col>
        <Col xs={24} xl={8}>
          <Card
            title={
              <Space>
                <AlertOutlined />
                安全库存告警 Top5
              </Space>
            }
          >
            {alarmTop.length === 0 ? (
              <Empty description="暂无告警物料" />
            ) : (
              <ResponsiveTable
                size="small"
                rowKey="id"
                dataSource={alarmTop}
                pagination={false}
                columns={[
                  { title: '物料', dataIndex: 'name', ellipsis: true },
                  { title: '现存', dataIndex: 'current_stock', width: 80, className: 'mono' },
                  { title: '安全库存', dataIndex: 'safety_stock', width: 90, className: 'mono' },
                ]}
              />
            )}
          </Card>
        </Col>
      </Row>
    </>
  );
}

function MetricCol({
  label,
  value,
  suffix,
  prefix,
  precision = 0,
  danger,
}: {
  label: string;
  value: number;
  suffix?: string;
  prefix?: string;
  precision?: number;
  danger?: boolean;
}) {
  return (
    <Col xs={12} sm={8} xl={6}>
      <Card>
        <Statistic
          title={label}
          value={value}
          precision={precision}
          suffix={suffix}
          prefix={prefix}
          valueStyle={{ color: danger ? '#cf1322' : undefined }}
        />
      </Card>
    </Col>
  );
}

function TodoCard({ label, value, path }: { label: string; value: number; path: string }) {
  return (
    <Col xs={12} sm={8}>
      <Card
        size="small"
        hoverable
        onClick={() => {
          location.hash = `#${path}`;
        }}
      >
        <Statistic
          title={label}
          value={value}
          suffix="单"
          valueStyle={{ color: value > 0 ? '#fa8c16' : undefined, fontSize: 20 }}
        />
      </Card>
    </Col>
  );
}

/**
 * 7 日趋势柱状图（纯 SVG 自绘）。
 * 取舍：不引入 echarts / Chart.js —— 只有一个分组柱状图的诉求，
 * 引入图表库会让主包增加 300KB+ 且要处理主题适配；自绘约 60 行且完全可控。
 */
function TrendChart({ data }: { data: any[] }) {
  const series = [
    { key: 'purchaseIn', label: '采购入库', color: '#1677ff' },
    { key: 'produceIn', label: '生产入库', color: '#52c41a' },
    { key: 'saleOut', label: '销售出库', color: '#fa8c16' },
  ];

  const max = Math.max(
    1,
    ...data.flatMap((d) => series.map((s) => Number(d[s.key] ?? 0))),
  );

  const W = 100;
  const H = 60;
  const groupW = W / Math.max(1, data.length);
  const barW = (groupW * 0.6) / series.length;

  const total = series.reduce(
    (s, x) => s + data.reduce((a, d) => a + Number(d[x.key] ?? 0), 0),
    0,
  );

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H + 10}`} preserveAspectRatio="none" style={{ width: '100%', height: 200 }}>
        {data.map((d, i) => {
          const gx = i * groupW + groupW * 0.2;
          return (
            <g key={d.day}>
              {series.map((s, j) => {
                const v = Number(d[s.key] ?? 0);
                const h = (v / max) * H;
                return (
                  <rect
                    key={s.key}
                    x={gx + j * barW}
                    y={H - h}
                    width={barW * 0.9}
                    height={Math.max(h, v > 0 ? 0.6 : 0)}
                    fill={s.color}
                    rx={0.4}
                  />
                );
              })}
              <text x={i * groupW + groupW / 2} y={H + 7} fontSize={3} textAnchor="middle" fill="#888">
                {d.label}
              </text>
            </g>
          );
        })}
      </svg>

      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginTop: 8 }}>
        {series.map((s) => (
          <Space key={s.key} size={6}>
            <span
              style={{ display: 'inline-block', width: 10, height: 10, background: s.color, borderRadius: 2 }}
            />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {s.label} {data.reduce((a, d) => a + Number(d[s.key] ?? 0), 0)}
            </Typography.Text>
          </Space>
        ))}
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          峰值 {max}
        </Typography.Text>
      </div>
      {total === 0 && (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          近 7 日暂无出入库记录
        </Typography.Text>
      )}
    </div>
  );
}
