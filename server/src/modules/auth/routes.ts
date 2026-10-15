import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { db, nowIso } from '../../db/index.js';
import { Err } from '../../core/errors.js';
import { writeLog } from '../../core/log.js';
import { requireAuth, requirePerm, signToken } from '../../middleware/auth.js';
import { permissionsOf } from '../../../../shared/permissions.js';
import { ok } from '../../shared/http.js';
import { companyName } from '../system/settings.js';
import { activate, licenseState } from '../../core/license.js';

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

/**
 * 免登录读取公司名称（authRouter 挂载在 requireAuth 之前）。
 * 登录页、浏览器标题在用户登录前就要展示品牌名，所以走公开接口。
 * companyName() 内部已做「为空回退默认」兜底。
 */
authRouter.get('/brand', (_req, res) => {
  ok(res, { companyName: companyName() });
});

/**
 * 免登录读取授权状态（authRouter 挂载在 requireAuth 之前）。
 * 登录页 / 全站横幅都需要在未登录时显示「试用剩余 X 天」「授权已过期」这类提示。
 * 附带本机机器指纹 —— 管理员把它发给供应商签发激活码。
 */
authRouter.get('/license', (_req, res) => {
  const st = licenseState();
  ok(res, {
    status: st.status,
    plan: st.plan,
    licensee: st.licensee,
    seats: st.seats,
    expireAt: st.expireAt,
    daysLeft: st.daysLeft,
    message: st.message,
    fingerprint: st.fingerprint,
    trialStart: st.trialStart,
  });
});

/** 激活：仅 admin（system.license.manage）。authRouter 在 requireAuth 之前挂载，这里必须显式先过 requireAuth */
authRouter.post('/license/activate', requireAuth, requirePerm('system.license.manage'), (req, res) => {
  const key = String((req.body as any)?.licenseKey ?? '').trim();
  if (!key) throw Err.badRequest('请粘贴激活码');
  try {
    const st = activate(key);
    writeLog({
      operatorId: req.ctx!.userId,
      action: '激活授权',
      targetType: 'license',
      detail: { plan: st.plan, licensee: st.licensee, expireAt: st.expireAt },
    });
    ok(res, st);
  } catch (e: any) {
    throw Err.badRequest(e?.message ?? '激活码无效');
  }
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
