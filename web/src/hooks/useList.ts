import { useCallback, useEffect, useRef, useState } from 'react';
import type { ListResult } from '../api/client';

export interface ListParams {
  page: number;
  pageSize: number;
  keyword?: string;
  [key: string]: any;
}

/**
 * 列表数据加载。
 * fetcher 用 ref 持有，避免内联函数造成依赖抖动与重复请求。
 */
export function useList<T>(fetcher: (p: ListParams) => Promise<ListResult<T>>, initial: Partial<ListParams> = {}) {
  const [params, setParams] = useState<ListParams>({
    page: 1,
    pageSize: 20,
    keyword: '',
    ...initial,
  });
  const [list, setList] = useState<T[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);

  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetcherRef.current(params);
      setList(res.list ?? []);
      setTotal(res.total ?? 0);
    } catch (e) {
      setList([]);
      setTotal(0);
      throw e;
    } finally {
      setLoading(false);
    }
  }, [params]);

  useEffect(() => {
    reload().catch(() => undefined);
  }, [reload]);

  return {
    list,
    total,
    loading,
    params,
    setParams,
    reload,
    /** 修改筛选条件时重置到第一页 */
    patchParams: (p: Partial<ListParams>) => setParams((prev) => ({ ...prev, page: 1, ...p })),
  };
}
