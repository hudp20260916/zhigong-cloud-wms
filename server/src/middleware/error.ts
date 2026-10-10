import type { NextFunction, Request, Response } from 'express';
import { BizError } from '../core/errors.js';

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof BizError) {
    res.status(err.status).json({
      ok: false,
      code: err.code,
      message: err.message,
      detail: err.detail ?? null,
    });
    return;
  }

  const message = err instanceof Error ? err.message : String(err);
  console.error('[server] 未处理异常:', err);
  res.status(500).json({ ok: false, code: 'INTERNAL', message: `服务端异常：${message}` });
}

export function notFoundHandler(_req: Request, res: Response): void {
  res.status(404).json({ ok: false, code: 'NOT_FOUND', message: '接口不存在' });
}
