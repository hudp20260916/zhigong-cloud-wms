import { useState } from 'react';
import type { Key, MouseEvent, ReactNode } from 'react';
import { Button, Modal, Space, message } from 'antd';
import { useAuthStore } from '../stores/auth';

/**
 * 列表页「选中一行 → 点顶部按钮」的统一实现（范式来自生产工单页）。
 *
 * 为什么要集中到顶部：单据类列表普遍有 8~12 列，操作按钮塞在每行末尾会让
 * 几十条数据的页面非常杂乱，而且小屏卡片模式下一行塞 4 个按钮必换行。
 * 统一成「先选中、再操作」后，按钮只出现一次，样式与间距也才能真正统一。
 *
 * 三个组成部分：
 * - `useRowSelect`：选中行的状态 + antd Table 的 rowSelection 配置 + 卡片模式点击回调
 * - `TopActionBar`：顶部操作区容器（通常放在 FilterBar 的 extra 上）
 * - `RowActionButton`：单个操作按钮，内置「未选中 / 无权限 / 状态不允许」三道提示
 *
 * ⚠️ 移除行内操作列时必须同时给 ResponsiveTable 传 onRowClick：
 *    卡片模式的底部按钮取自操作列，操作列一删，小屏就彻底没有操作入口了。
 */

/**
 * 选中行状态。selectedRowKeys / onRowClick 直接喂给 ResponsiveTable 即可。
 *
 * @param keyOf 行主键取值函数，默认取 `row.id`。
 *   复合主键的表格（如预警页 rowKey 是 `itemType-id`）必须传，否则选中态对不上。
 */
export function useRowSelect(
  keyOf: (row: any) => string | number = (row: any) => row.id,
  options?: { columnWidth?: number },
) {
  const [selectedId, setSelectedId] = useState<string | number | null>(null);
  return {
    selectedId,
    setSelectedId,
    clearSelection: () => setSelectedId(null),
    /** 桌面端单选（直接传给 ResponsiveTable） */
    rowSelection: {
      type: 'radio' as const,
      selectedRowKeys: selectedId === null ? [] : ([selectedId] as Key[]),
      onChange: (keys: Key[]) => setSelectedId(keys.length ? (keys[0] as string | number) : null),
      // 不传时走 antd 默认宽度；生产工单页显式传 44 保持原有列宽
      columnWidth: options?.columnWidth,
    },
    /**
     * 行点击回调（直接传给 ResponsiveTable）。
     * ResponsiveTable 已统一处理桌面端表格行与移动端卡片两种形态，
     * 并自动排除行内按钮 / 链接 / 展开箭头 / 勾选列，所以这里只管选中逻辑本身。
     * 再点一次已选中的行 = 取消选中（与生产工单页原来的行为保持一致）。
     */
    onRowClick: (row: any) => {
      if (row == null) return setSelectedId(null);
      const k = keyOf(row);
      setSelectedId((prev) => (prev !== null && String(prev) === String(k) ? null : k));
    },
    /** 与 keyOf 配套：判断某行是否当前选中行 */
    isSelected: (row: any) => row != null && selectedId !== null && keyOf(row) === selectedId,
  };
}

/**
 * 顶部操作区容器。放在 FilterBar 的 extra 里时由 FilterBar 负责靠右，
 * 单独使用时可用 pushRight 让它右对齐。
 */
export function TopActionBar({
  children,
  pushRight = false,
}: {
  children: ReactNode;
  pushRight?: boolean;
}) {
  return (
    <Space size={8} wrap style={pushRight ? { marginLeft: 'auto' } : undefined}>
      {children}
    </Space>
  );
}

export interface RowActionButtonProps {
  /** 按钮文案 */
  text: ReactNode;
  icon?: ReactNode;
  /** 当前选中行（来自 useRowSelect 的 selectedId 在列表里查出来） */
  selected?: any;
  /** 未选中时的提示主体，如「工单」→「请先选择一条工单」 */
  tipName?: string;
  /** 权限点；无权限时默认不渲染（与 PermGate 行为一致） */
  permission?: string;
  /** false 时无权限也渲染，点击提示无权限（生产工单页用这种，避免「按钮去哪了」的困惑） */
  hideWhenNoPermission?: boolean;
  /** key = 主题色描边高亮（编辑 / 去入库等主操作）；default = 常规按钮 */
  variant?: 'key' | 'default';
  /**  danger = 删除类（红色描边，同尺寸） */
  danger?: boolean;
  /** 状态门禁：返回 null 放行，返回文案则拦截并提示 */
  disabledReason?: (row: any) => string | null;
  /** 传了就走 Modal.confirm 二次确认（删除类用） */
  confirm?: (row: any) => { title?: string; content: ReactNode };
  onAction: (row: any) => void;
  size?: 'small' | 'middle' | 'large';
  type?: 'primary' | 'default';
}

export function RowActionButton({
  text,
  icon,
  selected,
  tipName = '记录',
  permission,
  hideWhenNoPermission = true,
  variant = 'key',
  danger = false,
  disabledReason,
  confirm,
  onAction,
  size,
  type = 'default',
}: RowActionButtonProps) {
  const has = useAuthStore((s) => s.has);
  const permitted = permission ? has(permission) : true;

  if (!permitted && hideWhenNoPermission) return null;

  function handleClick() {
    if (!permitted) {
      message.warning('无该操作权限，请联系管理员');
      return;
    }
    if (!selected) {
      message.warning(`请先选择一条${tipName}`);
      return;
    }
    const reason = disabledReason?.(selected) ?? null;
    if (reason) {
      message.warning(reason);
      return;
    }
    if (confirm) {
      const cfg = confirm(selected);
      Modal.confirm({
        title: cfg.title ?? '确认操作',
        content: cfg.content,
        okText: '确定',
        cancelText: '取消',
        onOk: () => onAction(selected),
      });
      return;
    }
    onAction(selected);
  }

  const className = danger
    ? 'btn-action btn-danger-action'
    : variant === 'key'
      ? 'btn-action btn-key'
      : 'btn-action';

  return (
    <Button className={className} icon={icon} danger={danger} type={type} size={size} onClick={handleClick}>
      {text}
    </Button>
  );
}

/**
 * 非 Button 形态的操作（如 PrintButton）用的拦截壳。
 *
 * 这类组件自带点击行为，没法直接挂 onClick，所以在**捕获阶段**拦下点击：
 * 未选中或状态不允许时 preventDefault + stopPropagation，只提示、不触发内部行为。
 */
export function RowActionGate({
  selected,
  tipName = '记录',
  disabledReason,
  children,
}: {
  selected?: any;
  tipName?: string;
  disabledReason?: (row: any) => string | null;
  children: ReactNode;
}) {
  function onCapture(e: MouseEvent) {
    if (!selected) {
      e.preventDefault();
      e.stopPropagation();
      message.warning(`请先选择一条${tipName}`);
      return;
    }
    const reason = disabledReason?.(selected) ?? null;
    if (reason) {
      e.preventDefault();
      e.stopPropagation();
      message.warning(reason);
    }
  }
  return <span onClickCapture={onCapture}>{children}</span>;
}

export default RowActionButton;
