import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { db, nowIso } from '../../db/index.js';
import { Err } from '../../core/errors.js';
import { writeLog } from '../../core/log.js';
import { requireAuth, signToken } from '../../middleware/auth.js';
import { permissionsOf } from '../../../../shared/permissions.js';
import { ok } from '../../shared/http.js';

export const authRouter = Router();

const loginSchema = z.object({
  username: z.string().min(1, '请输入账号'),
  password: z.string().min(1, '请输入密码'),
});

authRouter.post('/login', (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) throw Err.badRequest(parsed.error.issues[0].message);

  const { username, password } = parsed.data;
  const user = db.prepare(`SELECT * FROM users WHERE username = ?`).get(username) as any;

  if (!user) throw Err.unauthorized('账号或密码错误');
  if (user.status !== 'active') throw Err.forbidden('账号已停用，请联系管理员');
  if (!bcrypt.compareSync(password, user.password_hash)) {
    throw Err.unauthorized('账号或密码错误');
  }

  const token = signToken(user.id, user.session_version);
  writeLog({ operatorId: user.id, action: '登录', targetType: 'user', targetId: user.id });

  ok(res, {
    token,
    user: {
      id: user.id,
      username: user.username,
      displayName: user.display_name,
      role: user.role,
      sessionVersion: user.session_version,
    },
    permissions: permissionsOf(user.role),
  });
});

authRouter.get('/me', requireAuth, (req, res) => {
  const ctx = req.ctx!;
  ok(res, {
    id: ctx.userId,
    username: ctx.username,
    displayName: ctx.displayName,
    role: ctx.role,
    permissions: ctx.permissions,
  });
});

authRouter.post('/logout', requireAuth, (req, res) => {
  writeLog({ operatorId: req.ctx!.userId, action: '退出登录' });
  ok(res, { success: true });
});

export { nowIso };
