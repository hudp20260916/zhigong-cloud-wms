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
  Spin,
  Tag,
  Typography,
  message,
} from 'antd';
import {
  CopyOutlined,
  DeleteOutlined,
  EditOutlined,
  ExportOutlined,
  ImportOutlined,
  PlusOutlined,
} from '@ant-design/icons';
import { archiveApi, productionApi } from '../../api';
import { useAuthStore } from '../../stores/auth';
import { useList } from '../../hooks/useList';
import {
  PermGate,
  StatusTag,
  PrintButton,
  ResponsiveTable,
  DockAction,
  CopyableCode,
  FilterBar,
  ErrorBoundary,
} from '../../components';
import { exportCsv, today } from '../../utils/exportCsv';
import { dayVal } from '../../utils/date';

export default function WorkOrderPage() {
  const { list, total, loading, params, patchParams, reload } = useList<any>((p) =>
    productionApi.workOrders(p),
  );
  const navigate = useNavigate();
  const location = useLocation();
  /** 权限判断：用于在点按钮前给出「无权限」提示，而不是点了没反应或后端 403 弹错 */
  const hasPerm = useAuthStore((s) => s.has);
  const [products, setProducts] = useState<any[]>([]);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<any>(null);
  /** 列表当前选中的工单 id——顶部操作按钮作用于它 */
  const [selectedId, setSelectedId] = useState<number | null>(null);
  /**
   * 弹窗待回填数据。
   * 不直接写表单，先存这里，等弹窗挂载完成后由下方 useEffect 统一回填——
   * 否则会被 destroyOnClose + preserve={false} 的挂载初始化覆盖清空（编辑弹窗全空的根因）。
   */
  const [pendingDetail, setPendingDetail] = useState<any>(null);
  /** 详情加载中：期间禁用表单，避免对尚未回填的空表单误操作 */
  const [detailLoading, setDetailLoading] = useState(false);
  /**
   * 物料需求预览：选中主产品 + 填了计划产量后，按 BOM 展开计算需求并与现有库存比对。
   * 纯展示用，缺料不拦截保存。
   */
  const [bomPreview, setBomPreview] = useState<{ items: any[]; shortageCount: number } | null>(null);
  const [bomLoading, setBomLoading] = useState(false);
  /**
   * 编辑态的「计划数量下限」约束：{ issued, received, min }。
   * 已领部分 / 已入部分都允许编辑，但改后的计划量不能低于已发生的量，
   * 否则会出现「领了 100、入了 100，计划却写成 50」的账实倒挂。
   */
  const [editFloor, setEditFloor] = useState<{ issued: number; received: number; min: number } | null>(null);
  /**
   * 编辑态是否锁定主产品：已领料或已入库的工单不能换产品。
   * 领料明细 / 入库流水都是按原主产品的 BOM 展开的，换产品会让已扣物料与已入成品对不上账。
   */
  const [productLocked, setProductLocked] = useState(false);
  /** 复制模式：以选中工单为模板开新单（业务字段带出，单号重新生成） */
  const [copying, setCopying] = useState(false);
  const [form] = Form.useForm();
  // 实时监听这两个字段：主产品一变就重算 BOM 明细，计划产量一变就重算需求数量与库存比对
  const watchProductId = Form.useWatch('productId', form);
  const watchPlanQty = Form.useWatch('planQty', form);

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
      setCopying(false);
      setEditFloor(null);
      setProductLocked(false);
      // 只暂存，实际写表单交给下方 useEffect（挂载前 setFieldsValue 会被清空）
      setPendingDetail({ productId: st.prefill.productId, planQty: 100 });
      setOpen(true);
      navigate('/production/work-orders', { replace: true, state: null });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.state]);

  function openCreate() {
    setEditing(null);
    setCopying(false);
    setEditFloor(null);
    setProductLocked(false);
    setPendingDetail({ planQty: 100 });
    setOpen(true);
  }

  /**
   * 编辑：先拉详情暂存到 pendingDetail，再由下方 useEffect 于弹窗挂载后回填。
   * 不能在 await 之后直接 setFieldsValue——此刻弹窗尚未挂载，值会被随后的
   * 挂载初始化覆盖清空（与物料 / 供应商 / 客户 / 成品档案同一根因）。
   */
  async function openEdit(row: any) {
    setDetailLoading(true);
    try {
      const detail = await productionApi.workOrderDetail(row.id);
      setEditing(row);
      const issued = Number(detail.issued_qty ?? 0);
      const received = Number(detail.received_qty ?? 0);
      setEditFloor({ issued, received, min: Math.max(issued, received) });
      // 未领料且未开始入库的工单不受限制，可以随便换产品
      setProductLocked(issued > 0 || received > 0);
      setPendingDetail({
        productId: detail.product_id,
        planQty: detail.plan_qty,
        bomVersion: detail.bom_version,
        // ⚠️ 必须是 dayjs 对象：DatePicker 拿到字符串会调 value.format() 直接抛错，
        // 整个弹窗渲染中断 → 平哥看到的「点编辑白屏」就是这个（utils/date.ts 注释里已记录过同类事故）
        planStart: dayVal(detail.plan_start),
        planEnd: dayVal(detail.plan_end),
        remark: detail.remark,
      });
      setOpen(true);
    } catch (e: any) {
      message.error(e.message);
    } finally {
      setDetailLoading(false);
    }
  }

  /**
   * 复制工单：以选中工单为模板开一张新单。
   * - 单号由服务端按现有编码规则生成，表单里本来就没有单号字段，无法手填；
   * - 计划开工日默认填当天（可改），计划完工日留空（保存后可编辑补录）；
   * - 其余业务字段（主产品、计划产量、BOM 版本、备注）原样带出；
   * - 新单没有领料 / 入库记录，所以主产品不锁、也不受计划量下限约束。
   */
  async function openCopy(row: any) {
    setDetailLoading(true);
    try {
      const detail = await productionApi.workOrderDetail(row.id);
      setEditing(null); // 复制出来的是新单，保存时走 create
      setCopying(true);
      setEditFloor(null);
      setProductLocked(false);
      setPendingDetail({
        productId: detail.product_id,
        planQty: detail.plan_qty,
        bomVersion: detail.bom_version,
        planStart: dayVal(today()),
        planEnd: undefined,
        remark: detail.remark,
      });
      setOpen(true);
    } catch (e: any) {
      message.error(e.message);
    } finally {
      setDetailLoading(false);
    }
  }

  /**
   * 弹窗挂载完成后统一回填。
   *
   * ⚠️ 依赖必须带全 open / editing / pendingDetail：只写 [open] 会让 effect 闭包
   * 绑到旧渲染帧的 pendingDetail，某些时序下读到 null 直接 return，
   * 结果就是「打开编辑后表单全空」（物料/供应商/客户页最初就是栽在这里）。
   */
  useEffect(() => {
    if (!open) return;
    if (pendingDetail) form.setFieldsValue(pendingDetail);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editing, pendingDetail]);

  /**
   * 物料需求预览：主产品 + 计划产量齐了就拉一次（300ms 防抖，避免输数量时狂刷接口）。
   * 缺料只更新展示，**不写任何校验规则**，保存不受影响。
   */
  useEffect(() => {
    if (!open || !watchProductId || !Number(watchPlanQty)) {
      setBomPreview(null);
      return;
    }
    setBomLoading(true);
    const timer = setTimeout(() => {
      productionApi
        .bomPreview(Number(watchProductId), Number(watchPlanQty))
        .then((res: any) => setBomPreview(res?.data ?? res))
        .catch(() => setBomPreview(null))
        .finally(() => setBomLoading(false));
    }, 300);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, watchProductId, watchPlanQty]);

  /** 关闭弹窗并清理上下文，避免下次打开残留上一次的数据 */
  function closeModal() {
    setOpen(false);
    setEditing(null);
    setPendingDetail(null);
    setDetailLoading(false);
    setEditFloor(null);
    setProductLocked(false);
    setCopying(false);
    setBomPreview(null);
    setBomLoading(false);
    form.resetFields();
  }

  /** 顶部操作按钮的类型 */
  type WoAction = 'print' | 'copy' | 'receive' | 'issue' | 'edit' | 'delete';

  /**
   * 状态联动校验：返回 null 表示允许执行，否则返回提示文案并阻止执行。
   *
   * 口径与后端 workOrders.ts 的 canEdit / canReceive / delete 校验保持一致：
   * - 无 production.wo.update 权限 → 阻止「编辑」「删除」，提示无权限（而不是点了没反应）
   * - 已完工是终态：禁止编辑（前端提前提示，真正的拦截在后端 PUT，列表 canEdit 同口径）
   * - 除已完工外，编辑**不看状态**：部分领料、部分入库都允许改计划量，
   *   真正的门槛是「计划量不得低于 max(已领料, 已入库)」，由表单校验 + 提交预检 + 后端 PUT 三重兜底。
   * - 入库已满（remainQty <= 0）  → 阻止「去入库」「去领料」（料已够、无需再领/再入）
   * - 已发生领料或入库            → 阻止「删除」（后端 delete 硬性要求两者都为 0）
   * - 已完工                      → 阻止除编辑外的写操作（已入满，无需再领/再入，也不许删）
   * 打印是只读操作，不设状态门槛。
   *
   * ⚠️ 「去入库」**不再**额外判断「已领部分是否已入满」：它与后端 for-receipt 是两条路径，
   *    已领部分入满后还有「未领部分直接扣料」这条路可走（例：计划 210 / 已领 50 / 已入 50
   *    仍可再入 160）。前端只拦「计划量已入满」这一种真的没余量的情况。
   */
  function blockReason(row: any, action: WoAction): string | null {
    if (action === 'print') return null;
    // 复制本质是新建：只要能建单就能复制，不看原单状态（已完工的单也能拿来当模板）
    if (action === 'copy') return hasPerm('production.wo.create') ? null : '无新建权限';
    if ((action === 'edit' || action === 'delete') && !hasPerm('production.wo.update'))
      return '无编辑 / 删除权限';
    // 已完工是终态，禁止编辑（后端 PUT 与列表 canEdit 同口径，这里只是提前给提示）
    if (action === 'edit' && row.status === '已完工') return '已完工，禁止编辑';
    // 编辑不再因「已领料 / 已入库」被拦：部分领料、部分入库都允许改计划量
    if (action === 'edit') return null;
    if (row.status === '已完工') return '已完工';
    const remain = Number(row.remainQty ?? 0);
    if ((action === 'receive' || action === 'issue') && remain <= 0) return '已入库完成';
    if (
      action === 'delete' &&
      (Number(row.issued_qty ?? 0) > 0 || Number(row.received_qty ?? 0) > 0)
    )
      return '已发生领料或入库，禁止删除';
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
    try {
      const v = await form.validateFields();
      // 计划数量下限：不得低于「已领料数量」与「已入库数量」的较大者。
      // 字段级 validator 已拦一道，这里再拦一道并给出全局提示，防止 rules 未覆盖的时序漏过；
      // 后端 PUT 还有第三道，三处口径完全一致。
      if (editFloor && editFloor.min > 0 && Number(v.planQty) < editFloor.min - 1e-9) {
        message.error(
          `计划数量不得低于 ${editFloor.min}（已领料 ${editFloor.issued}，已入库 ${editFloor.received}）`,
        );
        return;
      }
      // 主产品锁定：与后端 PUT 同口径兜底（控件已 disabled，这里是防绕过 / 防脏数据）
      if (productLocked && pendingDetail && Number(v.productId) !== Number(pendingDetail.productId)) {
        message.error('该工单已发生领料或入库，不允许更换主产品');
        return;
      }
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
      closeModal();
      setSelectedId(null); // 操作完成后清除选中，避免下次误点到同一行
      reload();
    } catch (e: any) {
      // validateFields 失败时 e 是 { errorFields }，字段级红字已经提示过了，不再弹全局报错
      if (e?.errorFields) return;
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
              <PrintButton
                docType="work_order"
                id={selected?.id ?? 0}
                type="default"
                size="middle"
                className="btn-action"
              />
            </span>

            {/* 复制工单：以选中工单为模板开新单，放在「去入库」之前 */}
            <Button
              className="btn-action btn-key"
              icon={<CopyOutlined />}
              onClick={() => runAction('copy', (row) => void openCopy(row))}
            >
              复制工单
            </Button>

            <Button
              className="btn-action btn-key"
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
              className="btn-action btn-key"
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
              className="btn-action btn-key"
              icon={<EditOutlined />}
              onClick={() => runAction('edit', (row) => void openEdit(row))}
            >
              编辑
            </Button>

            <Button
              className="btn-action btn-danger-action"
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

      <Modal
        open={open}
        title={editing ? '编辑生产工单' : copying ? '复制新增生产工单' : '新增生产工单'}
        onCancel={closeModal}
        onOk={submit}
        // 不使用 destroyOnClose：它与 Form 的 preserve={false} 叠加会让
        // 「挂载前写入的回填值」被初始化覆盖清空（编辑弹窗全空的根因）
        destroyOnClose={false}
        forceRender
        confirmLoading={detailLoading}
      >
        {/* 渲染兜底：表单里有 Select / DatePicker / InputNumber，一旦回填值类型不对
            （如日期传了字符串）会在渲染期抛错并让整页白屏。包一层后只这块降级成错误提示。 */}
        <ErrorBoundary label="工单表单">
        {/* 单号由服务端按编码规则生成，表单里没有该字段，也就无法手填 */}
        <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 12 }}>
          工单号由系统自动生成，无需填写
        </Typography.Text>
        <Form form={form} layout="vertical" preserve={false} disabled={detailLoading}>
          <Form.Item
            name="productId"
            label="主产品"
            extra={
              productLocked
                ? '该工单已发生领料或入库，主产品不可更换（领料与入库流水均按原产品的 BOM 展开）'
                : undefined
            }
            rules={[{ required: true, message: '请选择主产品' }]}
          >
            <Select
              showSearch
              optionFilterProp="label"
              disabled={productLocked}
              options={products.map((p) => ({ value: p.id, label: `${p.code} ${p.name}` }))}
            />
          </Form.Item>
          <Form.Item
            name="planQty"
            label="计划产量"
            extra={
              editFloor && editFloor.min > 0
                ? `本单已领料 ${editFloor.issued}、已入库 ${editFloor.received}，计划数量不得低于 ${editFloor.min}`
                : undefined
            }
            rules={[
              { required: true, message: '请输入计划产量' },
              {
                // 编辑已发生领料 / 入库的工单时，计划量不得小于已发生的量（后端同样校验）
                validator: (_r, value) => {
                  if (!editFloor || editFloor.min <= 0) return Promise.resolve();
                  if (value == null || Number(value) < editFloor.min - 1e-9) {
                    return Promise.reject(
                      new Error(
                        `计划数量不得低于 ${editFloor.min}（已领料 ${editFloor.issued}，已入库 ${editFloor.received}）`,
                      ),
                    );
                  }
                  return Promise.resolve();
                },
              },
            ]}
          >
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

          {/* 物料需求预估：选了主产品 + 填了计划产量后出现。
              纯提示，缺料不校验、不拦截，建单照常可保存。 */}
          {(bomLoading || bomPreview) && (
            <>
              <Divider style={{ margin: '12px 0 8px' }} />
              <Space align="center" style={{ marginBottom: 8 }} wrap>
                <Typography.Text strong>物料需求预估</Typography.Text>
                {bomLoading && <Spin size="small" />}
                {!bomLoading && bomPreview && bomPreview.items.length > 0 && (
                  <Tag color={bomPreview.shortageCount > 0 ? 'warning' : 'success'}>
                    {bomPreview.shortageCount > 0 ? `${bomPreview.shortageCount} 项缺料` : '库存充足'}
                  </Tag>
                )}
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  缺料仅作提示，不影响建单保存
                </Typography.Text>
              </Space>
              {bomPreview && bomPreview.items.length === 0 && (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  该产品未配置 BOM，无物料需求
                </Typography.Text>
              )}
              {bomPreview && bomPreview.items.length > 0 && (
                <ResponsiveTable
                  size="small"
                  rowKey="materialId"
                  dataSource={bomPreview.items}
                  pagination={false}
                  scroll={{ y: 200 }}
                  columns={[
                    {
                      title: '物料编码',
                      dataIndex: 'materialCode',
                      width: 120,
                      render: (v) => <CopyableCode value={v} />,
                    },
                    { title: '物料名称', dataIndex: 'materialName', ellipsis: true },
                    { title: '规格', dataIndex: 'spec', width: 120, ellipsis: true },
                    {
                      title: '需求数量',
                      dataIndex: 'requireQty',
                      width: 110,
                      className: 'mono',
                      render: (v, r) => `${v}${r.unit ? ` ${r.unit}` : ''}`,
                    },
                    {
                      title: '现有库存',
                      dataIndex: 'stock',
                      width: 100,
                      className: 'mono',
                      render: (v, r) => `${v}${r.unit ? ` ${r.unit}` : ''}`,
                    },
                    {
                      title: '状态',
                      dataIndex: 'enough',
                      width: 90,
                      render: (ok, r) => (
                        <Tag color={ok ? 'success' : 'error'} title={ok ? undefined : `缺口 ${r.shortage}`}>
                          {ok ? '充足' : '缺料'}
                        </Tag>
                      ),
                    },
                  ]}
                />
              )}
            </>
          )}
        </Form>
        </ErrorBoundary>
      </Modal>
    </Card>
  );
}
