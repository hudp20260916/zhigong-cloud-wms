import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  Button,
  Card,
  DatePicker,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  message,
} from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { archiveApi, productionApi } from '../../api';
import { useList } from '../../hooks/useList';
import { PermGate, StatusTag, PrintButton, ResponsiveTable, DockAction, CopyableCode } from '../../components';
import { exportCsv, today } from '../../utils/exportCsv';

export default function WorkOrderPage() {
  const { list, total, loading, params, patchParams, reload } = useList<any>((p) =>
    productionApi.workOrders(p),
  );
  const navigate = useNavigate();
  const location = useLocation();
  const [products, setProducts] = useState<any[]>([]);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<any>(null);
  const [form] = Form.useForm();

  useEffect(() => {
    archiveApi.productOptions().then(setProducts).catch(() => undefined);
  }, []);

  // 从成品库存「去创建工单」跳转：只带出成品，不带建议产量
  useEffect(() => {
    const st: any = location.state;
    if (st?.prefill?.productId) {
      setEditing(null);
      form.resetFields();
      form.setFieldsValue({ productId: st.prefill.productId, planQty: 100 });
      setOpen(true);
      navigate('/production/work-orders', { replace: true, state: null });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.state]);

  function openCreate() {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({ planQty: 100 });
    setOpen(true);
  }

  async function openEdit(row: any) {
    const detail = await productionApi.workOrderDetail(row.id);
    setEditing(row);
    form.setFieldsValue({
      productId: detail.product_id,
      planQty: detail.plan_qty,
      bomVersion: detail.bom_version,
      planStart: detail.plan_start || undefined,
      planEnd: detail.plan_end || undefined,
      remark: detail.remark,
    });
    setOpen(true);
  }

  async function submit() {
    const v = await form.validateFields();
    try {
      const payload = {
        ...v,
        planStart: v.planStart ? v.planStart.format('YYYY-MM-DD') : '',
        planEnd: v.planEnd ? v.planEnd.format('YYYY-MM-DD') : '',
      };
      if (editing) {
        await productionApi.updateWorkOrder(editing.id, payload);
        message.success('工单已更新');
      } else {
        await productionApi.createWorkOrder(payload);
        message.success('生产工单已创建');
      }
      setOpen(false);
      reload();
    } catch (e: any) {
      message.error(e.message);
    }
  }

  return (
    <Card
      title="生产工单"
      extra={
        <Space>
          <Input.Search
            placeholder="工单号 / 主产品"
            allowClear
            style={{ width: 220 }}
            onSearch={(keyword) => patchParams({ keyword })}
          />
          <Button
            onClick={() =>
              exportCsv(`生产工单_${today()}`, [
                { title: '工单编号', key: 'wo_no' },
                { title: '主产品', key: 'product_name' },
                { title: '计划产量', key: 'plan_qty' },
                { title: 'BOM版本', key: 'bom_version' },
                { title: '计划开工', key: 'plan_start' },
                { title: '计划完工', key: 'plan_end' },
                { title: '实际领料合计', key: 'issued_qty' },
                { title: '实际入库合计', key: 'received_qty' },
                { title: '损耗', key: 'loss_qty' },
                { title: '状态', key: 'status' },
              ], list)
            }
          >
            导出
          </Button>
          <PermGate permission="production.wo.create">
            <DockAction icon={<PlusOutlined />} onClick={openCreate}>新增工单</DockAction>
          </PermGate>
        </Space>
      }
    >
      <ResponsiveTable
        rowKey="id"
        size="small"
        loading={loading}
        dataSource={list}
        scroll={{ x: 1400 }}
        pagination={{
          current: params.page,
          pageSize: params.pageSize,
          total,
          onChange: (page, pageSize) => patchParams({ page, pageSize }),
          showSizeChanger: true,
        }}
        columns={[
          { title: '工单编号', dataIndex: 'wo_no', width: 160, render: (v) => <CopyableCode value={v} /> },
          { title: '主产品', dataIndex: 'product_name', width: 180 },
          { title: '计划产量', dataIndex: 'plan_qty', width: 100, className: 'mono' },
          { title: 'BOM版本', dataIndex: 'bom_version', width: 100 },
          { title: '计划开工', dataIndex: 'plan_start', width: 110, render: (v) => v || '-' },
          { title: '计划完工', dataIndex: 'plan_end', width: 110, render: (v) => v || '-' },
          { title: '实际领料合计', dataIndex: 'issued_qty', width: 120, className: 'mono' },
          { title: '实际入库合计', dataIndex: 'received_qty', width: 120, className: 'mono' },
          {
            title: '损耗',
            dataIndex: 'loss_qty',
            width: 90,
            className: 'mono',
            render: (v) => <span style={{ color: Number(v) > 0 ? '#cf1322' : undefined }}>{v}</span>,
          },
          { title: '状态', dataIndex: 'status', width: 100, render: (v) => <StatusTag status={v} /> },
          {
            title: '操作',
            width: 220,
            fixed: 'right',
            render: (_, r) => (
              <Space size={0}>
                <PrintButton docType="work_order" id={r.id} />
                {/* 需求 4.6：工单列表「去入库」仅对未领料工单开放 */}
                {r.canReceive && (
                  <Button
                    type="link"
                    size="small"
                    onClick={() => navigate('/production/receipts', { state: { workOrderId: r.id } })}
                  >
                    去入库
                  </Button>
                )}
                {r.issued_qty === 0 && (
                  <Button
                    type="link"
                    size="small"
                    onClick={() => navigate('/production/issues', { state: { workOrderId: r.id } })}
                  >
                    去领料
                  </Button>
                )}
                {r.canEdit && (
                  <Button type="link" size="small" onClick={() => openEdit(r)}>
                    编辑
                  </Button>
                )}
                {r.canEdit && (
                  <Popconfirm
                    title="确认删除该工单？"
                    onConfirm={async () => {
                      try {
                        await productionApi.deleteWorkOrder(r.id);
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
                )}
                {!r.canReceive && !r.canEdit && <Tag>已开工</Tag>}
              </Space>
            ),
          },
        ]}
      />

      <Modal open={open} title={editing ? '编辑生产工单' : '新增生产工单'} onCancel={() => setOpen(false)} onOk={submit} destroyOnClose>
        <Form form={form} layout="vertical" preserve={false}>
          <Form.Item name="productId" label="主产品" rules={[{ required: true, message: '请选择主产品' }]}>
            <Select
              showSearch
              optionFilterProp="label"
              options={products.map((p) => ({ value: p.id, label: `${p.code} ${p.name}` }))}
            />
          </Form.Item>
          <Form.Item name="planQty" label="计划产量" rules={[{ required: true }]}>
            <InputNumber min={1} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="bomVersion" label="BOM 版本">
            <Input placeholder="留空取成品档案默认版本" />
          </Form.Item>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item name="planStart" label="计划开工" style={{ flex: 1 }}>
              <DatePicker style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item name="planEnd" label="计划完工" style={{ flex: 1 }}>
              <DatePicker style={{ width: '100%' }} />
            </Form.Item>
          </Space>
          <Form.Item name="remark" label="备注">
            <Input.TextArea rows={2} />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}
