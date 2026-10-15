import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { ROLE_LABEL, type Role } from '../../../../shared/permissions.js';
import { db, nowIso, tx } from '../../db/index.js';
import { Err } from '../../core/errors.js';
import { writeLog } from '../../core/log.js';
import { requireAuth, requirePerm } from '../../middleware/auth.js';
import { countRows, parsePage } from '../../shared/query.js';
import { ok, okList } from '../../shared/http.js';
import { nextUserNo, isBuiltinUsername } from '../../core/account.js';
import { seatsAvailable } from '../../core/license.js';
import { printRouter } from './print.js';
import { importRouter } from './import.js';
import { initRouter } from './init.js';
import { settingsRouter } from './settings.js';
import { backupRouter } from './backup.js';
import { accountRouter } from './account.js';

export const systemRouter = Router();

const userSchema = z.object({
  username: z.string().trim().min(2, '账号至少 2 个字符'),
  displayName: z.string().trim().min(1, '姓名不能为空'),
  role: z.enum(['admin', 'finance', 'purchaser', 'producer', 'sales', 'warehouse', 'viewer']),
  password: z.string().min(6).optional(),
  status: z.enum(['active', 'disabled']).default('active'),
});

/**
 * 密码强度：字母 + 数字组合，至少 8 位（需求 4.3）。
 * 与前端实时校验保持一致，服务端不信任前端结果。
 */
export function checkPasswordStrength(pwd: string): string | null {
  if (pwd.length < 8) return '密码强度不足（长度至少 8 位）';
  if (!/[A-Za-z]/.test(pwd) || !/\d/.test(pwd)) {
    return '密码强度不足（需包含字母与数字组合）';
  }
  return null;
}

systemRouter.get('/users', requirePerm('system.user.manage'), (req, res) => {
  const { page, pageSize, offset, keyword } = parsePage(req);
  // 用户编号也支持搜索（新字段，NULL 时 LIKE 不成立，自动被过滤掉）
  const cond = keyword ? `(username LIKE ? OR display_name LIKE ? OR IFNULL(user_no,'') LIKE ?)` : '1=1';
  const params = keyword ? [`%${keyword}%`, `%${keyword}%`, `%${keyword}%`] : [];

  const rows = db
    .prepare(
      `SELECT id, username, display_name, role, status, session_version, user_no, created_at
         FROM users WHERE ${cond} ORDER BY id ASC LIMIT ? OFFSET ?`,
    )
    .all(...params, pageSize, offset) as any[];

  const total = countRows('users', cond, params);
  okList(
    res,
    rows.map((r) => ({ ...r, roleLabel: ROLE_LABEL[r.role as Role] ?? r.role })),
    total,
  );
});

systemRouter.post('/users', requirePerm('system.user.manage'), (req, res) => {
  const parsed = userSchema.safeParse(req.body);
  if (!parsed.success) throw Err.badRequest(parsed.error.issues[0].message);
  const d = parsed.data;

  const id = tx(() => {
    if (db.prepare(`SELECT id FROM users WHERE username = ?`).get(d.username)) {
      throw Err.conflict(`账号【${d.username}】已存在`);
    }
    // 授权的账号数上限（seats）只在新增时拦截，绝不踢已有账号
    const seat = seatsAvailable();
    if (!seat.ok) throw Err.forbidden(seat.message!);

    // 内置账号受保护：既不可删除，也不允许被「另建一个同名账号」绕过配额与初始化清理
    if (isBuiltinUsername(d.username)) {
      throw Err.conflict(`【${d.username}】为系统内置账号，不允许重复创建`);
    }
    const pwd = d.password ?? '12345678';
    const weak = checkPasswordStrength(pwd);
    if (weak) throw Err.badRequest(weak);

    // 用户编号统一由 nextUserNo() 分配（IMMEDIATE 事务 + users.user_no 唯一索引），
    // 避免手填或并发插入产生重号
    const userNo = nextUserNo();

    const info = db
      .prepare(
        `INSERT INTO users (username, password_hash, display_name, role, status, session_version, user_no, created_at, updated_at)
         VALUES (?,?,?,?,?,1,?,?,?)`,
      )
      .run(d.username, bcrypt.hashSync(pwd, 10), d.displayName, d.role, d.status, userNo, nowIso(), nowIso());
    writeLog({
      operatorId: req.ctx!.userId,
      action: '新增账号',
      targetType: 'user',
      targetId: Number(info.lastInsertRowid),
      detail: { username: d.username, role: d.role, userNo },
    });
    return Number(info.lastInsertRowid);
  });
  ok(res, { id });
});

systemRouter.put('/users/:id', requirePerm('system.user.manage'), (req, res) => {
  const parsed = userSchema.safeParse(req.body);
  if (!parsed.success) throw Err.badRequest(parsed.error.issues[0].message);
  const d = parsed.data;
  const id = Number(req.params.id);

  tx(() => {
    if (!db.prepare(`SELECT id FROM users WHERE id = ?`).get(id)) throw Err.notFound('账号不存在');
    db.prepare(`UPDATE users SET display_name=?, role=?, status=?, updated_at=? WHERE id=?`).run(
      d.displayName,
      d.role,
      d.status,
      nowIso(),
      id,
    );
    writeLog({
      operatorId: req.ctx!.userId,
      action: '修改账号',
      targetType: 'user',
      targetId: id,
    });
  });
  ok(res, { id });
});

/**
 * 管理员修改密码。
 * session_version + 1 使该账号所有已签发 token 立即失效 —— 这是「强制踢线」的实现点（需求 4.3）。
 */
systemRouter.post('/users/:id/password', requirePerm('system.user.manage'), (req, res) => {
  const schema = z.object({
    newPassword: z.string().min(1, '请输入新密码'),
    confirmPassword: z.string().min(1, '请再次输入新密码'),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) throw Err.badRequest(parsed.error.issues[0].message);

  const { newPassword, confirmPassword } = parsed.data;
  if (newPassword !== confirmPassword) throw Err.badRequest('两次输入的密码不一致');
  const weak = checkPasswordStrength(newPassword);
  if (weak) throw Err.badRequest(weak);

  const id = Number(req.params.id);
  tx(() => {
    const user = db.prepare(`SELECT id, username FROM users WHERE id = ?`).get(id) as any;
    if (!user) throw Err.notFound('账号不存在');

    db.prepare(`UPDATE users SET password_hash = ?, session_version = session_version + 1, updated_at = ? WHERE id = ?`).run(
      bcrypt.hashSync(newPassword, 10),
      nowIso(),
      id,
    );

    writeLog({
      operatorId: req.ctx!.userId,
      action: '修改账号密码并强制下线',
      targetType: 'user',
      targetId: id,
      detail: { username: user.username },
    });
  });

  ok(res, { id, kicked: true });
});

systemRouter.get('/logs', requireAuth, (req, res) => {
  const { page, pageSize, offset } = parsePage(req);
  const rows = db
    .prepare(
      `SELECT l.*, u.display_name AS operator_name
         FROM operation_logs l LEFT JOIN users u ON u.id = l.operator_id
        ORDER BY l.id DESC LIMIT ? OFFSET ?`,
    )
    .all(pageSize, offset) as any[];
  okList(res, rows, countRows('operation_logs'));
});

systemRouter.get('/roles', requireAuth, (_req, res) => {
  ok(res, Object.entries(ROLE_LABEL).map(([value, label]) => ({ value, label })));
});

// ---- P5 子系统：打印 / 导入 / 初始化 / 参数 ----
systemRouter.use('/print', printRouter);
systemRouter.use('/import', importRouter);
systemRouter.use('/init', initRouter);
systemRouter.use('/settings', settingsRouter);
systemRouter.use('/backup', backupRouter);
systemRouter.use('/account', accountRouter);
