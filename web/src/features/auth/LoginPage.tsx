import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Alert, Button, Card, Form, Input, Typography, message } from 'antd';
import { LockOutlined, UserOutlined } from '@ant-design/icons';
import { useAuthStore } from '../../stores/auth';

export default function LoginPage() {
  const [loading, setLoading] = useState(false);
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const login = useAuthStore((s) => s.login);

  async function onFinish(values: { username: string; password: string }) {
    setLoading(true);
    try {
      await login(values.username, values.password);
      message.success('登录成功');
      navigate('/dashboard', { replace: true });
    } catch (e: any) {
      message.error(e?.message ?? '登录失败');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div
      style={{
        height: '100%',
        display: 'grid',
        placeItems: 'center',
        background: 'linear-gradient(180deg,#f5f7fa 0%,#e8eef7 100%)',
      }}
    >
      <Card style={{ width: 380 }} styles={{ body: { padding: 28 } }}>
        <Typography.Title level={4} style={{ marginBottom: 4 }}>
          智工云仓
        </Typography.Title>
        <Typography.Text type="secondary">小家电生产组装进销存管理系统</Typography.Text>

        {params.get('expired') === '1' && (
          <Alert
            style={{ marginTop: 16 }}
            type="warning"
            showIcon
            message="登录状态已失效"
            description="密码可能已被管理员修改，请使用新密码重新登录。"
          />
        )}

        <Form layout="vertical" style={{ marginTop: 20 }} onFinish={onFinish} initialValues={{ username: 'admin' }}>
          <Form.Item name="username" label="账号" rules={[{ required: true, message: '请输入账号' }]}>
            <Input prefix={<UserOutlined />} placeholder="请输入账号" autoFocus />
          </Form.Item>
          <Form.Item name="password" label="密码" rules={[{ required: true, message: '请输入密码' }]}>
            <Input.Password prefix={<LockOutlined />} placeholder="请输入密码" />
          </Form.Item>
          <Button type="primary" htmlType="submit" block loading={loading}>
            登录
          </Button>
        </Form>

        <Typography.Paragraph type="secondary" style={{ marginTop: 16, fontSize: 12, marginBottom: 0 }}>
          演示账号：admin / admin12345（管理员）、purchaser（采购）、warehouse（库管）、viewer（查询）
        </Typography.Paragraph>
      </Card>
    </div>
  );
}
