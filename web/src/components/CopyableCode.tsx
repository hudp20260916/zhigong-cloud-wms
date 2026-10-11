import { Typography } from 'antd';

/**
 * 可复制的单号文本（需求 31：所有板块的单号都要有复制功能）。
 *
 * 直接用 antd 的 Typography.Text copyable，不自己操作剪贴板：
 *  - 自带复制图标、成功态与 tooltip，行为和其他页面一致；
 *  - 内部已经处理了 navigator.clipboard 不可用时的降级；
 *  - 表格里每行一个实例没有额外开销（只在点击时才访问剪贴板）。
 *
 * 空值统一渲染成 '-'，避免在列表里出现「复制一个空字符串」的按钮。
 */
export function CopyableCode({
  value,
  copyable = true,
}: {
  value?: string | null;
  /** 置 false 可退化成纯文本（个别页面单号列太窄时用） */
  copyable?: boolean;
}) {
  const text = value == null || String(value).trim() === '' ? '' : String(value);

  if (!text) return <span style={{ color: '#bbb' }}>-</span>;

  if (!copyable) return <span className="mono">{text}</span>;

  return (
    <Typography.Text
      className="mono"
      style={{ cursor: 'text' }}
      copyable={{
        text,
        tooltips: ['复制单号', '已复制'],
        // 阻止冒泡：单号列常被放在可点击展开的行里，点复制不应触发行展开
        onCopy: undefined,
      }}
      onClick={(e) => e.stopPropagation()}
    >
      {text}
    </Typography.Text>
  );
}

export default CopyableCode;
