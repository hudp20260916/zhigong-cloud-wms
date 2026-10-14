import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  Button,
  Card,
  DatePicker,
  Divider,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
  message,
} from 'antd';
import {
  DeleteOutlined,
  EditOutlined,
  ExportOutlined,
  ImportOutlined,
  PlusOutlined,
} from '@ant-design/icons';
import { archiveApi, productionApi } from '../../api';
import { useList } from '../../hooks/useList';
import {
  PermGate,
  StatusTag,
  PrintButton,
  ResponsiveTable,
  DockAction,
  CopyableCode,
  FilterBar,
} from '../../components';
import { exportCsv, today } from '../../utils/exportCsv';
import { dayVal } from '../../utils/date';

export default function WorkOrderPage() {
  const { list, total, loading, params, patchParams, reload } = useList<any>((p) =>
    productionApi.workOrders(p),
  );
  const navigate = useNavigate();
  const location = useLocation();
  const [products, setProducts] = useState<any[]>([]);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<any>(null);
  /** 列表当前选中的工单 id——顶部操作按钮作用于它 */
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [form] = Form.useForm();

  // 选中行从当前列表实时取：翻页/刷新后旧的 selectedId 天然失效，
  // 避免对一条已经不在当前页的数据执行写操作
  const selected = useMemo(
    () => list.find((r) => r.id === selectedId) ?? null,
    [list, selectedId],
  );

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

  /** 顶部操作按钮的类型 */
  type WoAction = 'print' | 'receive' | 'issue' | 'edit' | 'delete';

  /**
   * 状态联动校验：返回 null 表示允许执行，否则返回提示文案并阻止执行。
   *
   * 口径与后端 workOrders.ts 的 canEdit / canReceive 保持一致：
   * - 已完工（status = '已完工'） → 阻止一切写操作
   * - 入库已满（remainQty <= 0）  → 阻止「去入库」「去领料」（料已够、无需再领/再入）
   * - 已领料（issued_qty > 0）    → 阻止「编辑」「删除」（后端 canEdit 亦要求 issued_qty = 0）
   * 打印是只读操作，不设状态门槛。
   */
  function blockReason(row: any, action: WoAction): string | null {
    if (action === 'print') return null;
    if (row.status === '已完工') return '已完工';
    const remain = Number(row.remainQty ?? 0);
    if ((action === 'receive' || action === 'issue') && remain <= 0) return '已入库完成';
    if ((action === 'edit' || action === 'delete') && Number(row.issued_qty ?? 0) > 0)
      return '已领料完成';
    return null;
  }

  /**
   * 顶部按钮统一入口：先校验「已选中」与「状态允许」，
   * 通过后把该行数据交给 fn 执行（回调里拿到的 row 一定非空）。
   */
  function runAction(action: WoAction, fn: (row: any) => void) {
    if (!selected) {
      message.warning('请先选择一条工单');
      return;
    }
    const reason = blockReason(selected, action);
    if (reason) {
      message.warning(reason);
      return;
    }
    fn(selected);
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
      setSelectedId(null); // 操作完成后清除选中，避免下次误点到同一行
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
              void (async () => {
                // 需求 9：导出跟随筛选结果
                const res = await productionApi.workOrders({ ...params, page: 1, pageSize: 50000 });
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
                ], res.list ?? []);
              })()
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
      {/* 需求 9：日期区间 + 完工状态 + 包含字筛选 */}
      <FilterBar
        onReset={() =>
          patchParams({ keyword: '', statusFilter: '', dateFrom: '', dateTo: '' })
        }
        extra={
          /* 选中行操作组：先在列表中点行选中，再点这里执行。
             原按钮在每行末尾重复展示，几十条数据时很杂乱，故集中到顶部。 */
          <Space size={8} wrap>
            {/* 打印沿用 PrintButton：服务端渲染 + 弹窗被拦截时的提示逻辑都不变。
                未选中行时在捕获阶段拦下点击，只提示、不打开打印窗口。 */}
            <span
              onClickCapture={(e) => {
                if (!selected) {
                  e.preventDefault();
                  e.stopPropagation();
                  message.warning('请先选择一条工单');
                }
              }}
              onClick={() => {
                // 打印为只读操作，与其它操作统一收尾：清选中 + 刷新
                setSelectedId(null);
                reload();
              }}
            >
              <PrintButton docType="work_order" id={selected?.id ?? 0} type="default" />
            </span>

            <Button
              size="small"
              icon={<ImportOutlined />}
              onClick={() =>
                runAction('receive', (row) =>
                  navigate('/production/receipts', { state: { workOrderId: row.id } }),
                )
              }
            >
              去入库
            </Button>

            <Button
              size="small"
              icon={<ExportOutlined />}
              onClick={() =>
                runAction('issue', (row) =>
                  navigate('/production/issues', { state: { workOrderId: row.id } }),
                )
              }
            >
              去领料
            </Button>

            <Button
              size="small"
              icon={<EditOutlined />}
              onClick={() => runAction('edit', (row) => void openEdit(row))}
            >
              编辑
            </Button>

            <Button
              size="small"
              danger
              icon={<DeleteOutlined />}
              onClick={() =>
                runAction('delete', (row) => {
                  Modal.confirm({
                    title: '确认删除该工单？',
                    content: `工单「${row.wo_no}」删除后不可恢复。`,
                    okText: '确认删除',
                    okButtonProps: { danger: true },
                    cancelText: '取消',
                    onOk: async () => {
                      try {
                        await productionApi.deleteWorkOrder(row.id);
                        message.success('已删除');
                        setSelectedId(null);
                        reload();
                      } catch (e: any) {
                        message.error(e.message);
                      }
                    },
                  });
                })
              }
            >
              删除
            </Button>
          </Space>
        }
      >
        <DatePicker
          style={{ width: 140 }}
          placeholder="开始日期"
          value={dayVal(params.dateFrom)}
          onChange={(d) => patchParams({ dateFrom: d ? d.format('YYYY-MM-DD') : '' })}
        />
        <DatePicker
          style={{ width: 140 }}
          placeholder="结束日期"
          value={dayVal(params.dateTo)}
          onChange={(d) => patchParams({ dateTo: d ? d.format('YYYY-MM-DD') : '' })}
        />
        <Select
          allowClear
          style={{ width: 150 }}
          placeholder="完工状态"
          value={params.statusFilter || undefined}
          onChange={(v) => patchParams({ statusFilter: v ?? '' })}
          options={[
            { value: 'producing', label: '生产中' },
            { value: 'unfinished', label: '未完工' },
            { value: 'finished', label: '已完工' },
          ]}
        />
      </FilterBar>

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
        // 桌面端单选：顶部按钮作用于选中行
        rowSelection={{
          type: 'radio',
          selectedRowKeys: selectedId == null ? [] : [selectedId],
          onChange: (keys) => setSelectedId(keys.length ? Number(keys[0]) : null),
          columnWidth: 44,
        }}
        // 选中行高亮（双主题自适应，见 styles.css 的 .wo-row-selected）
        rowClassName={(r) => (r.id === selectedId ? 'wo-row-selected' : '')}
        onRow={(r) => ({
          onClick: () => setSelectedId(r.id === selectedId ? null : r.id),
        })}
        // 卡片模式下 rowSelection 不生效，显式传 key 让卡片也能高亮；点击卡片即选中
        selectedRowKeys={selectedId == null ? [] : [selectedId]}
        onRowClick={(row) => setSelectedId(row.id === selectedId ? null : row.id)}
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
