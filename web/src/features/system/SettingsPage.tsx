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
import { CloudDownloadOutlined, DatabaseOutlined, FileExcelOutlined, SafetyCertificateOutlined } from '@ant-design/icons';
import * as XLSX from 'xlsx';
import { api } from '../../api/client';
import { backupApi, systemApi } from '../../api';
import { refreshBrandName } from '../../brand';
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
      // 公司名称改动立即同步到浏览器标题 / 登录页 / 侧边栏（brandStore 全局订阅）
      await refreshBrandName();
      message.success('已保存，预警看板、单号规则与品牌名立即生效');
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
                  {/* 公司名称：实时预览保存后的全站生效值（留空回退默认） */}
                  {s.key === 'company.name' && (
                    <div style={{ marginTop: 4, fontSize: 12 }}>
                      保存后全站生效：
                      <Typography.Text strong>
                        {(draft[s.key] ?? '').trim() || '啊平智能（默认）'}
                      </Typography.Text>
                    </div>
                  )}
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

      {/* 授权信息：所有 admin 可见可激活；普通角色不渲染这个区块 */}
      <PermGate permission="system.license.manage">
        <LicenseCard />
      </PermGate>

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

/**
 * 授权信息卡片。
 *
 * 设计要点：
 *  - 状态与激活同屏：管理员看完「还剩几天」直接就能贴激活码，不用去别的页面；
 *  - 机器指纹三分量展示出来，签发激活码时供应商要的就是这三串（可一键复制）；
 *  - 激活失败的信息直接展示 —— 客户最烦的是「激活失败但不说为什么」。
 */
function LicenseCard() {
  const [st, setSt] = useState<any>(null);
  const [key, setKey] = useState('');
  const [activating, setActivating] = useState(false);

  const load = () =>
    systemApi
      .license()
      .then(setSt)
      .catch((e: any) => message.error(e.message));

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function activate() {
    if (!key.trim()) return;
    setActivating(true);
    try {
      const s = await systemApi.activateLicense(key.trim());
      message.success(s.status === 'active' ? '授权已激活' : `授权状态：${s.message}`);
      setKey('');
      setSt(s);
    } catch (e: any) {
      message.error(e.message);
    } finally {
      setActivating(false);
    }
  }

  const STATUS: Record<string, { color: string; text: string }> = {
    active: { color: 'green', text: '已授权' },
    trial: { color: 'blue', text: '试用期' },
    grace: { color: 'orange', text: '宽限期' },
    expired: { color: 'red', text: '已过期（只读）' },
    machine_mismatch: { color: 'red', text: '机器不匹配' },
    invalid: { color: 'red', text: '激活码无效' },
  };

  return (
    <Card
      size="small"
      title={
        <Space>
          <SafetyCertificateOutlined />
          授权信息
          {st && <Tag color={STATUS[st.status]?.color ?? 'default'}>{STATUS[st.status]?.text ?? st.status}</Tag>}
        </Space>
      }
      style={{ marginTop: 16 }}
    >
      {st && (
        <>
          <Space size={[16, 8]} wrap style={{ marginBottom: 12 }}>
            {st.licensee && (
              <Typography.Text>
                授权给：<strong>{st.licensee}</strong>
              </Typography.Text>
            )}
            {st.plan && (
              <Typography.Text>
                版本：
                <Tag color="blue">{st.plan}</Tag>
              </Typography.Text>
            )}
            {st.seats != null && <Typography.Text>账号数上限：{st.seats}</Typography.Text>}
            {st.expireAt && <Typography.Text>到期日：{st.expireAt}</Typography.Text>}
            {st.daysLeft != null && st.daysLeft >= 0 && (
              <Typography.Text type={st.daysLeft <= 7 ? 'warning' : undefined}>
                剩余 {st.daysLeft} 天
              </Typography.Text>
            )}
          </Space>
          <div style={{ color: '#888', fontSize: 12, marginBottom: 12 }}>{st.message}</div>

          <Divider orientation="left" plain style={{ margin: '8px 0' }}>
            本机机器指纹（签发激活码时提供给供应商）
          </Divider>
          <Space direction="vertical" size={4} style={{ width: '100%', marginBottom: 12 }}>
            {(st.fingerprint ?? []).map((h: string, i: number) => (
              <Typography.Text key={i} className="mono" copyable style={{ fontSize: 12 }}>
                组件 {i + 1}：{h}
              </Typography.Text>
            ))}
          </Space>

          <Input.TextArea
            rows={3}
            value={key}
            placeholder="粘贴激活码（形如 xxx.yyy 的一长串）"
            onChange={(e) => setKey(e.target.value)}
          />
          <div style={{ marginTop: 8, textAlign: 'right' }}>
            <Button type="primary" loading={activating} disabled={!key.trim()} onClick={activate}>
              激活
            </Button>
          </div>
        </>
      )}
    </Card>
  );
}
