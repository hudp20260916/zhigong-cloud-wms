/** 统一业务错误：HTTP 状态码 + 业务错误码 + 可直接展示给用户的中文消息 */
export class BizError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public detail?: unknown,
  ) {
    super(message);
    this.name = 'BizError';
  }
}

export const Err = {
  badRequest: (msg: string, detail?: unknown) => new BizError(400, 'BAD_REQUEST', msg, detail),
  unauthorized: (msg = '登录已失效，请重新登录') => new BizError(401, 'UNAUTHORIZED', msg),
  forbidden: (msg = '当前账号无该操作权限') => new BizError(403, 'FORBIDDEN', msg),
  notFound: (msg = '记录不存在') => new BizError(404, 'NOT_FOUND', msg),
  conflict: (msg: string, detail?: unknown) => new BizError(409, 'CONFLICT', msg, detail),
};
