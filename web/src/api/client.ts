const TOKEN_KEY = 'zgwms.token';

/**
 * API 基址。
 * 开发/同域部署走相对路径 /api（Vite 代理或 Nginx 反代）；
 * 前后端分离部署（如 GitHub Pages + 云主机后端）时用 VITE_API_BASE 指向后端完整地址。
 */
export const API_BASE: string = import.meta.env.VITE_API_BASE ?? '/api';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string | null): void {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

export interface ApiEnvelope<T> {
  ok: boolean;
  code?: string;
  message?: string;
  data?: T;
}

/** 会话失效（管理员改密码踢线）时统一跳转登录页 */
export function onSessionExpired(): void {
  setToken(null);
  if (!location.hash.includes('/login')) {
    location.href = '#/login?expired=1';
    location.reload();
  }
}

export async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  params?: Record<string, any>,
): Promise<T> {
  const token = getToken();
  const qs = params
    ? '?' +
      Object.entries(params)
        .filter(([, v]) => v !== undefined && v !== null && v !== '')
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
        .join('&')
    : '';

  const res = await fetch(`${API_BASE}${path}${qs}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  let json: ApiEnvelope<T>;
  try {
    json = await res.json();
  } catch {
    throw new Error(`服务端返回异常（HTTP ${res.status}）`);
  }

  if (res.status === 401) {
    onSessionExpired();
    throw new ApiError(json.message ?? '登录已失效，请重新登录', json.code);
  }
  if (!res.ok || json.ok === false) {
    // 保留业务错误码与 detail，便于上层做分支处理（如局部缺料拦截）
    throw new ApiError(json.message ?? '请求失败', json.code, (json as any).detail);
  }
  return json.data as T;
}

/** 带业务错误码的异常：detail 里承载结构化信息（例如缺料明细） */
export class ApiError extends Error {
  constructor(
    message: string,
    public code?: string,
    public detail?: any,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const api = {
  get: <T>(path: string, params?: Record<string, any>) => request<T>('GET', path, undefined, params),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body),
  del: <T>(path: string) => request<T>('DELETE', path),
};

/**
 * 下载二进制文件（需求 30：整库备份）。
 * 必须自己发请求：备份接口要校验 token，直接用 <a href> 或 window.open 带不上 Authorization 头。
 * 先取 blob 再触发浏览器下载，顺带从 Content-Disposition 里拿文件名。
 */
export async function downloadFile(path: string, fallbackName: string): Promise<void> {
  const token = getToken();
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
  if (!res.ok) {
    let msg = `下载失败（HTTP ${res.status}）`;
    try {
      const j = await res.json();
      if (j?.message) msg = j.message;
    } catch {
      /* 二进制响应不是 JSON，沿用默认提示 */
    }
    throw new Error(msg);
  }

  const disposition = res.headers.get('Content-Disposition') ?? '';
  const matched = /filename\*?=(?:UTF-8'')?["']?([^;"']+)/i.exec(disposition);
  const fileName = matched ? decodeURIComponent(matched[1]) : fallbackName;

  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export interface ListResult<T> {
  list: T[];
  total: number;
}
