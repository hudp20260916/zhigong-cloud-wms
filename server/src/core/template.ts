/**
 * 极简模板引擎（mustache-lite）。
 *
 * 只支持两种语法，够用且安全：
 *   {{field}}                  变量，自动 HTML 转义
 *   {{#items}} ... {{/items}}  数组循环，循环体内可访问行字段与顶层字段
 *
 * 取舍：不引入 handlebars / mustache 这类完整引擎 —— 打印模板是给管理员改的，
 * 语法越简单越不容易改坏；且渲染必须发生在服务端，保证「入库单号不出现在打印件」
 * 这条硬需求只有一个出口可控（前端拿到的永远是渲染后的 HTML）。
 */

const ESCAPE_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(v: unknown): string {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ESCAPE_MAP[c]);
}

/** 数字去掉浮点尾巴：12.00 -> 12，12.50 -> 12.5 */
export function fmtValue(v: unknown): string {
  if (v === null || v === undefined || v === '') return '';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return '';
    return String(Math.round(v * 100) / 100);
  }
  return String(v);
}

export function renderTemplate(tpl: string, data: Record<string, any>): string {
  // 先展开循环，循环体内递归渲染（支持一层嵌套）
  const withLoops = tpl.replace(
    /\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g,
    (_m, key: string, inner: string) => {
      const arr = (data as any)[key];
      if (!Array.isArray(arr)) return '';
      return arr
        .map((row: any, i: number) =>
          renderTemplate(inner, { ...data, ...row, __index: i + 1 }),
        )
        .join('');
    },
  );

  return withLoops.replace(/\{\{(\w+)\}\}/g, (_m, key: string) => {
    const v = (data as any)[key];
    return escapeHtml(fmtValue(v));
  });
}
