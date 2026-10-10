import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import type { Permission } from '../../../shared/permissions.js';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { Err } from '../core/errors.js';
import { buildCtx, type RequestCtx } from './context.js';

export interface TokenPayload {
  sub: number;
  sv: number;
}

export function signToken(userId: number, sessionVersion: number): string {
  return jwt.sign({ sub: userId, sv: sessionVersion } as TokenPayload, config.jwtSecret, {
    expiresIn: config.tokenTtl,
  });
}

/**
 * 鉴权中间件。
 * session_version 校验是「管理员改密码后强制踢线」的关键：
 * 改密码 -> 该账号 session_version +1 -> 所有已签发 token 的 sv 不匹配 -> 401。
 */
export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization ?? '';
  // 打印窗口由 window.open 打开，无法携带自定义请求头，
  // 因此额外接受 ?token= 查询参数（仅限打印这类只读渲染场景）。
  const token = header.startsWith('Bearer ')
    ? header.slice(7)
    : typeof req.query?.token === 'string'
      ? req.query.token
      : '';
  if (!token) return next(Err.unauthorized());

  let payload: TokenPayload;
  try {
    payload = jwt.verify(token, config.jwtSecret) as unknown as TokenPayload;
  } catch {
    return next(Err.unauthorized());
  }

  const user = db.prepare(`SELECT * FROM users WHERE id = ?`).get(payload.sub) as any;
  if (!user || user.status !== 'active') return next(Err.unauthorized('账号不存在或已停用'));
  if (user.session_version !== payload.sv) {
    return next(Err.unauthorized('密码已被管理员修改，请重新登录'));
  }

  req.ctx = buildCtx(user);
  next();
}

/** 权限点校验。前端按钮显隐用同一套权限点，避免出现「按钮可见但调用被拒」 */
export function requirePerm(permission: Permission) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const ctx = req.ctx as RequestCtx | undefined;
    if (!ctx) return next(Err.unauthorized());
    if (!ctx.permissions.includes(permission)) {
      return next(Err.forbidden(`当前角色无「${permission}」权限`));
    }
    next();
  };
}
