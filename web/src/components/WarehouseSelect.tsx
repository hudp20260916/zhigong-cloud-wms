import { useCallback, useEffect, useState } from 'react';
import { Select, Spin } from 'antd';
import { inventoryApi } from '../api';
import type { ItemType } from '@shared/enums';

export interface WarehouseOption {
  id: number;
  code: string;
  name: string;
  kind: 'main' | 'material' | 'product';
  kindLabel: string;
  isDefault: boolean;
  status: string;
}

/**
 * 仓库下拉数据源。按品类过滤（物料不会出现在成品仓选项里），全系统共用一份。
 * 复用同一份 Promise 缓存，避免一个页面上 3 个下拉各拉一次。
 */
const cache = new Map<string, Promise<WarehouseOption[]>>();

export function useWarehouseOptions(itemType?: ItemType): {
  options: WarehouseOption[];
  loading: boolean;
  reload: () => void;
} {
  const key = itemType ?? 'all';
  const [options, setOptions] = useState<WarehouseOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    // 新增/停用仓库后要能拿到最新列表，所以带 nonce 强刷
    const p =
      nonce === 0 && cache.has(key)
        ? cache.get(key)!
        : inventoryApi.warehouseOptions(itemType).then((r: any) => (Array.isArray(r) ? r : []));
    if (nonce === 0) cache.set(key, p);
    p.then((rows) => {
      if (alive) setOptions(rows);
    })
      .catch(() => {
        if (alive) setOptions([]);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [key, itemType, nonce]);

  const reload = useCallback(() => {
    cache.delete(key);
    setNonce((n) => n + 1);
  }, [key]);

  return { options, loading, reload };
}

/** 清掉缓存：新增/停用仓库后调用，保证其它页面的下拉立刻刷新 */
export function clearWarehouseOptionsCache() {
  cache.clear();
}

export interface WarehouseSelectProps {
  /** 物料还是成品 —— 决定可选哪些仓 */
  itemType: ItemType;
  value?: number | null;
  onChange?: (v: number | null) => void;
  /** 表单里的占位文案；不传时自动提示默认仓 */
  placeholder?: string;
  /** 是否必选（true 时不给「未选」这个选项，也没法清空） */
  required?: boolean;
  disabled?: boolean;
  style?: React.CSSProperties;
  /** 是否显示「未选择时归入 XXX」的浅色说明，默认显示 */
  showHint?: boolean;
}

/**
 * 出入库表单的「选择仓库」。
 *
 * 口径（与服务端一致）：
 *  - 只列出能容纳该品类且已启用的仓；
 *  - 未选择时不报错 —— 服务端按该品类的默认仓兜底，界面上明确告诉用户会落到哪个仓，
 *    这样历史数据（物料→物料库、成品→成品库）与老业务流程都不受影响。
 */
export function WarehouseSelect({
  itemType,
  value,
  onChange,
  placeholder,
  required = false,
  disabled = false,
  style,
  showHint = true,
}: WarehouseSelectProps) {
  const { options, loading } = useWarehouseOptions(itemType);
  const usable = options.filter((w) => w.status === '启用');
  const def = usable.find((w) => w.isDefault) ?? usable[0];

  return (
    <div>
      <Select
        value={value ?? undefined}
        onChange={(v) => onChange?.(v ?? null)}
        disabled={disabled || loading}
        allowClear={!required}
        style={{ width: '100%', ...style }}
        placeholder={placeholder ?? (def ? `默认：${def.name}` : '请选择仓库')}
        suffixIcon={loading ? <Spin size="small" /> : undefined}
        options={usable.map((w) => ({
          value: w.id,
          label: w.isDefault ? `${w.name}（默认）` : w.name,
        }))}
        notFoundContent={loading ? '加载中…' : '暂无可用仓库'}
      />
      {showHint && !value && def && (
        <div style={{ marginTop: 4, fontSize: 12, color: '#8c8c8c' }}>
          未选择时归入「{def.name}」
        </div>
      )}
    </div>
  );
}

export default WarehouseSelect;
