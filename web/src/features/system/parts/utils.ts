/**
 * Excel 导入页的纯函数工具层。
 *
 * 全部是无副作用的纯函数，单独拆出来有两个好处：
 *  1. 解析/映射逻辑可以脱离 React 单测；
 *  2. 页面组件里只剩渲染，改动时不容易把数据逻辑改坏。
 */

export interface ColumnDef {
  key: string;
  label: string;
  required?: boolean;
  /** 该字段在同一批里必须唯一（如物料编码、供应商编码） */
  unique?: boolean;
}

export interface ImportDef {
  kind: string;
  name: string;
  hint?: string;
  columns: ColumnDef[];
}

/** 表头中文 -> 字段 key；同时兼容直接用英文 key 当表头 */
export function buildHeaderMap(columns: ColumnDef[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const c of columns) {
    m.set(c.label, c.key);
    m.set(c.key, c.key);
  }
  return m;
}

/**
 * 把 sheet_to_json 出来的二维数组映射成对象数组。
 * Excel 行号从 1 开始、且第 1 行是表头，所以数据行在文件里的行号是 index + 2。
 */
export function mapRows(raw: any[][], headerMap: Map<string, string>): any[] {
  const [header, ...body] = raw;
  return body.map((line) => {
    const obj: any = {};
    (header ?? []).forEach((h: any, i: number) => {
      const key = headerMap.get(String(h ?? '').trim());
      if (key) obj[key] = line?.[i];
    });
    return obj;
  });
}

/**
 * 找出「特殊行」：整行全空的行、以及关键字段在同一批内重复的行。
 *
 * 注意：这里只做不查库的自检，真正的唯一性/外键校验在服务端（要查库）。
 * 返回的行号是**文件中的真实行号**（表头占第 1 行，所以数据行从 2 开始）。
 */
export function mapSpecialRows(
  rows: any[],
  columns: ColumnDef[],
): { empty: number[]; duplicated: Map<number, string>; dupCount: number } {
  const empty: number[] = [];
  const duplicated = new Map<number, string>();
  const seen = new Map<string, number>();
  let dupCount = 0;

  const uniqueKeys = columns.filter((c) => c.unique).map((c) => c.key);

  rows.forEach((r, i) => {
    const fileRow = i + 2;

    // 整行全空：Excel 里很常见（用户拖选时多选了空白行）
    const isEmpty = Object.values(r ?? {}).every(
      (v) => v === undefined || v === null || String(v).trim() === '',
    );
    if (isEmpty) {
      empty.push(fileRow);
      return;
    }

    for (const key of uniqueKeys) {
      const v = String(r?.[key] ?? '').trim();
      if (!v) continue;
      if (seen.has(v)) {
        duplicated.set(fileRow, `与第 ${seen.get(v)} 行的「${v}」重复`);
        dupCount += 1;
      } else {
        seen.set(v, fileRow);
      }
    }
  });

  return { empty, duplicated, dupCount };
}

/** 单元格为空时的占位渲染判断 */
export function isBlank(v: any): boolean {
  return v === undefined || v === null || String(v).trim() === '';
}

/** 下载模板用的表头数组 */
export function templateHeader(columns: ColumnDef[]): string[] {
  return columns.map((c) => c.label);
}
