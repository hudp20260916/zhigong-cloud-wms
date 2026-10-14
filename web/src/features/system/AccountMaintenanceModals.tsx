import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Empty,
  Input,
  List,
  Space,
  Table,
  Tag,
  Typography,
  message,
} from 'antd';
import {
  ExclamationCircleFilled,
  SafetyCertificateOutlined,
} from '@ant-design/icons';
import { systemApi } from '../../api';
import { Modal } from '../../components';

/**
 * 用户管理的高危维护弹窗：账号初始化 / 编号重号修复 / 备份与恢复。
 *
 * 交互约定（三个弹窗共用一套三连确认）：
 *   ① 看清单 —— 先把「会被影响的是哪些」摆出来，不点任何按钮看不到输入框；
 *   ② 输密码 —— 当前登录账号的密码，服务端 bcrypt 校验（前端只判非空，真正的校验在服务端）；
 *   ③ 输确认文字 —— 服务端再校验一次，防脚本直接打接口。
 * 这三个缺一不可，少一步就等于把「删除账号」的门槛降到点击级别。
 */

/** 密码 + 确认文字输入区。三个高危弹窗共用，保证交互与文案一致 */
function SafetyForm({
  confirmText,
  confirmHint,
  password,
  text,
  onPassword,
  onText,
  disabled,
}: {
  confirmText: string;
  confirmHint: string;
  password: string;
  text: string;
  onPassword: (v: string) => void;
  onText: (v: string) => void;
  disabled?: boolean;
}) {
  return (
    <>
      <Alert
        type="info"
        showIcon
        icon={<SafetyCertificateOutlined />}
        style={{ marginBottom: 12 }}
        message="身份核验"
        description="请输入「当前登录账号」的密码进行二次校验，服务端会再次比对后才执行。"
      />
      <Input.Password
        value={password}
        disabled={disabled}
        placeholder="当前登录账号的密码"
        onChange={(e) => onPassword(e.target.value)}
        style={{ marginBottom: 12 }}
      />
      <Typography.Paragraph style={{ marginBottom: 4, fontSize: 13 }}>
        请输入 <Typography.Text strong code>{confirmText}</Typography.Text> 以继续：
      </Typography.Paragraph>
      <Input
        value={text}
        disabled={disabled}
        placeholder={confirmText}
        onChange={(e) => onText(e.target.value)}
      />
      <div style={{ marginTop: 4, color: '#888', fontSize: 12 }}>{confirmHint}</div>
    </>
  );
}

function reset(setters: ((v: string) => void)[]) {
  for (const s of setters) s('');
}

// ---------------------------------------------------------------- 账号初始化

export function AccountInitModal({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const [preview, setPreview] = useState<any>(null);
  const [password, setPassword] = useState('');
  const [text, setText] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(() => {
    systemApi
      .initPreview()
      .then(setPreview)
      .catch((e: any) => message.error(e.message));
  }, []);

  useEffect(() => {
    if (!open) return;
    load();
    reset([setPassword, setText]);
  }, [open, load]);

  const okReady = password.trim().length > 0 && text.trim() === (preview?.confirmText ?? '初始化账号');

  async function execute() {
    setSubmitting(true);
    try {
      const r = await systemApi.init(password, text);
      Modal.success({
        title: '账号初始化完成',
        content: `已清理 ${r.removed?.length ?? 0} 个账号${r.disabled?.length ? `，另有 ${r.disabled.length} 个被单据引用的账号改为停用` : ''}；内置 ${r.kept} 个账号完整保留，编号序列已重置，新账号从 ${r.seq?.nextNo} 开始。执行前已自动备份（备份 #${r.backupId}），可从「备份与恢复」回滚。`,
        onOk: () => {
          onClose();
          onDone();
        },
      });
    } catch (e: any) {
      message.error(e.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal open={open} title="账号初始化" onCancel={onClose} destroyOnClose={false} width={640} footer={null}>
      {!preview ? (
        <Empty description="正在加载…" />
      ) : (
        <>
          <Alert
            type="error"
            showIcon
            icon={<ExclamationCircleFilled />}
            style={{ marginBottom: 12 }}
            message="将清理掉所有新建账号，恢复到「仅剩 7 个内置账号」的初始状态"
            description="适用于新客户试用测试结束后清理测试账号。执行前系统会自动备份，可在「备份与恢复」中一键回滚。"
          />
          <List
            size="small"
            header={<Typography.Text strong>内置账号（永远保留）</Typography.Text>}
            dataSource={preview.keep ?? []}
            style={{ maxHeight: 200, overflow: 'auto', marginBottom: 12 }}
            renderItem={(u: any) => (
              <List.Item>
                <Tag color="green">{u.user_no}</Tag>
                {u.username}
                <Typography.Text type="secondary" style={{ marginLeft: 8 }}>
                  {u.display_name}
                </Typography.Text>
              </List.Item>
            )}
          />
          <List
            size="small"
            header={
              <Typography.Text strong type="danger">
                将被清理的账号（{(preview.toRemove ?? []).length} 个）
              </Typography.Text>
            }
            locale={{ emptyText: '没有需要清理的账号' }}
            dataSource={preview.toRemove ?? []}
            style={{ maxHeight: 220, overflow: 'auto', marginBottom: 12 }}
            renderItem={(u: any) => (
              <List.Item>
                <Tag>{u.user_no}</Tag>
                {u.username}
                <Typography.Text type="secondary" style={{ marginLeft: 8 }}>
                  {u.display_name}
                </Typography.Text>
              </List.Item>
            )}
          />
          <div style={{ marginBottom: 12, color: '#888', fontSize: 12 }}>
            编号序列当前到第 {preview.seq?.current} 号，初始化后重置为 {preview.seq?.afterReset}，
            下一个新账号为 {preview.seq?.nextAfterReset}
          </div>
          <SafetyForm
            confirmText={preview.confirmText}
            confirmHint="被历史单据引用的账号不会物理删除，会自动改为停用，以保留「谁做的单」这条审计链。"
            password={password}
            text={text}
            onPassword={setPassword}
            onText={setText}
            disabled={submitting}
          />
          <div style={{ marginTop: 16, textAlign: 'right' }}>
            <Space>
              <Button onClick={onClose} disabled={submitting}>
                取消
              </Button>
              <Button type="primary" danger loading={submitting} disabled={!okReady} onClick={execute}>
                确认初始化
              </Button>
            </Space>
          </div>
        </>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------- 重号检测与修复

export function DuplicateNoModal({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const [data, setData] = useState<any>(null);
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(() => {
    systemApi
      .duplicates()
      .then(setData)
      .catch((e: any) => message.error(e.message));
  }, []);

  useEffect(() => {
    if (!open) return;
    load();
    reset([setPassword]);
  }, [open, load]);

  async function fix() {
    setSubmitting(true);
    try {
      const r = await systemApi.fixDuplicates(password);
      message.success(r.fixed === 0 ? '未发现重号，无需修复' : `已修复 ${r.fixed} 个重号`);
      load();
      onDone();
    } catch (e: any) {
      message.error(e.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal open={open} title="用户编号重号检测" onCancel={onClose} destroyOnClose={false} width={600} footer={null}>
      {!data ? (
        <Empty description="正在检测…" />
      ) : (
        <>
          {data.count === 0 ? (
            <Alert type="success" showIcon message="未发现重复编号" description="当前所有账号的用户编号唯一。" />
          ) : (
            <>
              <Alert
                type="warning"
                showIcon
                style={{ marginBottom: 12 }}
                message={`发现 ${data.count} 组重复编号`}
                description="修复时将保留 id 最小的那条，其余按注册顺序重新分配新编号。"
              />
              <List
                size="small"
                dataSource={data.duplicates ?? []}
                renderItem={(g: any) => (
                  <List.Item>
                    <Tag color="red">{g.user_no}</Tag>
                    <span>× {g.count}</span>
                    <Typography.Text type="secondary" style={{ marginLeft: 8 }}>
                      保留 #{g.keepId}，重排 #{(g.conflictIds ?? []).join('、#')}
                    </Typography.Text>
                  </List.Item>
                )}
              />
              <div style={{ marginTop: 12 }}>
                <Input.Password
                  value={password}
                  placeholder="当前登录账号的密码"
                  onChange={(e) => setPassword(e.target.value)}
                />
              </div>
              <div style={{ marginTop: 16, textAlign: 'right' }}>
                <Space>
                  <Button onClick={onClose} disabled={submitting}>
                    关闭
                  </Button>
                  <Button type="primary" loading={submitting} disabled={!password} onClick={fix}>
                    修复重号
                  </Button>
                </Space>
              </div>
            </>
          )}
        </>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------- 备份与恢复

const KIND_LABEL: Record<string, string> = {
  user_init: '初始化前自动备份',
  pre_restore: '恢复前自动快照',
  manual: '手动备份',
};

export function BackupModal({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const [list, setList] = useState<any[]>([]);
  const [confirmText, setConfirmText] = useState('确认恢复');
  const [target, setTarget] = useState<any>(null);
  const [password, setPassword] = useState('');
  const [text, setText] = useState('');
  const [pwdBackup, setPwdBackup] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(() => {
    systemApi
      .backups()
      .then((d: any) => {
        setList(d.list ?? []);
        setConfirmText(d.confirmText ?? '确认恢复');
      })
      .catch((e: any) => message.error(e.message));
  }, []);

  useEffect(() => {
    if (!open) return;
    load();
    setTarget(null);
    reset([setPassword, setText, setPwdBackup]);
  }, [open, load]);

  async function createBackup() {
    if (!pwdBackup) {
      message.warning('请输入当前登录账号的密码');
      return;
    }
    setSubmitting(true);
    try {
      await systemApi.createBackup(pwdBackup, '手动备份');
      message.success('备份已创建');
      reset([setPwdBackup]);
      load();
    } catch (e: any) {
      message.error(e.message);
    } finally {
      setSubmitting(false);
    }
  }

  async function restore() {
    if (!target) return;
    setSubmitting(true);
    try {
      const r = await systemApi.restoreBackup(target.id, password, text);
      Modal.success({
        title: '已回滚到该备份点',
        content: `恢复前已再次自动备份当前数据（备份 #${r.safetyBackupId}），需要的话可以继续回退。`,
        onOk: () => {
          setTarget(null);
          reset([setPassword, setText]);
          load();
          onDone();
        },
      });
    } catch (e: any) {
      message.error(e.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal open={open} title="备份与恢复" onCancel={onClose} destroyOnClose={false} width={820} footer={null}>
      <Alert
        type="warning"
        showIcon
        style={{ marginBottom: 12 }}
        message="恢复会用备份点的账号数据整体替换当前账号数据"
        description="执行前系统会先把「现在的状态」存一份快照，因此恢复错了还能再退回来；所有操作都写进审计日志。"
      />

      <Space style={{ marginBottom: 12 }} align="center">
        <Input.Password
          value={pwdBackup}
          placeholder="当前登录账号的密码"
          style={{ width: 240 }}
          onChange={(e) => setPwdBackup(e.target.value)}
        />
        <Button loading={submitting} onClick={createBackup}>
          立即备份当前数据
        </Button>
      </Space>

      <Table
        size="small"
        rowKey="id"
        dataSource={list}
        pagination={{ pageSize: 5 }}
        columns={[
          { title: '备份点', dataIndex: 'id', width: 70, render: (v) => `#${v}` },
          {
            title: '来源',
            dataIndex: 'kind',
            width: 160,
            render: (v) => <Tag color={v === 'manual' ? 'blue' : 'gold'}>{KIND_LABEL[v] ?? v}</Tag>,
          },
          {
            title: '时间',
            dataIndex: 'createdAt',
            width: 170,
            render: (v) => String(v).slice(0, 19).replace('T', ' '),
          },
          { title: '操作人', dataIndex: 'operatorName', width: 120 },
          {
            title: '账号数',
            dataIndex: 'rowCounts',
            width: 90,
            render: (v: any) => v?.users ?? '-',
          },
          {
            title: '大小',
            dataIndex: 'sizeBytes',
            width: 100,
            render: (v: number) => `${(v / 1024).toFixed(1)} KB`,
          },
          {
            title: '文件',
            dataIndex: 'fileName',
            render: (v: string) => <Typography.Text className="mono">{v}</Typography.Text>,
          },
          {
            title: '状态',
            dataIndex: 'restorable',
            width: 120,
            render: (okFlag: boolean, row: any) =>
              row.restoredAt ? (
                <Tag>已回滚</Tag>
              ) : okFlag ? (
                <Tag color="green">可回滚</Tag>
              ) : (
                <Tag color="red">不可回滚</Tag>
              ),
          },
          {
            title: '操作',
            width: 90,
            render: (_: any, row: any) => (
              <Button size="small" danger disabled={!row.restorable} onClick={() => setTarget(row)}>
                恢复
              </Button>
            ),
          },
        ]}
      />

      <Modal
        open={!!target}
        title={`确认恢复到备份点 #${target?.id}`}
        onCancel={() => setTarget(null)}
        footer={null}
        destroyOnClose={false}
        width={560}
      >
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 12 }}
          message={`备份时间：${String(target?.createdAt ?? '').slice(0, 19).replace('T', ' ')}（${target?.operatorName ?? '未知'}）`}
          description={`该备份点含 ${target?.rowCounts?.users ?? '-'} 个账号。当前账号数据将被整体替换，操作前会自动再存一份快照。`}
        />
        <SafetyForm
          confirmText={confirmText}
          confirmHint="确认后无法撤销到「恢复后的状态」，但你仍能回到执行前自动生成的那份快照。"
          password={password}
          text={text}
          onPassword={setPassword}
          onText={setText}
          disabled={submitting}
        />
        <div style={{ marginTop: 16, textAlign: 'right' }}>
          <Space>
            <Button onClick={() => setTarget(null)} disabled={submitting}>
              取消
            </Button>
            <Button
              type="primary"
              danger
              loading={submitting}
              disabled={!password || text.trim() !== confirmText}
              onClick={restore}
            >
              确认恢复
            </Button>
          </Space>
        </div>
      </Modal>
    </Modal>
  );
}
