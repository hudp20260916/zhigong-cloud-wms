import { useEffect, useState } from 'react';
import { Button, Card, Form, Input, Space, Table, message } from 'antd';
import { CopyOutlined, DeleteOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons';
import { archiveApi } from '../../api';
import { useList } from '../../hooks/useList';
import {
  PermGate,
  ResponsiveTable,
  DockAction,
  ImportExcelModal,
  Modal,
  TopActionBar,
  RowActionButton,
  RowActionGate,
  useRowSelect,
} from '../../components';
import { exportCsv } from '../../utils/exportCsv';

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
  /** 复制模式：带出源记录全部内容但编码置空，由服务端按编码规则重新生成 */
  const [copying, setCopying] = useState(false);
  const [form] = Form.useForm();
  /** 顶部操作区：先选中一行，再点按钮（与生产工单页同一套交互） */
  const { selectedId, clearSelection, rowSelection, onRowClick } = useRowSelect();
  const selected = list.find((r) => r.id === selectedId) ?? null;

  function openCreate() {
    setEditing(null);
    setCopying(false);
    form.resetFields();
    setOpen(true);
  }

  /**
   * 修改/复制：数据源统一存到 editing（row 本身），由下方 useEffect
   * 在 [open, editing, copying] 任一变化时按 copying 标志回填，
   * 绕开「useEffect 闭包取旧 state」陷阱。
   */
  function openEdit(row: Partner) {
    setEditing(row);
    setCopying(false);
    setOpen(true);
  }

  function openCopy(row: Partner) {
    setEditing(row); // 复制时也存 row 作为数据源
    setCopying(true);
    setOpen(true);
  }

  /**
   * 弹窗挂载完成 + 已知数据源时回填。
   * ⚠️ 依赖用 [open, editing, copying]，不用 [open] 单依赖（闭包陷阱）。
   */
  useEffect(() => {
    if (!open) return;
    if (!editing) return; // 新建模式走 openCreate 的默认
    const isCopy = copying;
    form.setFieldsValue({
      code: isCopy ? '' : editing.code,
      name: isCopy ? `${editing.name}-副本` : editing.name,
      contact: editing.contact,
      phone: editing.phone,
      remark: editing.remark,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editing, copying]);

  /** 关闭弹窗并清理上下文，避免下次打开残留上一次的数据 */
  function closeModal() {
    setOpen(false);
    setEditing(null);
    setCopying(false);
    form.resetFields();
  }

  async function submit() {
    const v = await form.validateFields();
    // 复制模式不提交编码，交服务端按规则生成；修改模式编码只读、原样回传
    const payload = copying ? { ...v, code: undefined } : v;
    try {
      if (editing) {
        if (isSupplier) await archiveApi.updateSupplier(editing.id, payload);
        else await archiveApi.updateCustomer(editing.id, payload);
        message.success(`${label}已更新`);
      } else {
        if (isSupplier) await archiveApi.createSupplier(payload);
        else await archiveApi.createCustomer(payload);
        message.success(copying ? `${label}副本已创建` : `${label}已创建`);
      }
      closeModal();
      clearSelection(); // 操作完成后清除选中，避免下次误点到同一行
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
          {/* 需求 3/4：供应商 / 客户档案的导入导出与模板 */}
          <Button
            onClick={() =>
              exportCsv(`${label}档案_${Date.now()}`, [
                { title: `${label}编码`, key: 'code' },
                { title: `${label}名称`, key: 'name' },
                { title: '联系人', key: 'contact' },
                { title: '联系电话', key: 'phone' },
                { title: '备注', key: 'remark' },
              ], list)
            }
          >
            导出
          </Button>
          <ImportExcelModal kind={kind} onSuccess={reload} />
          <PermGate permission="archive.partner.manage">
            <DockAction icon={<PlusOutlined />} onClick={openCreate}>新增{label}</DockAction>
          </PermGate>
        </Space>
      }
    >
      {/* 操作区：原按钮在每行末尾重复展示，几十条数据时很杂乱，统一集中到表格上方右侧。
          交互与生产工单页一致 —— 先在列表中点行选中，再点这里的按钮。
          权限点沿用原操作列的 archive.partner.manage（无权限时不渲染，与 PermGate 一致）。 */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
        <TopActionBar>
          <RowActionButton
            text="修改"
            icon={<EditOutlined />}
            permission="archive.partner.manage"
            selected={selected}
            tipName={label}
            onAction={(row) => openEdit(row)}
          />
          <RowActionButton
            text="复制"
            icon={<CopyOutlined />}
            permission="archive.partner.manage"
            selected={selected}
            tipName={label}
            onAction={(row) => openCopy(row)}
          />
          <RowActionButton
            text="删除"
            icon={<DeleteOutlined />}
            danger
            permission="archive.partner.manage"
            selected={selected}
            tipName={label}
            confirm={(row) => ({
              title: `确认删除该${label}？`,
              content: `${label}「${row.name}」删除后不可恢复。`,
            })}
            onAction={async (row) => {
              try {
                if (isSupplier) await archiveApi.deleteSupplier(row.id);
                else await archiveApi.deleteCustomer(row.id);
                message.success('已删除');
                clearSelection(); // 删除后该行已不存在，必须清空选中
                reload();
              } catch (e: any) {
                message.error(e.message);
              }
            }}
          />
        </TopActionBar>
      </div>

      <ResponsiveTable
        rowKey="id"
        size="small"
        loading={loading}
        dataSource={list}
        rowSelection={rowSelection}
        onRowClick={onRowClick}
        selectedRowKeys={selectedId === null ? [] : [selectedId]}
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
        ]}
      />

      <Modal
        open={open}
        title={editing ? `修改${label}` : copying ? `复制${label}` : `新增${label}`}
        onCancel={closeModal}
        onOk={submit}
        // 与成品/物料档案一致：不使用 destroyOnClose，改由 closeModal 统一清理，
        // 避免 destroyOnClose + preserve={false} 叠加导致挂载前回填被覆盖
        destroyOnClose={false}
        forceRender
      >
        <Form form={form} layout="vertical" preserve={false}>
          <Form.Item
            name="code"
            label={`${label}编码`}
            extra={
              editing
                ? '编码为唯一标识，修改模式下不允许变更'
                : '留空自动生成唯一编码'
            }
          >
            {/* 修改模式锁定只读，避免改编码造成关联数据错位或编码重复 */}
            <Input placeholder="留空自动生成" disabled={!!editing} />
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
