import type { Request } from 'express';
import { db } from '../db/index.js';

export interface PageParams {
  page: number;
  pageSize: number;
  offset: number;
  keyword: string;
}

export function parsePage(req: Request): PageParams {
  const page = Math.max(1, Number(req.query.page ?? 1) || 1);
  /**
   * 上限 50000 而不是 200：B 组需求要求「导出时只导出筛选结果」，
   * 前端导出会带同样的筛选条件再请求一次并传一个大 pageSize，
   * 否则只能导出当前页的 20 条。列表默认仍取 20，只有显式传大值才会放大。
   */
  const pageSize = Math.min(50000, Math.max(1, Number(req.query.pageSize ?? 20) || 20));
  return {
    page,
    pageSize,
    offset: (page - 1) * pageSize,
    keyword: String(req.query.keyword ?? '').trim(),
  };
}

/**
 * 名称排序片段：空值恒排末尾（需求 4.8），其余按名称升/降序。
 * 直接拼进 SQL，调用方需保证 dir 只取 ASC / DESC。
 */
export function nameOrderSql(column: string, dir: string): string {
  const d = dir.toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
  return `CASE WHEN ${column} IS NULL OR ${column} = '' THEN 1 ELSE 0 END ASC, ${column} COLLATE NOCASE ${d}`;
}

export function normalizeDir(v: unknown): 'ASC' | 'DESC' {
  return String(v ?? '').toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
}

export function countRows(table: string, where = '1=1', params: any[] = []): number {
  const row = db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE ${where}`).get(...params) as {
    c: number;
  };
  return row.c;
}
