/**
 * 品牌名（公司名称）的唯一前端来源 —— 动态版。
 *
 * 数据链路：数据库 app_settings 的 `company.name`（系统参数 → 企业信息 → 公司名称）
 *   → 免登录接口 GET /auth/brand → 本模块的 brandStore
 *   → 全站通过 useBrandName() 订阅（登录页 / 侧边栏 / 浏览器标题）。
 *
 * 回退顺序：接口返回值 → 本地缓存（上次成功拉取的值）→ 默认值「啊平智能」。
 * 参数为空或未配置时，服务端直接返回默认值，前端永远拿得到可用值。
 *
 * 历史说明：早期版本这里是硬编码常量 BRAND_NAME，散落在 MainLayout（2 处）、
 * LoginPage（1 处）、index.html（1 处），现已全部改为动态读取。
 */

import { useSyncExternalStore } from 'react';

export const DEFAULT_BRAND_NAME = '啊平智能';

export const BRAND_SUBTITLE = '小家电生产组装进销存管理系统';

/** 兼容旧引用（打印等处），等价于默认值 */
export const BRAND_NAME = DEFAULT_BRAND_NAME;

const CACHE_KEY = 'zgwms.brand';

function cached(): string {
  try {
    return localStorage.getItem(CACHE_KEY) || DEFAULT_BRAND_NAME;
  } catch {
    return DEFAULT_BRAND_NAME;
  }
}

let current: string = cached();
const listeners = new Set<() => void>();

export function getBrandName(): string {
  return current;
}

function brandFullTitle(name?: string): string {
  return `${name ?? current} - ${BRAND_SUBTITLE}`;
}

function applyTitle(): void {
  document.title = brandFullTitle();
}

export function setBrandName(name: string): void {
  const next = (name ?? '').trim() || DEFAULT_BRAND_NAME;
  if (next === current) return;
  current = next;
  try {
    localStorage.setItem(CACHE_KEY, next);
  } catch {
    /* localStorage 不可用不影响主流程 */
  }
  applyTitle();
  for (const fn of listeners) fn();
}

export function subscribeBrand(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** React 订阅钩子：任何页面里改了公司名称，所有挂载点立即同步 */
export function useBrandName(): string {
  return useSyncExternalStore(subscribeBrand, getBrandName, getBrandName);
}

/**
 * 从服务端拉取最新公司名称。
 * 免登录接口（GET /auth/brand），登录页也能调用；失败时静默保留当前值。
 */
export async function refreshBrandName(): Promise<string> {
  try {
    const { API_BASE } = await import('./api/client');
    const res = await fetch(`${API_BASE}/auth/brand`);
    const json = await res.json();
    if (res.ok && json?.data?.companyName) {
      setBrandName(String(json.data.companyName));
    }
  } catch {
    /* 拉取失败用缓存/默认值兜底，页面照常展示 */
  }
  return current;
}

/** 初始化：先按缓存值刷标题（避免闪默认名），再异步拉服务端最新值 */
applyTitle();
void refreshBrandName();
