import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Col,
  Divider,
  Input,
  InputNumber,
  Row,
  Space,
  Tag,
  Typography,
  message,
} from 'antd';
import { CloudDownloadOutlined, DatabaseOutlined, FileExcelOutlined } from '@ant-design/icons';
import * as XLSX from 'xlsx';
import { api } from '../../api/client';
import { backupApi } from '../../api';
import { PermPage, PermGate } from '../../components';

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
  default?: string;
  /** 需求 29：单据编号组返回下一张单号预览 */
  preview?: string;
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
      message.success('已保存，预警看板与新单号立即生效');
      load();
    } catch (e: any) {
      message.error(e.message);
    } finally {
      setSaving(false);
    }
  }

  // 需求 30：备份所有模块数据
  const [backupInfo, setBackupInfo] = useState<any>(null);
  const [backing, setBacking] = useState(false);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    backupApi
      .tables()
      .then(setBackupInfo)
      .catch(() => setBackupInfo(null));
  }, []);

  async function downloadDb() {
    setBacking(true);
    try {
      await backupApi.downloadDb();
      message.success('数据库备份已下载');
    } catch (e: any) {
      message.error(e.message);
    } finally {
      setBacking(false);
    }
  }

  /** 导出全模块 Excel：每个数据表一个 Sheet，方便人工核对 */
  async function exportAllSheets() {
    setExporting(true);
    try {
      const data = await backupApi.exportAll();
      const wb = XLSX.utils.book_new();
      for (const t of data.tables ?? []) {
        const sheetName = String(t.table).slice(0, 31);
        const aoa: any[][] = [t.columns ?? []];
        for (const r of t.rows ?? []) aoa.push((t.columns ?? []).map((c: string) => r[c]));
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), sheetName);
      }
      const stamp = String(data.at ?? '').slice(0, 19).replace(/[-:T]/g, '');
      XLSX.writeFile(wb, `全模块数据备份_${stamp || Date.now()}.xlsx`);
      message.success(`已导出 ${data.tables?.length ?? 0} 张数据表`);
    } catch (e: any) {
      message.error(e.message);
    } finally {
      setExporting(false);
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
                  {/* 需求 29：实时预览该类型下一张单号 */}
                  {s.preview && (
                    <div style={{ marginTop: 4, fontSize: 12 }}>
                      下一张单号：<Typography.Text className="mono" strong>{s.preview}</Typography.Text>
                    </div>
                  )}
                </Card>
              </Col>
            ))}
          </Row>
        </div>
      ))}

      {/* 需求 30：备份所有模块数据 */}
      <Divider orientation="left" plain>
        数据备份
      </Divider>
      <PermGate permission="system.init.execute">
        <Card size="small">
          <Space wrap>
            <Button
              type="primary"
              icon={<DatabaseOutlined />}
              loading={backing}
              onClick={downloadDb}
            >
              下载数据库备份
            </Button>
            <Button icon={<FileExcelOutlined />} loading={exporting} onClick={exportAllSheets}>
              导出全模块 Excel
            </Button>
            <Button
              icon={<CloudDownloadOutlined />}
              onClick={() => backupApi.tables().then(setBackupInfo).catch((e: any) => message.error(e.message))}
            >
              刷新统计
            </Button>
          </Space>
          <Alert
            type="info"
            showIcon
            style={{ marginTop: 12 }}
            message={
              backupInfo
                ? `当前共 ${backupInfo.tableCount} 张数据表、${backupInfo.rowCount} 条记录`
                : '正在统计数据量…'
            }
            description="「数据库备份」生成整库快照文件，可原样还原；「全模块 Excel」把每张数据表导出为一个 Sheet，便于人工核对。两者都只读取当前数据，不影响业务。"
          />
        </Card>
      </PermGate>
    </Card>
  );
}
