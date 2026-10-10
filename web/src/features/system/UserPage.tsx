import { useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Table,
  Tag,
  Typography,
  message,
} from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { systemApi } from '../../api';
import { useList } from '../../hooks/useList';
import { PermPage, ResponsiveTable, DockAction } from '../../components';
import { ROLE_LABEL } from '@shared/permissions';

/** 密码强度校验：与服务端规则保持一致（字母 + 数字，至少 8 位） */
function passwordIssues(pwd: string): string[] {
  const issues: string[] = [];
  if (pwd.length < 8) issues.push('长度至少 8 位');
  if (!/[A-Za-z]/.test(pwd)) issues.push('需包含字母');
  if (!/\d/.test(pwd)) issues.push('需包含数字');
  return issues;
}

export default function UserPage() {
  const { list, total, loading, params, patchParams, reload } = useList<any>((p) => systemApi.users(p));
  const [roles, setRoles] = useState<any[]>([]);
  const [userOpen, setUserOpen] = useState(false);
  const [editing, setEditing] = useState<any>(null);
  const [userForm] = Form.useForm();

  const [pwdOpen, setPwdOpen] = useState(false);
  const [pwdTarget, setPwdTarget] = useState<any>(null);
  const [pwdForm] = Form.useForm();
  const [newPwd, setNewPwd] = useState('');

  useEffect(() => {
    systemApi
      .roles()
      .then(setRoles)
      .catch(() => undefined);
  }, []);

  function openCreate() {
    setEditing(null);
    userForm.resetFields();
    userForm.setFieldsValue({ role: 'viewer', status: 'active' });
    setUserOpen(true);
  }

  function openEdit(row: any) {
    setEditing(row);
    userForm.setFieldsValue({
      username: row.username,
      displayName: row.display_name,
      role: row.role,
      status: row.status,
    });
    setUserOpen(true);
  }

  async function submitUser() {
    const v = await userForm.validateFields();
    try {
      if (editing) {
        await systemApi.updateUser(editing.id, v);
        message.success('账号已更新');
      } else {
        await systemApi.createUser(v);
        message.success('账号已创建');
      }
      setUserOpen(false);
      reload();
    } catch (e: any) {
      message.error(e.message);
    }
  }

  async function submitPassword() {
    const v = await pwdForm.validateFields();
    try {
      const res = await systemApi.changePassword(pwdTarget.id, v.newPassword, v.confirmPassword);
      message.success(
        res?.kicked ? '密码已修改，该账号在线会话已被强制注销' : '密码已修改',
      );
      setPwdOpen(false);
      pwdForm.resetFields();
      setNewPwd('');
      reload();
    } catch (e: any) {
      message.error(e.message);
    }
  }

  const issues = passwordIssues(newPwd);

  return (
    <PermPage permission="system.user.manage">
      <Card
        title="用户管理"
        extra={
          <Space>
            <Input.Search
              placeholder="账号 / 姓名"
              allowClear
              style={{ width: 220 }}
              onSearch={(keyword) => patchParams({ keyword })}
            />
            <DockAction icon={<PlusOutlined />} onClick={openCreate}>新增账号</DockAction>
          </Space>
        }
      >
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message="全系统账号密码由管理员统一维护，普通账号无个人密码修改权限。修改密码后该账号的在线会话立即失效并被强制重新登录。"
        />
        <ResponsiveTable
          rowKey="id"
          size="small"
          loading={loading}
          dataSource={list}
          pagination={{
            current: params.page,
            pageSize: params.pageSize,
            total,
            onChange: (page, pageSize) => patchParams({ page, pageSize }),
          }}
          columns={[
            { title: '账号', dataIndex: 'username', width: 140 },
            { title: '姓名', dataIndex: 'display_name', width: 140 },
            {
              title: '角色',
              dataIndex: 'role',
              width: 120,
              render: (v) => <Tag color="blue">{ROLE_LABEL[v as keyof typeof ROLE_LABEL] ?? v}</Tag>,
            },
            {
              title: '状态',
              dataIndex: 'status',
              width: 90,
              render: (v) => (v === 'active' ? <Tag color="green">启用</Tag> : <Tag>停用</Tag>),
            },
            { title: '会话版本', dataIndex: 'session_version', width: 100, className: 'mono' },
            { title: '创建时间', dataIndex: 'created_at', width: 170, render: (v) => String(v).slice(0, 19).replace('T', ' ') },
            {
              title: '操作',
              width: 160,
              render: (_, r) => (
                <Space size={0}>
                  <Button type="link" size="small" onClick={() => openEdit(r)}>
                    编辑
                  </Button>
                  <Button
                    type="link"
                    size="small"
                    onClick={() => {
                      setPwdTarget(r);
                      pwdForm.resetFields();
                      setNewPwd('');
                      setPwdOpen(true);
                    }}
                  >
                    修改密码
                  </Button>
                </Space>
              ),
            },
          ]}
        />
      </Card>

      <Modal open={userOpen} title={editing ? '编辑账号' : '新增账号'} onCancel={() => setUserOpen(false)} onOk={submitUser} destroyOnClose>
        <Form form={userForm} layout="vertical" preserve={false}>
          <Form.Item name="username" label="登录账号" rules={[{ required: true, message: '请输入账号' }]}>
            <Input disabled={!!editing} />
          </Form.Item>
          <Form.Item name="displayName" label="姓名" rules={[{ required: true, message: '请输入姓名' }]}>
            <Input />
          </Form.Item>
          <Form.Item name="role" label="角色" rules={[{ required: true }]}>
            <Select options={roles.map((r) => ({ value: r.value, label: r.label }))} />
          </Form.Item>
          <Form.Item name="status" label="状态" rules={[{ required: true }]}>
            <Select
              options={[
                { value: 'active', label: '启用' },
                { value: 'disabled', label: '停用' },
              ]}
            />
          </Form.Item>
          {!editing && (
            <Form.Item name="password" label="初始密码">
              <Input placeholder="留空默认 12345678，需满足字母+数字且不少于 8 位" />
            </Form.Item>
          )}
        </Form>
      </Modal>

      <Modal
        open={pwdOpen}
        title={`修改密码 · ${pwdTarget?.display_name ?? ''}（${pwdTarget?.username ?? ''}）`}
        onCancel={() => setPwdOpen(false)}
        onOk={submitPassword}
        destroyOnClose
      >
        <Form form={pwdForm} layout="vertical" preserve={false}>
          <Form.Item
            name="newPassword"
            label="新密码"
            rules={[{ required: true, message: '请输入新密码' }]}
          >
            <Input.Password onChange={(e) => setNewPwd(e.target.value)} />
          </Form.Item>
          <Form.Item
            name="confirmPassword"
            label="确认新密码"
            dependencies={['newPassword']}
            rules={[
              { required: true, message: '请再次输入新密码' },
              ({ getFieldValue }) => ({
                validator(_, value) {
                  if (!value || getFieldValue('newPassword') === value) return Promise.resolve();
                  return Promise.reject(new Error('两次输入的密码不一致'));
                },
              }),
            ]}
          >
            <Input.Password />
          </Form.Item>
        </Form>
        {newPwd && (
          <Typography.Paragraph style={{ marginBottom: 0 }}>
            {issues.length === 0 ? (
              <Tag color="success">密码强度符合要求</Tag>
            ) : (
              <Tag color="error">密码强度不足：{issues.join('、')}</Tag>
            )}
          </Typography.Paragraph>
        )}
        <div style={{ marginTop: 8, color: '#8c8c8c', fontSize: 12 }}>
          保存后旧密码立即失效；若该账号当前在线，将被强制踢出并要求重新登录。
        </div>
      </Modal>
    </PermPage>
  );
}
