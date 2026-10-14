import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Form,
  Input,
  InputNumber,
  Space,
  Table,
  Tag,
  message,
} from 'antd';
import { CopyOutlined, DeleteOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons';
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
  Modal,
  TopActionBar,
  RowActionButton,
  RowActionGate,
  useRowSelect,
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
  /** 复制模式：带出源记录全部字段，编码置空由服务端按规则重新生成 */
  const [copying, setCopying] = useState(false);
  const [bom, setBom] = useState<BomRow[]>([]);
  /** 详情加载中：加载期间禁用表单与确定按钮，避免用户对空表单操作导致覆盖已有数据 */
  const [detailLoading, setDetailLoading] = useState(false);
  /**
   * 待回填的详情数据。
   * 不直接写表单，先存这里，等 Modal 挂载完成后由 useEffect 统一回填（见 loadInto 注释）。
   */
  const [pendingDetail, setPendingDetail] = useState<Record<string, any> | null>(null);
  /** 保存中：确定按钮 loading，防重复提交 */
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm();
  /** 顶部操作区：先选中一行，再点按钮（与生产工单页同一套交互） */
  const { selectedId, clearSelection, rowSelection, onRowClick } = useRowSelect();
  const selected = list.find((r) => r.id === selectedId) ?? null;

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
    setCopying(false);
    setBom([]);
    form.resetFields();
    form.setFieldsValue({ unit: '台', safetyStock: 0, bomVersion: 'V1.0' });
    setDetailLoading(false);
    setOpen(true);
  }

  /**
   * 拉取详情并回填。
   *
   * ⚠️ 时序要点（修复「编辑页不回填」的根因）：
   * Modal 用了 destroyOnClose + Form preserve={false}，字段在弹窗**首次挂载时**才注册，
   * 而挂载前的 setFieldsValue 会被初始化覆盖为空。因此必须先 await 取数、
   * 把数据存进 pendingDetail，等弹窗挂载完成后由 useEffect 统一回填，
   * 不能在 setOpen(true) 之前直接写表单。
   */
  async function loadInto(row: Product, mode: 'edit' | 'copy') {
    setDetailLoading(true);
    setEditing(mode === 'edit' ? row : null);
    setCopying(mode === 'copy');
    try {
      const d = await archiveApi.productDetail(row.id);
      setPendingDetail({
        code: mode === 'copy' ? '' : d.code,
        name: mode === 'copy' ? `${d.name}-副本` : d.name,
        spec: d.spec,
        category: d.category,
        unit: d.unit,
        packingSpec: d.packing_spec,
        cartonMaterialId: d.carton_material_id ?? undefined,
        safetyStock: d.safety_stock,
        bomVersion: d.bom_version,
        remark: d.remark,
      });
      setBom(
        (d.bom ?? []).map((b: any, i: number) => ({
          key: String(i),
          materialId: b.materialId,
          qty: b.qtyPerUnit,
        })),
      );
      setOpen(true);
    } catch (e: any) {
      message.error(e.message);
    } finally {
      setDetailLoading(false);
    }
  }

  function openEdit(row: Product) {
    void loadInto(row, 'edit');
  }

  /** 成品复制：带出源成品全部档案属性与 BOM，编码留空由服务端重新分配（需求 4.2） */
  function openCopy(row: Product) {
    void loadInto(row, 'copy');
  }

  /**
   * 弹窗挂载完成后再回填表单。
   *
   * ⚠️ 依赖用 [open, editing, copying, pendingDetail]，不用 [open] 单依赖——
   * 单依赖会让 effect 闭包绑到旧渲染帧的 pendingDetail，React 18 某些时序下
   * 读到 null 直接 return，导致回填被跳过。
   */
  useEffect(() => {
    if (!open) return;
    if (pendingDetail) {
      form.setFieldsValue(pendingDetail);
    }
    // 依赖带全 editing/copying/pendingDetail，保证闭包读到最新值
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editing, copying, pendingDetail]);

  async function submit() {
    // 详情未加载完时禁止提交，避免把空表单当有效数据保存、覆盖已有档案
    if (detailLoading) {
      message.warning('数据加载中，请稍候');
      return;
    }
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
    setSaving(true);
    try {
      if (editing) {
        await archiveApi.updateProduct(editing.id, payload);
        message.success('成品已更新');
      } else {
        await archiveApi.createProduct(payload);
        message.success(copying ? '成品副本已创建' : '新成品档案已创建');
      }
      closeModal();
      clearSelection(); // 操作完成后清除选中，避免下次误点到同一行
      reload();
    } catch (e: any) {
      message.error(e.message);
    } finally {
      setSaving(false);
    }
  }

  /** 关闭弹窗并清理上下文，避免下次打开残留上一次的数据 */
  function closeModal() {
    setOpen(false);
    setPendingDetail(null);
    setEditing(null);
    setCopying(false);
    setBom([]);
    form.resetFields();
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
      {/* 操作区：原按钮在每行末尾重复展示，几十条数据时很杂乱，统一集中到表格上方右侧。
          交互与生产工单页一致 —— 先在列表中点行选中，再点这里的按钮。
          权限点沿用原操作列的 archive.product.manage（无权限时不渲染，与 PermGate 一致）。 */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
        <TopActionBar>
          <RowActionButton
            text="修改"
            icon={<EditOutlined />}
            permission="archive.product.manage"
            selected={selected}
            tipName="成品"
            onAction={(row) => openEdit(row)}
          />
          <RowActionButton
            text="复制"
            icon={<CopyOutlined />}
            permission="archive.product.manage"
            selected={selected}
            tipName="成品"
            onAction={(row) => openCopy(row)}
          />
          <RowActionButton
            text="删除"
            icon={<DeleteOutlined />}
            danger
            permission="archive.product.manage"
            selected={selected}
            tipName="成品"
            confirm={(row) => ({
              title: '确认删除该成品？',
              content: `成品「${row.name}」删除后不可恢复。`,
            })}
            onAction={async (row) => {
              try {
                await archiveApi.deleteProduct(row.id);
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
        ]}
      />

      <Modal
        open={open}
        title={editing ? '修改成品' : copying ? '复制成品' : '新增成品'}
        onCancel={closeModal}
        onOk={submit}
        width={900}
        confirmLoading={saving}
        // 不再使用 destroyOnClose：它会在弹窗关闭时销毁 Form，
        // 与 preserve={false} 叠加会导致「挂载前写入的表单值被初始化覆盖为空」，
        // 改为在 openCreate / 关闭时手动 resetFields，时序更可控。
        destroyOnClose={false}
        forceRender
      >
        <Form form={form} layout="vertical" preserve={false} disabled={detailLoading}>
          {/* 加载中提示：明确告知正在读取已有数据，避免误以为表单为空 */}
          {detailLoading && (
            <Alert
              type="info"
              showIcon
              message="正在加载该成品的完整档案与 BOM 明细，请稍候…"
              style={{ marginBottom: 12 }}
            />
          )}
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
