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

export interface ListResult<T> {
  list: T[];
  total: number;
}
