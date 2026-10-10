import { useEffect, useMemo, useState } from 'react';
import { Button, Card, Col, DatePicker, Row, Select, Space, Table, message } from 'antd';
import { reportApi } from '../../api';
import { PermPage, ResponsiveTable } from '../../components';
import { exportCsv, today } from '../../utils/exportCsv';
import { dayVal } from '../../utils/date';

/**
 * 报表中心。
 * 页面完全由后端返回的 columns 驱动：新增报表只需在服务端 REPORTS 里加一项，
 * 这里不用改一行代码。
 */
export default function ReportPage() {
  return (
    <PermPage permission="report.view">
      <ReportInner />
    </PermPage>
  );
}

function ReportInner() {
  const [meta, setMeta] = useState<any[]>([]);
  const [kind, setKind] = useState<string>('');
  const [from, setFrom] = useState<string>('');
  const [to, setTo] = useState<string>('');
  const [data, setData] = useState<{ columns: any[]; rows: any[]; meta: any }>({
    columns: [],
    rows: [],
    meta: {},
  });
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    reportApi
      .meta()
      .then((m) => {
        setMeta(m);
        if (m.length > 0) setKind(m[0].kind);
      })
      .catch((e: any) => message.error(e.message));
  }, []);

  useEffect(() => {
    if (!kind) return;
    setLoading(true);
    reportApi
      .data({ kind, from, to })
      .then(setData)
      .catch((e: any) => message.error(e.message))
      .finally(() => setLoading(false));
  }, [kind, from, to]);

  const current = useMemo(() => meta.find((m) => m.kind === kind), [meta, kind]);

  // 按 group 归并成下拉分组
  const options = useMemo(() => {
    const groups = new Map<string, any[]>();
    for (const m of meta) {
      if (!groups.has(m.group)) groups.set(m.group, []);
      groups.get(m.group)!.push(m);
    }
    return [...groups.entries()].map(([g, list]) => ({
      label: g,
      options: list.map((m) => ({ value: m.kind, label: m.name })),
    }));
  }, [meta]);

  const sums = useMemo(() => {
    const out: Record<string, number> = {};
    for (const c of data.columns) {
      const vals = data.rows
        .map((r) => Number((r as any)[c.key]))
        .filter((n) => Number.isFinite(n));
      if (vals.length === 0) continue;
      out[c.key] = vals.reduce((s, n) => s + n, 0);
    }
    return out;
  }, [data]);

  return (
    <Card
      title="报表中心"
      extra={
        <Space wrap>
          <Select
            style={{ width: 260 }}
            value={kind}
            onChange={setKind}
            options={options}
            placeholder="选择报表"
          />
          <DatePicker
            placeholder="开始日期"
            value={dayVal(from)}
            onChange={(d) => setFrom(d ? d.format('YYYY-MM-DD') : '')}
          />
          <DatePicker
            placeholder="结束日期"
            value={dayVal(to)}
            onChange={(d) => setTo(d ? d.format('YYYY-MM-DD') : '')}
          />
          <Button onClick={() => { setFrom(''); setTo(''); }}>重置日期</Button>
          <Button
            type="primary"
            disabled={data.rows.length === 0}
            onClick={() =>
              exportCsv(
                `${data.meta?.name ?? '报表'}_${today()}`,
                (data.columns ?? []).map((c) => ({ title: c.title, key: c.key })),
                data.rows ?? [],
              )
            }
          >
            导出 CSV
          </Button>
        </Space>
      }
    >
      {current && (
        <div style={{ marginBottom: 12, color: '#666' }}>
          当前报表：<strong>{current.name}</strong>
          {data.meta?.from || data.meta?.to ? `　统计区间：${data.meta.from || '不限'} ~ ${data.meta.to || '不限'}` : '　统计区间：全部'}
          　共 {data.rows.length} 行
        </div>
      )}

      <Row gutter={12} style={{ marginBottom: 12 }}>
        {Object.entries(sums)
          .slice(0, 4)
          .map(([k, v]) => {
            const col = data.columns.find((c) => c.key === k);
            return (
              <Col key={k}>
                <Card size="small" style={{ minWidth: 140 }}>
                  <div style={{ fontSize: 12, color: '#888' }}>{col?.title} 合计</div>
                  <div style={{ fontSize: 18, fontWeight: 600 }}>
                    {Math.round(v * 100) / 100}
                  </div>
                </Card>
              </Col>
            );
          })}
      </Row>

      <ResponsiveTable
        size="small"
        rowKey={(_r, i) => String(i)}
        loading={loading}
        dataSource={data.rows}
        scroll={{ x: 1000, y: 460 }}
        pagination={{ pageSize: 50, showSizeChanger: true }}
        columns={(data.columns ?? []).map((c) => ({
          title: c.title,
          dataIndex: c.key,
          key: c.key,
          width: c.width,
          align: c.align,
          className: c.align === 'right' ? 'mono' : undefined,
        }))}
        summary={() => (
          <Table.Summary fixed>
            <Table.Summary.Row>
              {(data.columns ?? []).map((c, i) => (
                <Table.Summary.Cell key={c.key} index={i} align={c.align}>
                  {i === 0 ? <strong>合计</strong> : sums[c.key] !== undefined ? <strong>{Math.round(sums[c.key] * 100) / 100}</strong> : null}
                </Table.Summary.Cell>
              ))}
            </Table.Summary.Row>
          </Table.Summary>
        )}
      />
    </Card>
  );
}
