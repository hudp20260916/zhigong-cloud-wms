import { useState } from 'react';
import { Button, Card, Form, Input, Modal, Popconfirm, Space, Table, message } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { archiveApi } from '../../api';
import { useList } from '../../hooks/useList';
import { PermGate, ResponsiveTable, DockAction } from '../../components';

interface Partner {
  id: number;
  code: string;
  name: string;
  contact?: string;
  phone?: string;
  remark?: string;
}

export default function PartnerPage({ kind }: { kind: 'supplier' | 'customer' }) {
  const isSupplier = kind === 'supplier';
  const label = isSupplier ? '供应商' : '客户';

  const { list, total, loading, params, patchParams, reload } = useList<Partner>((p) =>
    isSupplier ? archiveApi.suppliers(p) : archiveApi.customers(p),
  );

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Partner | null>(null);
  const [form] = Form.useForm();

  function openCreate() {
    setEditing(null);
    form.resetFields();
    setOpen(true);
  }

  function openEdit(row: Partner) {
    setEditing(row);
    form.setFieldsValue(row);
    setOpen(true);
  }

  async function submit() {
    const v = await form.validateFields();
    try {
      if (editing) {
        if (isSupplier) await archiveApi.updateSupplier(editing.id, v);
        else await archiveApi.updateCustomer(editing.id, v);
        message.success(`${label}已更新`);
      } else {
        if (isSupplier) await archiveApi.createSupplier(v);
        else await archiveApi.createCustomer(v);
        message.success(`${label}已创建`);
      }
      setOpen(false);
      reload();
    } catch (e: any) {
      message.error(e.message);
    }
  }

  return (
    <Card
      title={`${label}档案`}
      extra={
        <Space>
          <Input.Search
            placeholder="编码 / 名称 / 电话"
            allowClear
            style={{ width: 220 }}
            onSearch={(keyword) => patchParams({ keyword })}
          />
          <PermGate permission="archive.partner.manage">
            <DockAction icon={<PlusOutlined />} onClick={openCreate}>新增{label}</DockAction>
          </PermGate>
        </Space>
      }
    >
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
          { title: `${label}编码`, dataIndex: 'code', width: 140 },
          { title: `${label}名称`, dataIndex: 'name' },
          { title: '联系人', dataIndex: 'contact', width: 120 },
          { title: '联系电话', dataIndex: 'phone', width: 150 },
          { title: '备注', dataIndex: 'remark' },
          {
            title: '操作',
            width: 130,
            render: (_, r) => (
              <PermGate permission="archive.partner.manage">
                <Space size={0}>
                  <Button type="link" size="small" onClick={() => openEdit(r)}>
                    编辑
                  </Button>
                  <Popconfirm
                    title={`确认删除该${label}？`}
                    onConfirm={async () => {
                      try {
                        if (isSupplier) await archiveApi.deleteSupplier(r.id);
                        else await archiveApi.deleteCustomer(r.id);
                        message.success('已删除');
                        reload();
                      } catch (e: any) {
                        message.error(e.message);
                      }
                    }}
                  >
                    <Button type="link" size="small" danger>
                      删除
                    </Button>
                  </Popconfirm>
                </Space>
              </PermGate>
            ),
          },
        ]}
      />

      <Modal
        open={open}
        title={editing ? `编辑${label}` : `新增${label}`}
        onCancel={() => setOpen(false)}
        onOk={submit}
        destroyOnClose
      >
        <Form form={form} layout="vertical" preserve={false}>
          <Form.Item name="code" label={`${label}编码`}>
            <Input placeholder="留空自动生成" />
          </Form.Item>
          <Form.Item name="name" label={`${label}名称`} rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="contact" label="联系人">
            <Input />
          </Form.Item>
          <Form.Item name="phone" label="联系电话">
            <Input />
          </Form.Item>
          <Form.Item name="remark" label="备注">
            <Input.TextArea rows={2} />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}
