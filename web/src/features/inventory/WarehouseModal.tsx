import { useEffect, useState } from 'react';
import { Form, Input, Modal, Radio, Switch, message } from 'antd';
import { inventoryApi } from '../../api';
import { clearWarehouseOptionsCache } from '../../components';

/**
 * 新增 / 编辑仓库。
 *
 * 三条产品口径（平哥确认）：
 *  1. 新建时「仓库类型」默认选中**主仓库**（成品和物料都能放）；
 *  2. 仓库名称可编辑，必填，且与全库已有仓库重名时直接拦下（服务端兜底 + 前端即时提示）；
 *  3. 保存成功后由调用方刷新列表与筛选下拉（onSaved 回调），保证新仓立刻可选。
 */

export interface WarehouseRow {
  id: number;
  code: string;
  name: string;
  kind: 'main' | 'material' | 'product';
  is_default: number;
  status: string;
  remark?: string | null;
}

const KINDS = [
  { value: 'main', label: '主仓库', hint: '成品与物料都能存放' },
  { value: 'material', label: '物料库', hint: '只存放物料' },
  { value: 'product', label: '成品库', hint: '只存放成品' },
] as const;

export default function WarehouseModal({
  open,
  editing,
  onClose,
  onSaved,
}: {
  open: boolean;
  /** 传了就是编辑，不传是新增 */
  editing?: WarehouseRow | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form] = Form.useForm();
  const [submitting, setSubmitting] = useState(false);
  const isEdit = !!editing;

  // 弹窗打开后再写表单，且依赖带全 editing —— 与全系统回填修法一致，避免空表单
  useEffect(() => {
    if (!open) return;
    if (editing) {
      form.setFieldsValue({
        code: editing.code,
        name: editing.name,
        kind: editing.kind,
        isDefault: Number(editing.is_default) === 1,
        status: editing.status,
        remark: editing.remark ?? '',
      });
    } else {
      // 新增：类型默认「主仓库」，名称留空由用户填
      form.setFieldsValue({
        code: '',
        name: '',
        kind: 'main',
        isDefault: false,
        status: '启用',
        remark: '',
      });
    }
  }, [open, editing, form]);

  async function submit() {
    const v = await form.validateFields().catch(() => null);
    if (!v) return;
    setSubmitting(true);
    try {
      const body = {
        code: String(v.code ?? '').trim(),
        name: String(v.name ?? '').trim(),
        kind: v.kind,
        isDefault: !!v.isDefault,
        status: v.status ?? '启用',
        remark: String(v.remark ?? '').trim(),
      };
      if (isEdit && editing) {
        await inventoryApi.updateWarehouse(editing.id, body);
        message.success('仓库已修改');
      } else {
        await inventoryApi.createWarehouse(body);
        message.success('仓库已新增');
      }
      clearWarehouseOptionsCache(); // 其它页面的仓库下拉要立刻看到新仓
      onSaved();
      onClose();
    } catch (e: any) {
      // 重名/编码冲突由服务端返回 409，原样展示
      message.error(e?.message ?? '保存失败，请重试');
    } finally {
      setSubmitting(false);
    }
  }

  const kind = Form.useWatch('kind', form) ?? 'main';
  const hint = KINDS.find((k) => k.value === kind)?.hint ?? '';

  return (
    <Modal
      open={open}
      title={isEdit ? `修改仓库「${editing?.name ?? ''}」` : '新增仓库'}
      onCancel={onClose}
      onOk={submit}
      confirmLoading={submitting}
      okText="保存"
      cancelText="取消"
      width={480}
      destroyOnClose={false}
      forceRender
    >
      <Form form={form} layout="vertical" disabled={submitting} preserve={false}>
        <Form.Item
          name="name"
          label="仓库名称"
          rules={[
            { required: true, message: '请输入仓库名称' },
            { whitespace: true, message: '仓库名称不能为空' },
            { max: 50, message: '仓库名称不能超过 50 个字' },
          ]}
        >
          <Input placeholder="如：成品二库" maxLength={50} allowClear />
        </Form.Item>

        <Form.Item name="kind" label="仓库类型" rules={[{ required: true, message: '请选择仓库类型' }]}>
          <Radio.Group optionType="button" buttonStyle="solid">
            {KINDS.map((k) => (
              <Radio.Button key={k.value} value={k.value}>
                {k.label}
              </Radio.Button>
            ))}
          </Radio.Group>
        </Form.Item>
        {hint && (
          <div style={{ marginTop: -12, marginBottom: 12, fontSize: 12, color: '#8c8c8c' }}>{hint}</div>
        )}

        <Form.Item
          name="code"
          label="仓库编码"
          extra="留空由系统自动生成（W + 序号）"
          rules={[{ max: 20, message: '仓库编码不能超过 20 个字符' }]}
        >
          <Input placeholder="如：CP2" maxLength={20} allowClear />
        </Form.Item>

        <Form.Item name="isDefault" label="设为该类型的默认仓" valuePropName="checked">
          <Switch />
        </Form.Item>
        <div style={{ marginTop: -12, marginBottom: 12, fontSize: 12, color: '#8c8c8c' }}>
          出入库未指定仓库时，默认归入该类型的默认仓
        </div>

        <Form.Item name="status" label="状态">
          <Radio.Group>
            <Radio value="启用">启用</Radio>
            <Radio value="停用">停用</Radio>
          </Radio.Group>
        </Form.Item>

        <Form.Item name="remark" label="备注">
          <Input.TextArea rows={2} maxLength={200} />
        </Form.Item>
      </Form>
    </Modal>
  );
}
