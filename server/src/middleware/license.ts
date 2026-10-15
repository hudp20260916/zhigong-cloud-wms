import type { NextFunction, Request, Response } from 'express';
import { Err } from '../core/errors.js';
import { writeAllowed } from '../core/license.js';

/**
 * 授权写入门禁（P0 的「第三处校验」）。
 *
 * 策略刻意从宽：
 *  - 只有 licenseState() 判定「彻底过期」才拦写；
 *  - 查询（GET/HEAD/OPTIONS）永远放行；
 *  - 激活与退出登录这两个接口必须始终可写，否则过期后连自救的路都没了；
 *  - 状态在内存里每次现算（SQLite 单行查询，开销可忽略），不做缓存 —— 改授权立即生效。
 */
const ALWAYS_ALLOWED = ['/auth/license/activate', '/auth/logout'];

export function licenseWriteGate(req: Request, _res: Response, next: NextFunction): void {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (ALWAYS_ALLOWED.some((p) => req.path.startsWith(p))) return next();
  if (writeAllowed()) return next();
  next(Err.forbidden('授权已过期，系统处于只读模式；查询与导出不受影响，请联系供应商续期'));
}
