import dayjs from 'dayjs';

/**
 * 把后端/表单里保存的字符串日期转成 antd DatePicker 需要的 Dayjs 对象。
 *
 * 页面状态统一保存「YYYY-MM-DD」字符串（与提交给后端的格式一致），
 * 传给 DatePicker 时再用它包一层 —— 之前多个页面直接 `value={x as any}` 把字符串塞进去，
 * 在 antd v5 会直接抛错导致整个页面白屏（移动端验证时发现）。
 */
export function dayVal(v?: string | null): dayjs.Dayjs | undefined {
  if (!v) return undefined;
  const d = dayjs(v);
  return d.isValid() ? d : undefined;
}
