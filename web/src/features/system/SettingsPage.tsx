import { useEffect, useMemo, useState } from 'react';
import { Button, Card, Col, Divider, Input, InputNumber, Row, Space, Tag, message } from 'antd';
import { api } from '../../api/client';
import { PermPage } from '../../components';

interface SettingItem {
  key: string;
  label: string;
  group: string;
  type: 'number' | 'text';
  min?: number;
  max?: number;
  suffix?: string;
  hint: string;
  value: string;
}

/** 系统参数：预警阈值 + 企业信息（打印抬头） */
export default function SettingsPage() {
  return (
    <PermPage permission="system.view">
      <SettingsInner />
    </PermPage>
  );
}

function SettingsInner() {
  const [items, setItems] = useState<SettingItem[]>([]);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const load = () =>
    api
      .get<SettingItem[]>('/system/settings')
      .then((list) => {
        setItems(list);
        setDraft(Object.fromEntries(list.map((i) => [i.key, i.value])));
      })
      .catch((e: any) => message.error(e.message));

  useEffect(() => {
    load();
  }, []);

  const groups = useMemo(() => {
    const m = new Map<string, SettingItem[]>();
    for (const i of items) {
      if (!m.has(i.group)) m.set(i.group, []);
      m.get(i.group)!.push(i);
    }
    return [...m.entries()];
  }, [items]);

  const changed = useMemo(
    () => items.filter((i) => draft[i.key] !== i.value),
    [items, draft],
  );

  async function save() {
    if (changed.length === 0) return;
    setSaving(true);
    try {
      await api.put('/system/settings', {
        items: changed.map((i) => ({ key: i.key, value: draft[i.key] })),
      });
      message.success('已保存，预警看板立即生效');
      load();
    } catch (e: any) {
      message.error(e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card
      title="系统参数"
      extra={
        <Space>
          {changed.length > 0 && <Tag color="orange">{changed.length} 项待保存</Tag>}
          <Button type="primary" disabled={changed.length === 0} loading={saving} onClick={save}>
            保存修改
          </Button>
        </Space>
      }
    >
      {groups.map(([g, list]) => (
        <div key={g}>
          <Divider orientation="left" plain>
            {g}
          </Divider>
          <Row gutter={[16, 16]}>
            {list.map((s) => (
              <Col xs={24} sm={12} key={s.key}>
                <Card size="small" title={s.label}>
                  {s.type === 'number' ? (
                    <InputNumber
                      style={{ width: 200 }}
                      min={s.min}
                      max={s.max}
                      addonAfter={s.suffix}
                      value={Number(draft[s.key] ?? 0)}
                      onChange={(v) =>
                        setDraft((prev) => ({ ...prev, [s.key]: String(v ?? 0) }))
                      }
                    />
                  ) : (
                    <Input
                      style={{ width: 320 }}
                      value={draft[s.key] ?? ''}
                      onChange={(e) => setDraft((prev) => ({ ...prev, [s.key]: e.target.value }))}
                    />
                  )}
                  <div style={{ marginTop: 6, color: '#888', fontSize: 12 }}>{s.hint}</div>
                </Card>
              </Col>
            ))}
          </Row>
        </div>
      ))}
    </Card>
  );
}
