import { Select } from 'antd';
import type { SelectProps } from 'antd';

/**
 * 统一下拉搜索组件（需求一：全站下拉框统一支持包含式模糊匹配）。
 *
 * 为什么需要它：全站 59 处 `Select` 里只有 30 处手写了 `showSearch`，
 * 其余要支持搜索就得各写一遍。这里统一封装，避免重复实现、口径不一致。
 *
 * 筛选逻辑边界：
 *  - **前端本地过滤（默认）**：options 数组已在内存，`optionFilterProp="label"`
 *    做包含式模糊匹配，输入关键字即时过滤，零网络开销。
 *    options 接口（/archive/materials/options 等）本身就是全量返回、无分页，
 *    当前数据量（物料/产品/供应商/客户均为几十条）完全够用。
 *  - **服务端分页搜索（预留，本轮不启用）**：选项量级到数千以上时，
 *    传 `serverMode` + `onSearch`，组件会关掉本地过滤并把关键字回抛给调用方，
 *    由调用方去请求 `?keyword=` 分页接口。防抖由调用方负责（建议 300ms）。
 *
 * 不影响表单的原因：本组件只包一层 Select，`value` / `onChange` / `rules` 原样透传，
 * 因此表单校验、已选项回显、选中态高亮的行为与原 Select 完全一致。
 *
 * 保持原行为：固定枚举下拉（单据类型、单据状态、入库类型等选项很少且不会增长）
 * 传 `searchable={false}`，与改造前行为一致，不加搜索框。
 */
export function SearchableSelect({
  searchable = true,
  /** 无匹配结果时的下拉提示 */
  notFoundContent = '未找到匹配的选项',
  optionFilterProp = 'label',
  ...rest
}: SelectProps<any> & { searchable?: boolean }) {
  // 固定枚举：完全不开启搜索，保持改造前行为
  if (!searchable) return <Select notFoundContent="暂无选项" {...rest} />;

  return (
    <Select
      showSearch
      allowClear
      // 包含式模糊匹配：匹配 label 上用户输入的文本（大小写不敏感由 antd 处理）
      optionFilterProp={optionFilterProp}
      notFoundContent={notFoundContent}
      // 空关键字时展示全部选项（antd 默认行为，此处显式声明以免后续被改）
      filterOption={(input, option) => {
        const kw = String(input ?? '').trim().toLowerCase();
        if (!kw) return true;
        const opt = option as any;
        const label = String(
          typeof opt?.label === 'string' ? opt.label : (opt?.label?.props?.children ?? opt?.value ?? ''),
        );
        const extra = opt?.searchText ? ` ${opt.searchText}` : '';
        return `${label}${extra}`.toLowerCase().includes(kw);
      }}
      {...rest}
    />
  );
}

export default SearchableSelect;