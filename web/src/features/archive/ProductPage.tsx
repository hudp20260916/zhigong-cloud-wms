import { useEffect, useMemo, useState } from 'react';
import {
  Button,
  Card,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Space,
  Table,
  Tag,
  message,
} from 'antd';
import { CopyOutlined, PlusOutlined } from '@ant-design/icons';
import { archiveApi } from '../../api';
import { useList } from '../../hooks/useList';
import { useRowDetail } from '../../hooks/useRowDetail';
import {
  PermGate,
  ResponsiveTable,
  DockAction,
  ImportExcelModal,
  DetailTable,
  SearchableSelect,
} from '../../components';
import { exportCsv } from '../../utils/exportCsv';

interface BomRow {
  key: string;
  materialId?: number;
  qty: number;
}

interface Product {
  id: number;
  code: string;
  name: string;
  spec?: string;
  category?: string;
  unit: string;
  packing_spec?: string;
  carton_material_id?: number | null;
  safety_stock: number;
  current_stock: number;
  bom_version?: string;
  bom_count?: number;
  remark?: string;
}

export default function ProductPage() {
  const { list, total, loading, params, patchParams, reload } = useList<Product>((p) =>
    archiveApi.products(p),
  );
  // 需求二.4：点击行展开该成品的 BOM 配置表（明细只读）
  const detail = useRowDetail((id: number) => archiveApi.productDetail(id));
  const [materials, setMaterials] = useState<any[]>([]);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Product | null>(null);
  const [bom, setBom] = useState<BomRow[]>([]);
  const [form] = Form.useForm();

  useEffect(() => {
    archiveApi
      .materialOptions()
      .then(setMaterials)
      .catch(() => undefined);
  }, []);

  const materialOptions = useMemo(
    () => materials.map((m) => ({ value: m.id, label: `${m.code} ${m.name}` })),
    [materials],
  );

  function openCreate() {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({ unit: '台', safetyStock: 0, bomVersion: 'V1.0' });
    setBom([]);
    setOpen(true);
  }

  /** 成品复制：带出源成品全部档案属性与 BOM，编码留空由服务端重新分配（需求 4.2） */
  async function openCopy(row: Product) {
    try {
      const detail = await archiveApi.productDetail(row.id);
      setEditing(null);
      form.setFieldsValue({
        code: '',
        name: `${detail.name}-副本`,
        spec: detail.spec,
        category: detail.category,
        unit: detail.unit,
        packingSpec: detail.packing_spec,
        cartonMaterialId: detail.carton_material_id ?? undefined,
        safetyStock: detail.safety_stock,
        bomVersion: detail.bom_version,
        remark: detail.remark,
      });
      setBom(
        (detail.bom ?? []).map((b: any, i: number) => ({
          key: String(i),
          materialId: b.materialId,
          qty: b.qtyPerUnit,
        })),
      );
      setOpen(true);
    } catch (e: any) {
      message.error(e.message);
    }
  }

  async function openEdit(row: Product) {
    try {
      const detail = await archiveApi.productDetail(row.id);
      setEditing(row);
      form.setFieldsValue({
        code: detail.code,
        name: detail.name,
        spec: detail.spec,
        category: detail.category,
        unit: detail.unit,
        packingSpec: detail.packing_spec,
        cartonMaterialId: detail.carton_material_id ?? undefined,
        safetyStock: detail.safety_stock,
        bomVersion: detail.bom_version,
        remark: detail.remark,
      });
      setBom(
        (detail.bom ?? []).map((b: any, i: number) => ({
          key: String(i),
          materialId: b.materialId,
          qty: b.qtyPerUnit,
        })),
      );
      setOpen(true);
    } catch (e: any) {
      message.error(e.message);
    }
  }

  async function submit() {
    const v = await form.validateFields().catch(() => null);
    if (!v) return;

    const lines = bom.filter((b) => b.materialId);
    const invalid = lines.find((b) => !b.qty || Number(b.qty) <= 0);
    if (invalid) {
      message.error('BOM 物料单件耗用量必须大于 0');
      return;
    }

    const payload = { ...v, bom: lines.map((b) => ({ materialId: b.materialId, qty: Number(b.qty) })) };

    // 未配置 BOM 时二次确认（需求 5）
    if (payload.bom.length === 0) {
      Modal.confirm({
        title: '当前成品未配置 BOM 清单，确认保存？',
        content: '未配置 BOM 的成品无法用于按 BOM 展开采购与生产领料。',
        onOk: () => doSave({ ...payload, confirmNoBom: true }),
      });
      return;
    }
    await doSave(payload);
  }

  async function doSave(payload: any) {
    try {
      if (editing) {
        await archiveApi.updateProduct(editing.id, payload);
        message.success('成品已更新');
      } else {
        await archiveApi.createProduct(payload);
        message.success('新成品档案已创建');
      }
      setOpen(false);
      reload();
    } catch (e: any) {
      message.error(e.message);
    }
  }

  return (
    <Card
      title="成品档案与 BOM"
      extra={
        <Space>
          <Input.Search
            placeholder="编码 / 名称 / 拼音 / 规格"
            allowClear
            style={{ width: 240 }}
            onSearch={(keyword) => patchParams({ keyword })}
          />
          {/* 需求 2：成品档案的导入导出与模板 */}
          <Button
            onClick={() =>
              exportCsv(`成品档案_${Date.now()}`, [
                { title: '产品编码', key: 'code' },
                { title: '产品名称', key: 'name' },
                { title: '规格型号', key: 'spec' },
                { title: '分类', key: 'category' },
                { title: '单位', key: 'unit' },
                { title: '装箱规格', key: 'packing_spec' },
                { title: '安全库存', key: 'safety_stock' },
                { title: '当前库存', key: 'current_stock' },
                { title: 'BOM版本', key: 'bom_version' },
                { title: '备注', key: 'remark' },
              ], list)
            }
          >
            导出
          </Button>
          <ImportExcelModal kind="product" onSuccess={reload} />
          <PermGate permission="archive.product.manage">
            <DockAction icon={<PlusOutlined />} onClick={openCreate}>新增成品</DockAction>
          </PermGate>
        </Space>
      }
    >
      <ResponsiveTable
        rowKey="id"
        size="small"
        loading={loading}
        dataSource={list}
        scroll={{ x: 1300 }}
        // 需求二.4：点击行展开该成品的 BOM 配置表（明细只读，含明细字段）
        expandable={{
          expandedRowRender: (r) => (
            <DetailTable
              loading={detail.loading[r.id]}
              items={detail.cache[r.id]?.bom ?? []}
              columns={[
                { title: '物料编码', dataIndex: 'materialCode', width: 130 },
                { title: '物料名称', dataIndex: 'materialName', width: 180 },
                { title: '规格', dataIndex: 'spec', width: 150 },
                { title: '单位', dataIndex: 'unit', width: 70 },
                { title: '单件耗用量', dataIndex: 'qtyPerUnit', width: 110, className: 'mono' },
                {
                  title: '类型',
                  dataIndex: 'isVirtual',
                  width: 90,
                  render: (v) => (v ? <Tag color="purple">虚拟件</Tag> : <Tag>实阶物料</Tag>),
                },
                { title: '备注', dataIndex: 'remark' },
              ]}
            />
          ),
          onExpand: (expanded, r) => {
            if (expanded) void detail.load(r.id);
          },
        }}
        pagination={{
          current: params.page,
          pageSize: params.pageSize,
          total,
          onChange: (page, pageSize) => patchParams({ page, pageSize }),
          showSizeChanger: true,
        }}
        columns={[
          { title: '成品编码', dataIndex: 'code', width: 110 },
          { title: '成品名称', dataIndex: 'name', width: 180 },
          { title: '规格型号', dataIndex: 'spec', width: 120 },
          { title: '分类', dataIndex: 'category', width: 100 },
          { title: '单位', dataIndex: 'unit', width: 70 },
          { title: '装箱规格', dataIndex: 'packing_spec', width: 100 },
          { title: '安全库存', dataIndex: 'safety_stock', width: 100, className: 'mono' },
          { title: '当前库存', dataIndex: 'current_stock', width: 100, className: 'mono' },
          { title: 'BOM 版本', dataIndex: 'bom_version', width: 100 },
          {
            title: 'BOM 明细',
            dataIndex: 'bom_count',
            width: 90,
            render: (v) => <Tag color={v ? 'blue' : 'default'}>{v ?? 0} 项</Tag>,
          },
          {
            title: '操作',
            width: 180,
            fixed: 'right',
            render: (_, r) => (
              <PermGate permission="archive.product.manage">
                {/* stopPropagation：点操作按钮不要连带触发行展开 */}
                <Space size={0} onClick={(e) => e.stopPropagation()}>
                  <Button type="link" size="small" onClick={() => openEdit(r)}>
                    修改
                  </Button>
                  <Button
                    type="link"
                    size="small"
                    icon={<CopyOutlined />}
                    onClick={() => openCopy(r)}
                  >
                    复制
                  </Button>
                  <Popconfirm
                    title="确认删除该成品？"
                    onConfirm={async () => {
                      try {
                        await archiveApi.deleteProduct(r.id);
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
        title={editing ? '修改成品' : '新增成品'}
        onCancel={() => setOpen(false)}
        onOk={submit}
        width={900}
        destroyOnClose
      >
        <Form form={form} layout="vertical" preserve={false}>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item
              name="code"
              label="成品编码"
              style={{ flex: 1 }}
              extra={
                editing
                  ? '编码为唯一标识，修改模式下不允许变更'
                  : '留空自动生成唯一编码（复制时请勿保留原编码）'
              }
            >
              {/* 修改模式锁定只读：编码是唯一标识且被单据引用，改编码会导致关联数据错位 */}
              <Input placeholder="留空自动生成唯一编码" disabled={!!editing} />
            </Form.Item>
            <Form.Item name="name" label="成品名称" style={{ flex: 1 }} rules={[{ required: true }]}>
              <Input />
            </Form.Item>
          </Space>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item name="spec" label="规格型号" style={{ flex: 1 }}>
              <Input />
            </Form.Item>
            <Form.Item name="category" label="分类（选填）" style={{ flex: 1 }}>
              <Input placeholder="如：整机 / 配件 / 半成品" />
            </Form.Item>
          </Space>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item name="unit" label="单位" style={{ width: 110 }}>
              <Input />
            </Form.Item>
            <Form.Item name="packingSpec" label="装箱规格" style={{ width: 140 }}>
              <Input />
            </Form.Item>
          </Space>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item name="cartonMaterialId" label="外箱物料" style={{ flex: 1 }}>
              <SearchableSelect allowClear options={materialOptions} placeholder="请选择外箱物料" />
            </Form.Item>
            <Form.Item name="safetyStock" label="安全库存" style={{ width: 140 }}>
              <InputNumber min={0} style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item name="bomVersion" label="BOM 版本" style={{ width: 140 }}>
              <Input />
            </Form.Item>
          </Space>
        </Form>

        <div style={{ margin: '8px 0' }}>
          <Space>
            <span style={{ fontWeight: 500 }}>BOM 物料清单</span>
            <Button
              size="small"
              icon={<PlusOutlined />}
              onClick={() =>
                setBom((prev) => [...prev, { key: String(Date.now()), materialId: undefined, qty: 1 }])
              }
            >
              添加物料
            </Button>
          </Space>
        </div>
        <ResponsiveTable
          size="small"
          rowKey="key"
          dataSource={bom}
          pagination={false}
          scroll={{ y: 240 }}
          locale={{ emptyText: '尚未配置 BOM 物料' }}
          columns={[
            {
              title: '物料',
              dataIndex: 'materialId',
              render: (v, r) => (
                <SearchableSelect
                  style={{ width: '100%' }}
                  value={v}
                  placeholder="请选择物料"
                  options={materialOptions}
                  onChange={(nv) =>
                    setBom((prev) => prev.map((x) => (x.key === r.key ? { ...x, materialId: nv } : x)))
                  }
                />
              ),
            },
            {
              title: '单件耗用量',
              dataIndex: 'qty',
              width: 140,
              render: (v, r) => (
                <InputNumber
                  min={0}
                  step={0.01}
                  value={v}
                  style={{ width: '100%' }}
                  onChange={(nv) =>
                    setBom((prev) => prev.map((x) => (x.key === r.key ? { ...x, qty: Number(nv ?? 0) } : x)))
                  }
                />
              ),
            },
            {
              title: '操作',
              width: 70,
              render: (_, r) => (
                <Button
                  type="link"
                  size="small"
                  danger
                  onClick={() => setBom((prev) => prev.filter((x) => x.key !== r.key))}
                >
                  移除
                </Button>
              ),
            },
          ]}
        />
      </Modal>
    </Card>
  );
}
