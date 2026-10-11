import { useCallback, useState } from 'react';

/**
 * 列表行展开详情的通用取数逻辑（需求 5/6/10/12/13）。
 *
 * 之所以不直接在 expandedRowRender 里发请求：展开区每次重渲染都会触发，
 * 会打出成倍的接口调用。这里按行 id 缓存，展开过的行不再重复请求。
 *
 * 取数失败时**不写缓存**，这样用户再点一次会重新尝试，而不是永远空白。
 */
export function useRowDetail<T = any>(loader: (id: number) => Promise<T>) {
  const [cache, setCache] = useState<Record<number, T>>({});
  const [loading, setLoading] = useState<Record<number, boolean>>({});

  const load = useCallback(
    async (id: number) => {
      if (cache[id] !== undefined) return;
      setLoading((prev) => ({ ...prev, [id]: true }));
      try {
        const data = await loader(id);
        setCache((prev) => ({ ...prev, [id]: data }));
      } catch {
        // 错误由调用方的 message 统一提示，这里只负责不缓存失败结果
      } finally {
        setLoading((prev) => ({ ...prev, [id]: false }));
      }
    },
    [cache, loader],
  );

  return { cache, loading, load };
}

export default useRowDetail;
