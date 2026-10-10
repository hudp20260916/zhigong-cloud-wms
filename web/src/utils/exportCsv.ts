/**
 * 导出为 CSV（带 UTF-8 BOM，Excel 直接打开不乱码）。
 * MVP 阶段先用 CSV 承载导出，后续可平滑替换为 xlsx 库，调用方不变。
 */
export interface ExportColumn<T> {
  title: string;
  key: string;
  render?: (row: T) => any;
}

export function exportCsv<T>(filename: string, columns: ExportColumn<T>[], rows: T[]): void {
  const header = columns.map((c) => escapeCsv(c.title)).join(',');
  const body = rows.map((row) =>
    columns
      .map((c) => {
        const v = c.render ? c.render(row) : (row as any)[c.key];
        return escapeCsv(v === null || v === undefined ? '' : String(v));
      })
      .join(','),
  );

  const content = `\uFEFF${[header, ...body].join('\r\n')}`;
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename.endsWith('.csv') ? filename : `${filename}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function escapeCsv(v: string): string {
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export function today(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
