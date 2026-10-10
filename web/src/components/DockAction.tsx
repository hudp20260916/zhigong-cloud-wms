import type { ReactNode } from 'react';
import { Button } from 'antd';
import { useAuthStore } from '../stores/auth';

/**
 * 主操作按钮。
 *
 * 桌面端：就是普通按钮，位置与视觉完全不变。
 * ≤768px：通过 CSS（.dock-action）变成右下角悬浮按钮 —— 右下角是单手握持时拇指的自然热区，
 * 把它从页面顶部的 Card.extra 里「浮」出来，避免每页滚到顶部才能新建单据。
 *
 * 用法：把页面 Card extra 里的「新增 X」按钮换成 <DockAction>。
 */
export function DockAction({
  permission,
  children,
  icon,
  onClick,
  type = 'primary',
  danger,
  disabled,
  loading,
}: {
  permission?: string;
  children?: ReactNode;
  icon?: ReactNode;
  onClick: () => void;
  type?: 'primary' | 'default' | 'link' | 'text';
  danger?: boolean;
  disabled?: boolean;
  loading?: boolean;
}) {
  const has = useAuthStore((s) => s.has);
  if (permission && !has(permission)) return null;

  return (
    <Button
      className="dock-action"
      type={type}
      icon={icon}
      onClick={onClick}
      danger={danger}
      disabled={disabled}
      loading={loading}
    >
      {children}
    </Button>
  );
}

export default DockAction;
