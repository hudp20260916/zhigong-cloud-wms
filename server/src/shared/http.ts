import type { NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * 异步路由包装器。
 *
 * Express 4 不会捕获 async 处理函数里抛出的异常 —— 它会变成 unhandledRejection，
 * 直接让进程退出（我们就是这么踩到一次线上打挂的）。
 * 所有 async 路由必须用它包一层，把异常交给 errorHandler 统一处理。
 */
export function asyncRoute(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}

export function ok<T>(res: Response, data: T): void {
  res.json({ ok: true, data });
}

export function okList<T>(res: Response, rows: T[], total?: number): void {
  res.json({ ok: true, data: { list: rows, total: total ?? rows.length } });
}
