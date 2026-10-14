import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Button, Checkbox, Divider, Popover, Space, Tooltip, Typography } from 'antd';
import { SettingOutlined } from '@ant-design/icons';

/**
 * 表格「列显示设置」。
 *
 * 用法（三步，页面侧只改 3 行）：
 *   1. 把原来的 columns 提成模块级常量 `ALL_COLUMNS`；
 *   2. `const { hiddenKeys, setHiddenKeys } = useColumnHidden({ storageKey: 'xxx.columns' })`；
 *   3. 工具栏放 `<ColumnSettings .../>`，表格传 `visibleColumnsOf(ALL_COLUMNS, hiddenKeys)`。
 *
 * 设计上刻意做成「受控 + 无状态组件」：可见性存哪（内存 / localStorage）由页面决定，
 * 组件只负责渲染勾选面板并回调，避免以后别的页面想接后端用户偏好时要改组件。
 *
 * 防呆：锁定列（默认第一列）永远可见，且「只剩一列可见」时该列复选框禁用，
 * 两道保险确保不会出现「所有列被全部隐藏」的空表格。
 */

export interface ColumnOption {
  key: string;
  title: ReactNode;
}

/** 列在设置面板里的身份：优先显式 key，其次 dataIndex，都没有就退化为序号 */
export function columnKeyOf(col: any, index: number): string {
  return String(col?.key ?? col?.dataIndex ?? `col-${index}`);
}

/** 从表格列定义里抽出「可设置项」，顺序与表格完全一致 */
export function columnOptionsOf(columns: any[]): ColumnOption[] {
  return columns.map((c, i) => ({
    key: columnKeyOf(c, i),
    title: (c?.title as ReactNode) ?? `第 ${i + 1} 列`,
  }));
}

/** 按勾选结果过滤表格列（顺序保持原样，未勾选的列直接不传给 Table） */
export function visibleColumnsOf<T extends { key?: any; dataIndex?: any }>(
  columns: T[],
  hiddenKeys: string[],
): T[] {
  const keys = columns.map((c, i) => columnKeyOf(c, i));
  return columns.filter((_, i) => !hiddenKeys.includes(keys[i]));
}

/**
 * 列的隐藏集合。
 *
 * storageKey 给了就做本地持久化（刷新后仍生效）；
 * validKeys 用来丢掉历史遗留的脏 key（列改名 / 删列后不至于永久隐藏新列）。
 */
export function useColumnHidden(options?: { storageKey?: string; validKeys?: string[] }) {
  const storageKey = options?.storageKey;
  const validKeys = options?.validKeys;

  const [hiddenKeys, setHiddenKeys] = useState<string[]>(() => {
    if (!storageKey) return [];
    let saved: unknown = null;
    try {
      const raw = localStorage.getItem(storageKey);
      saved = raw ? JSON.parse(raw) : null;
    } catch {
      saved = null;
    }
    const arr = Array.isArray(saved) ? saved.filter((x): x is string => typeof x === 'string') : [];
    return validKeys ? arr.filter((k) => validKeys.includes(k)) : arr;
  });

  const update = (keys: string[]) => {
    setHiddenKeys(keys);
    if (!storageKey) return;
    try {
      if (keys.length === 0) localStorage.removeItem(storageKey);
      else localStorage.setItem(storageKey, JSON.stringify(keys));
    } catch {
      /* 隐私模式下 localStorage 不可写，忽略即可，不影响本次会话使用 */
    }
  };

  return { hiddenKeys, setHiddenKeys: update };
}

export interface ColumnSettingsProps {
  /** 表格的**全量**列定义（顺序即面板里的顺序） */
  columns: any[];
  /** 当前隐藏的列 key */
  hiddenKeys: string[];
  onChange: (hiddenKeys: string[]) => void;
  /** 锁定列（不可隐藏）。不传时默认锁定第一列 */
  lockedKeys?: string[];
  /** 「恢复默认」的目标：默认视为全部显示 */
  defaultHiddenKeys?: string[];
  /** 按钮文案 */
  text?: string;
}

export function ColumnSettings({
  columns,
  hiddenKeys,
  onChange,
  lockedKeys,
  defaultHiddenKeys,
  text = '设置',
}: ColumnSettingsProps) {
  const options = useMemo(() => columnOptionsOf(columns), [columns]);
  const allKeys = useMemo(() => options.map((o) => o.key), [options]);

  const locked = useMemo(
    () => new Set(lockedKeys && lockedKeys.length ? lockedKeys : allKeys.slice(0, 1)),
    [lockedKeys, allKeys],
  );
  const defaults = useMemo(
    () => (defaultHiddenKeys ?? []).filter((k) => allKeys.includes(k) && !locked.has(k)),
    [defaultHiddenKeys, allKeys, locked],
  );

  const visibleCount = options.filter((o) => !hiddenKeys.includes(o.key)).length;

  function toggle(key: string, checked: boolean) {
    onChange(checked ? hiddenKeys.filter((k) => k !== key) : [...hiddenKeys, key]);
  }

  /** 全选：一列都不隐藏 */
  function selectAll() {
    onChange([]);
  }

  /**
   * 取消全选：只留锁定列。
   * 之所以不是「全隐藏」，是因为表格全空既没法看数据也没法再点开设置按钮恢复，
   * 锁定列这道保险就是要保证任何时候屏幕上都还有内容。
   */
  function clearAll() {
    onChange(allKeys.filter((k) => !locked.has(k)));
  }

  function resetDefault() {
    onChange(defaults);
  }

  const content = (
    <div style={{ width: 248 }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 6,
        }}
      >
        <Typography.Text strong>显示列</Typography.Text>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          已显示 {visibleCount} / {options.length}
        </Typography.Text>
      </div>
      <Space size={0} wrap>
        <Button size="small" type="link" onClick={selectAll}>
          全选
        </Button>
        <Button size="small" type="link" onClick={clearAll}>
          取消全选
        </Button>
        <Button size="small" type="link" onClick={resetDefault}>
          恢复默认
        </Button>
      </Space>
      <Divider style={{ margin: '6px 0' }} />
      <div style={{ maxHeight: 320, overflowY: 'auto' }}>
        <Space direction="vertical" size={2} style={{ width: '100%' }}>
          {options.map((o) => {
            const checked = !hiddenKeys.includes(o.key);
            const isLocked = locked.has(o.key);
            // 只剩这一列可见时不允许再取消（最后一道保险）
            const isLastOne = checked && visibleCount === 1;
            const disabled = isLocked || isLastOne;
            const box = (
              <Checkbox
                checked={checked}
                disabled={disabled}
                onChange={(e) => toggle(o.key, e.target.checked)}
              >
                {o.title}
                {isLocked ? (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    （固定）
                  </Typography.Text>
                ) : null}
              </Checkbox>
            );
            return (
              <div key={o.key}>
                {isLastOne && !isLocked ? (
                  <Tooltip title="至少保留一列可见" placement="right">
                    {/* 禁用元素不派发鼠标事件，包一层 span 让 Tooltip 能挂上 */}
                    <span style={{ display: 'inline-block', cursor: 'not-allowed' }}>{box}</span>
                  </Tooltip>
                ) : (
                  box
                )}
              </div>
            );
          })}
        </Space>
      </div>
    </div>
  );

  return (
    <Popover content={content} trigger="click" placement="bottomRight" destroyTooltipOnHide>
      <Button icon={<SettingOutlined />}>{text}</Button>
    </Popover>
  );
}
