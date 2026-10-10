import { useEffect, useState } from 'react';
import {
  Button,
  Card,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  message,
} from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { archiveApi } from '../../api';
import { useList } from '../../hooks/useList';
import { PermGate, PriceText, StatusTag, ResponsiveTable, DockAction } from '../../components';
import { exportCsv } from '../../utils/exportCsv';

interface Material {
  id: number;
  code: string;
  name: string;
  spec?: string;
  category?: string;
  unit: string;
  default_supplier_id?: number | null;
  default_supplier_name?: string;
  safety_stock: number;
  current_stock: number;
  avg_cost: number;
  is_virtual: number;
  remark?: string;
}

export default function MaterialPage() {
  const { list, total, loading, params, patchParams, reload } = useList<Material>((p) =>
    archiveApi.materials(p),
  );
  const [suppliers, setSuppliers] = useState<any[]>([]);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Material | null>(null);
  const [form] = Form.useForm();

  useEffect(() => {
    archiveApi
      .supplierOptions()
      .then(setSuppliers)
      .catch(() => undefined);
  }, []);

  function openCreate() {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({ unit: '个', safetyStock: 0, isVirtual: false });
    setOpen(true);
  }

  function openEdit(row: Material) {
    setEditing(row);
    form.setFieldsValue({
      code: row.code,
      name: row.name,
      spec: row.spec,
      category: row.category,
      unit: row.unit,
      defaultSupplierId: row.default_supplier_id ?? undefined,
      safetyStock: row.safety_stock,
      isVirtual: row.is_virtual === 1,
      remark: row.remark,
    });
    setOpen(true);
  }

  async function submit() {
    const v = await form.validateFields();
    try {
      if (editing) {
        await archiveApi.updateMaterial(editing.id, v);
        message.success('物料已更新');
      } else {
        await archiveApi.createMaterial(v);
        message.success('物料已创建');
      }
      setOpen(false);
      reload();
    } catch (e: any) {
      message.error(e.message);
    }
  }

  return (
    <Card
      title="物料档案"
      extra={
        <Space>
          <Input.Search
            placeholder="编码 / 名称 / 拼音 / 规格"
            allowClear
            style={{ width: 240 }}
            onSearch={(keyword) => patchParams({ keyword })}
          />
          <Button
            onClick={() =>
              exportCsv(`物料档案_${Date.now()}`, [
                { title: '物料编码', key: 'code' },
                { title: '物料名称', key: 'name' },
                { title: '规格', key: 'spec' },
                { title: '单位', key: 'unit' },
                { title: '默认供应商', key: 'default_supplier_name' },
                { title: '安全库存', key: 'safety_stock' },
                { title: '当前库存', key: 'current_stock' },
                { title: '加权成本', key: 'avg_cost' },
              ], list)
            }
          >
            导出
          </Button>
          <PermGate permission="archive.material.manage">
            <DockAction icon={<PlusOutlined />} onClick={openCreate}>新增物料</DockAction>
          </PermGate>
        </Space>
      }
    >
      <ResponsiveTable
        rowKey="id"
        size="small"
        loading={loading}
        dataSource={list}
        scroll={{ x: 1100 }}
        pagination={{
          current: params.page,
          pageSize: params.pageSize,
          total,
          onChange: (page, pageSize) => patchParams({ page, pageSize }),
          showSizeChanger: true,
        }}
        columns={[
          { title: '物料编码', dataIndex: 'code', width: 110 },
          { title: '物料名称', dataIndex: 'name', width: 160 },
          { title: '规格', dataIndex: 'spec', width: 140 },
          { title: '分类', dataIndex: 'category', width: 100 },
          { title: '单位', dataIndex: 'unit', width: 70 },
          { title: '默认供应商', dataIndex: 'default_supplier_name', width: 200 },
          { title: '安全库存', dataIndex: 'safety_stock', width: 100, className: 'mono' },
          {
            title: '当前库存',
            dataIndex: 'current_stock',
            width: 100,
            className: 'mono',
            render: (v, r) => (
              <span style={{ color: Number(v) < Number(r.safety_stock) ? '#cf1322' : undefined }}>{v}</span>
            ),
          },
          {
            title: '加权成本',
            dataIndex: 'avg_cost',
            width: 100,
            render: (v) => <PriceText value={v} />,
          },
          {
            title: '类型',
            dataIndex: 'is_virtual',
            width: 90,
            render: (v) => (v === 1 ? <Tag color="purple">虚拟件</Tag> : <Tag>实阶物料</Tag>),
          },
          {
            title: '操作',
            width: 130,
            fixed: 'right',
            render: (_, r) => (
              <PermGate permission="archive.material.manage">
                <Space size={4}>
                  <Button type="link" size="small" onClick={() => openEdit(r)}>
                    编辑
                  </Button>
                  <Popconfirm
                    title="确认删除该物料？"
                    description="库存不为 0 时禁止删除"
                    onConfirm={async () => {
                      try {
                        await archiveApi.deleteMaterial(r.id);
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
        title={editing ? '编辑物料' : '新增物料'}
        onCancel={() => setOpen(false)}
        onOk={submit}
        width={560}
        destroyOnClose
      >
        <Form form={form} layout="vertical" preserve={false}>
          <Form.Item name="code" label="物料编码">
            <Input placeholder="留空自动生成" />
          </Form.Item>
          <Form.Item name="name" label="物料名称" rules={[{ required: true, message: '请输入物料名称' }]}>
            <Input />
          </Form.Item>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item name="spec" label="规格型号" style={{ flex: 1 }}>
              <Input />
            </Form.Item>
            <Form.Item name="unit" label="单位" style={{ width: 120 }}>
              <Input />
            </Form.Item>
          </Space>
          <Form.Item name="defaultSupplierId" label="默认供应商">
            <Select
              allowClear
              placeholder="未配置供应商时采购需手工指定"
              options={suppliers.map((s) => ({ value: s.id, label: s.name }))}
            />
          </Form.Item>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item name="safetyStock" label="安全库存" style={{ flex: 1 }}>
              <InputNumber min={0} style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item name="isVirtual" label="虚拟件" valuePropName="checked" style={{ width: 120 }}>
              <Switch />
            </Form.Item>
          </Space>
          <Form.Item name="category" label="分类">
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
