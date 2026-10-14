import { useEffect, useState } from 'react';
import { Alert, Button, Card, Checkbox, Input, List, Space, Tag, Typography, message } from 'antd';
import { ExclamationCircleFilled } from '@ant-design/icons';
import { api } from '../../api/client';
import { PermPage, Modal } from '../../components';

const CONFIRM_TEXT = '确认清空';

/**
 * 系统初始化。
 * 两级确认：勾选范围 -> 输入「确认清空」。
 * 服务端会再校验一次确认文字（前端校验可绕过），并且整批删表在一个事务里完成。
 */
export default function SystemInitPage() {
  return (
    <PermPage permission="system.init.execute">
      <SystemInitInner />
    </PermPage>
  );
}

function SystemInitInner() {
  const [preview, setPreview] = useState<any>(null);
  const [groups, setGroups] = useState<string[]>(['biz']);
  const [clearStock, setClearStock] = useState(true);
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const load = () =>
    api
      .get<any>('/system/init/preview')
      .then(setPreview)
      .catch((e: any) => message.error(e.message));

  useEffect(() => {
    load();
  }, []);

  const okText = text.trim() === CONFIRM_TEXT;

  async function execute() {
    setSubmitting(true);
    try {
      const r = await api.post<any>('/system/init/execute', {
        groups,
        clearStock,
        confirmText: text,
      });
      Modal.success({
        title: '系统初始化完成',
        content: `共删除 ${r.deletedRows} 行数据${clearStock ? '，库存余额已清零' : ''}。单据编号序列保留，新建单据的编号继续递增。`,
        onOk: () => {
          setOpen(false);
          setText('');
          load();
        },
      });
    } catch (e: any) {
      message.error(e.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card title="系统初始化">
      <Alert
        type="error"
        showIcon
        icon={<ExclamationCircleFilled />}
        style={{ marginBottom: 16 }}
        message="危险操作：清空数据后不可恢复"
        description="请在正式启用系统前执行。执行后业务单据与库存流水将被永久删除，建议先导出需要保留的数据。"
      />

      {preview && (
        <>
          <Space direction="vertical" style={{ width: '100%', marginBottom: 16 }}>
            {preview.groups.map((g: any) => (
              <Card size="small" key={g.value} title={`${g.label}（${g.total} 条记录）`}>
                {g.detail.length === 0 ? (
                  <span style={{ color: '#999' }}>无数据</span>
                ) : (
                  <Space size={[4, 4]} wrap>
                    {g.detail.map((d: any) => (
                      <Tag key={d.table}>
                        {d.table} · {d.count}
                      </Tag>
                    ))}
                  </Space>
                )}
              </Card>
            ))}
          </Space>

          <Card size="small" title="以下内容不会被清空">
            <List
              size="small"
              dataSource={preview.keep ?? []}
              renderItem={(k: string) => (
                <List.Item>
                  <Tag color="green">{k}</Tag>
                </List.Item>
              )}
            />
          </Card>
        </>
      )}

      <Card size="small" title="清空范围" style={{ marginTop: 16 }}>
        <Checkbox.Group
          value={groups}
          onChange={(v) => setGroups(v as string[])}
          options={[
            { value: 'biz', label: '业务单据（订单 / 出入库 / 生产 / 结算 / 盘点）' },
            { value: 'archive', label: '基础档案（物料 / 成品 / 供应商 / 客户 / BOM）' },
          ]}
        />
        <div style={{ marginTop: 12 }}>
          <Checkbox checked={clearStock} onChange={(e) => setClearStock(e.target.checked)}>
            同时将库存余额清零
          </Checkbox>
        </div>
      </Card>

      <Space style={{ marginTop: 16 }}>
        <Button danger onClick={() => { setText(''); setOpen(true); }}>
          执行系统初始化
        </Button>
      </Space>

      <Modal
        open={open}
        title="确认执行系统初始化"
        onCancel={() => setOpen(false)}
        footer={null}
        destroyOnClose
      >
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 12 }}
          message={`即将清空：${groups.map((g) => (g === 'biz' ? '业务单据' : '基础档案')).join('、') || '（未选择）'}`}
          description="该操作不可撤销，请确认已备份需要保留的数据。"
        />
        <Typography.Paragraph>
          请输入 <Typography.Text strong code>{CONFIRM_TEXT}</Typography.Text> 以继续：
        </Typography.Paragraph>
        <Input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={CONFIRM_TEXT}
          onPressEnter={() => okText && execute()}
        />
        <div style={{ marginTop: 16, textAlign: 'right' }}>
          <Space>
            <Button onClick={() => setOpen(false)}>取消</Button>
            <Button type="primary" danger disabled={!okText} loading={submitting} onClick={execute}>
              确认清空
            </Button>
          </Space>
        </div>
      </Modal>
    </Card>
  );
}
