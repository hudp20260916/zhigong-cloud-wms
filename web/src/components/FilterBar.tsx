import type { ReactNode } from 'react';
import { Button, Space } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';

/**
 * 列表页筛选栏（B 组需求的统一容器）。
 *
 * 只负责排布和「重置」按钮，具体控件由调用方传进来
 * —— 不同页面的筛选项差异太大（日期范围 / 下拉 / 包含字），硬塞进一个配置化组件
 * 反而会让每个页面都在适配它。
 */
export function FilterBar({
  children,
  onReset,
  extra,
}: {
  children: ReactNode;
  /** 传了才显示重置按钮 */
  onReset?: () => void;
  /** 右侧附加内容（一般是导出按钮） */
  extra?: ReactNode;
}) {
  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 8,
        alignItems: 'center',
        marginBottom: 12,
      }}
    >
      <Space wrap size={8}>
        {children}
        {onReset && (
          <Button size="small" icon={<ReloadOutlined />} onClick={onReset}>
            重置
          </Button>
        )}
      </Space>
      {extra && <div style={{ marginLeft: 'auto' }}>{extra}</div>}
    </div>
  );
}

export default FilterBar;
