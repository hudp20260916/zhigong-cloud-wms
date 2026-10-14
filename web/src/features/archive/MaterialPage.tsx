import { useEffect, useState } from 'react';
import {
  Button,
  Card,
  Form,
  Input,
  InputNumber,
  Space,
  Switch,
  Tag,
  message,
} from 'antd';
import { CopyOutlined, DeleteOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons';
import { archiveApi } from '../../api';
import { useList } from '../../hooks/useList';
import {
  PermGate,
  PriceText,
  StatusTag,
  ResponsiveTable,
  DockAction,
  ImportExcelModal,
  SearchableSelect,
  Modal,
  TopActionBar,
  RowActionButton,
  useRowSelect,
} from '../../components';
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
  /** 复制模式：带出源记录全部内容但编码置空，由服务端按编码规则重新生成 */
  const [copying, setCopying] = useState(false);
  const [form] = Form.useForm();
  /** 顶部操作区：先选中一行，再点按钮（与生产工单页同一套交互） */
  const { selectedId, clearSelection, rowSelection, onRowClick } = useRowSelect();
  const selected = list.find((r) => r.id === selectedId) ?? null;

  useEffect(() => {
    archiveApi
      .supplierOptions()
      .then(setSuppliers)
      .catch(() => undefined);
  }, []);

  function openCreate() {
    setEditing(null);
    setCopying(false);
    form.resetFields();
    form.setFieldsValue({ unit: '个', safetyStock: 0, isVirtual: false });
    setOpen(true);
  }

  /**
   * 修改：数据源直接用 editing（当前渲染帧已提交），由下方 useEffect
   * 在 [open, editing, copying] 任一变化时回填，绕开「闭包取旧 state」陷阱。
   * 复制：编码置空 + 名称加「-副本」，仍用 editing 的 row 作为数据源。
   */
  function openEdit(row: Material) {
    setEditing(row);
    setCopying(false);
    setOpen(true);
  }

  function openCopy(row: Material) {
    setEditing(row); // 复制时也存 row，让 effect 能拿到全部字段
    setCopying(true);
    setOpen(true);
  }

  /**
   * 弹窗挂载完成 + 已知数据源时回填。
   * ⚠️ 依赖用 [open, editing, copying]，不用 [open] 单依赖（闭包陷阱）。
   */
  useEffect(() => {
    if (!open) return;
    if (!editing) return; // 新建模式走 openCreate 的默认值
    const isCopy = copying;
    form.setFieldsValue({
      code: isCopy ? '' : editing.code,
      name: isCopy ? `${editing.name}-副本` : editing.name,
      spec: editing.spec,
      category: editing.category,
      unit: editing.unit,
      defaultSupplierId: editing.default_supplier_id ?? undefined,
      safetyStock: editing.safety_stock,
      isVirtual: editing.is_virtual === 1,
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
        await archiveApi.updateMaterial(editing.id, payload);
        message.success('物料已更新');
      } else {
        await archiveApi.createMaterial(payload);
        message.success(copying ? '物料副本已创建' : '物料已创建');
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
          {/* 需求 1：物料档案页内直接导入 Excel，并附带导入模板下载 */}
          <ImportExcelModal kind="material" onSuccess={reload} />
          <PermGate permission="archive.material.manage">
            <DockAction icon={<PlusOutlined />} onClick={openCreate}>新增物料</DockAction>
          </PermGate>
        </Space>
      }
    >
      {/* 操作区：原按钮在每行末尾重复展示，几十条数据时很杂乱，统一集中到表格上方右侧。
          交互与生产工单页一致 —— 先在列表中点行选中，再点这里的按钮。 */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
        <TopActionBar>
          <RowActionButton
            text="修改"
            icon={<EditOutlined />}
            permission="archive.material.manage"
            selected={selected}
            tipName="物料"
            onAction={(row) => openEdit(row)}
          />
          <RowActionButton
            text="复制"
            icon={<CopyOutlined />}
            permission="archive.material.manage"
            selected={selected}
            tipName="物料"
            onAction={(row) => openCopy(row)}
          />
          <RowActionButton
            text="删除"
            icon={<DeleteOutlined />}
            danger
            permission="archive.material.manage"
            selected={selected}
            tipName="物料"
            disabledReason={(row) =>
              Number(row.current_stock) > 0 ? '该物料库存不为 0，禁止删除' : null
            }
            confirm={(row) => ({
              title: '确认删除该物料？',
              content: `物料「${row.name}」删除后不可恢复。`,
            })}
            onAction={async (row) => {
              try {
                await archiveApi.deleteMaterial(row.id);
                message.success('已删除');
                clearSelection();
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
        ]}
      />

      <Modal
        open={open}
        title={editing ? '修改物料' : copying ? '复制物料' : '新增物料'}
        onCancel={closeModal}
        onOk={submit}
        width={560}
        // 与成品档案一致：不使用 destroyOnClose，改由 closeModal 统一清理，
        // 避免 destroyOnClose + preserve={false} 叠加导致挂载前回填被覆盖
        destroyOnClose={false}
        forceRender
      >
        <Form form={form} layout="vertical" preserve={false}>
          <Form.Item
            name="code"
            label="物料编码"
            extra={editing ? '编码为唯一标识，修改模式下不允许变更' : '留空自动生成唯一编码'}
          >
            {/* 修改模式锁定只读，避免改编码造成关联数据错位或编码重复 */}
            <Input placeholder="留空自动生成" disabled={!!editing} />
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
            <SearchableSelect
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
          <Form.Item name="category" label="分类（选填）">
            <Input placeholder="如：电子件 / 结构件 / 包材 / 耗材" />
          </Form.Item>
          <Form.Item name="remark" label="备注">
            <Input.TextArea rows={2} />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}
