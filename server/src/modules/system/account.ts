import { Router } from 'express';
import bcrypt from 'bcryptjs';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { db, nowIso } from '../../db/index.js';
import { config } from '../../config.js';
import { Err } from '../../core/errors.js';
import { writeLog } from '../../core/log.js';
import { requirePerm } from '../../middleware/auth.js';
import { ok } from '../../shared/http.js';
import {
  BUILTIN_USERNAMES,
  BUILTIN_USERS,
  compactUserAutoIncrement,
  findDuplicateUserNos,
  fixDuplicateUserNos,
  formatUserNo,
  isBuiltinUsername,
  resetUserSeq,
  userSeqCurrent,
} from '../../core/account.js';

/**
 * 用户管理的高危维护能力：账号初始化 / 编号治理 / 备份恢复。
 *
 * 四条安全底线（需求里的「安全控制」）：
 *  1. **权限点**：初始化走 system.user.init，备份恢复走 system.backup.manage，两者都只有 admin 有；
 *  2. **密码核验**：每次执行前必须输入「当前登录账号」的密码，服务端 bcrypt 比对，
 *     前端有没有校验无所谓 —— 这里才是最后一道门；
 *  3. **二次确认**：服务端再校验一次确认文字，防止脚本直接打接口；
 *  4. **全程留痕**：备份、初始化、去重、恢复四个动作都写 operation_logs。
 *
 * 另外，初始化前一定先落一份可回滚的备份：备份失败就直接拒绝执行，
 * 不接受「我已经自己备份过了」这种豁免开关。
 */

export const accountRouter = Router();

const BACKUP_DIR = path.join(path.dirname(config.dbFile), 'backups');

/** 账号类备份的范围：目前只涉及 users 表 */
const ACCOUNT_TABLES = ['users'];

const CONFIRM_INIT = '初始化账号';
const CONFIRM_RESTORE = '确认恢复';

// ---------------------------------------------------------------- 通用工具

/** 操作者身份核验：必须输入当前登录账号的密码 */
function verifyOperator(userId: number, password: string): any {
  const row = db.prepare(`SELECT * FROM users WHERE id = ?`).get(userId) as any;
  if (!row) throw Err.notFound('当前账号不存在');
  if (!password || String(password).length === 0) {
    throw Err.badRequest('请输入当前登录账号的密码以完成身份核验');
  }
  if (!bcrypt.compareSync(String(password), row.password_hash)) {
    throw Err.unauthorized('密码核验失败，操作已取消');
  }
  return row;
}

function stamp(): string {
  return nowIso().replace(/[:T]/g, '-').slice(0, 19).replace(/ /g, '_');
}

interface BackupResult {
  id: number;
  fileName: string;
  sizeBytes: number;
  rowCounts: Record<string, number>;
}

/** 把若干张表整体导出成 JSON 并登记到 data_backups（restorable=1） */
function createBackup(
  kind: 'user_init' | 'pre_restore' | 'manual',
  tables: string[],
  operator: any,
  note: string,
): BackupResult {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });

  const payload: { table: string; rows: any[] }[] = [];
  const rowCounts: Record<string, number> = {};
  for (const t of tables) {
    const rows = db.prepare(`SELECT * FROM "${t}"`).all() as any[];
    payload.push({ table: t, rows });
    rowCounts[t] = rows.length;
  }

  const fileName = `${kind}-${stamp()}.json`;
  const full = path.join(BACKUP_DIR, fileName);
  fs.writeFileSync(full, JSON.stringify({ at: nowIso(), kind, tables: payload }), 'utf8');
  const sizeBytes = fs.statSync(full).size;

  const info = db
    .prepare(
      `INSERT INTO data_backups
         (kind, scope, file_name, size_bytes, row_counts, operator_id, operator_name, note, restorable, created_at)
       VALUES (?,?,?,?,?,?,?,?,1,?)`,
    )
    .run(
      kind,
      JSON.stringify(tables),
      fileName,
      sizeBytes,
      JSON.stringify(rowCounts),
      operator.id,
      operator.display_name,
      note,
      nowIso(),
    );

  return { id: Number(info.lastInsertRowid), fileName, sizeBytes, rowCounts };
}

/** 已登记且文件仍在才算可回滚；文件丢了就把 restorable 置 0，别让管理员点了个空按钮 */
function loadBackupRow(id: number): any {
  const row = db.prepare(`SELECT * FROM data_backups WHERE id = ?`).get(id) as any;
  if (!row) throw Err.notFound('备份记录不存在');
  const full = path.join(BACKUP_DIR, String(row.file_name));
  if (!fs.existsSync(full)) {
    db.prepare(`UPDATE data_backups SET restorable = 0 WHERE id = ?`).run(id);
    throw Err.conflict('备份文件已缺失，无法回滚');
  }
  if (!row.restorable) throw Err.conflict('该备份点已被标记为不可回滚');
  return { row, full };
}

// ---------------------------------------------------------------- 初始化预览与执行

/** 初始化预览：告诉管理员「会被删掉的是这些、一定会保留的是那些」 */
accountRouter.get('/init-preview', requirePerm('system.user.init'), (_req, res) => {
  const rows = db
    .prepare(
      `SELECT id, username, display_name, user_no, role, status, created_at
         FROM users ORDER BY id`,
    )
    .all() as any[];

  const toRemove = rows.filter((r) => !isBuiltinUsername(r.username));
  const keep = rows.filter((r) => isBuiltinUsername(r.username));

  ok(res, {
    builtin: BUILTIN_USERS.map((u) => ({ username: u.username, name: u.name, role: u.role })),
    keep: keep.map((r) => ({
      id: r.id,
      username: r.username,
      display_name: r.display_name,
      user_no: r.user_no,
    })),
    toRemove: toRemove.map((r) => ({
      id: r.id,
      username: r.username,
      display_name: r.display_name,
      user_no: r.user_no,
      role: r.role,
      status: r.status,
      created_at: r.created_at,
    })),
    // 编号序列当前值与重置后的起点，写死在预览里避免「改完不知道会从几开始」
    seq: {
      current: userSeqCurrent(),
      afterReset: BUILTIN_USERS.length,
      nextAfterReset: formatUserNo(BUILTIN_USERS.length + 1),
    },
    confirmText: CONFIRM_INIT,
  });
});

const initSchema = z.object({
  password: z.string().min(1, '请输入当前登录账号的密码'),
  confirmText: z.string().min(1, '请输入确认文字'),
});

accountRouter.post('/init', requirePerm('system.user.init'), (req, res) => {
  const parsed = initSchema.safeParse(req.body);
  if (!parsed.success) throw Err.badRequest(parsed.error.issues[0].message);
  const ctx = req.ctx!;

  // ① 二次确认：服务端独立校验，前端绕过也没用
  if (parsed.data.confirmText.trim() !== CONFIRM_INIT) {
    throw Err.badRequest(`确认文字不正确，请输入「${CONFIRM_INIT}」`);
  }
  // ② 密码核验
  const operator = verifyOperator(ctx.userId, parsed.data.password);

  const candidates = (
    db.prepare(`SELECT id, username, display_name, user_no FROM users ORDER BY id`).all() as any[]
  ).filter((r) => !isBuiltinUsername(r.username));

  // ③ 先备份，备份不成功就别往下走
  const backup = createBackup(
    'user_init',
    ACCOUNT_TABLES,
    operator,
    `账号初始化前自动备份（待清理 ${candidates.length} 个账号）`,
  );

  const removed: { id: number; username: string; user_no: string }[] = [];
  const disabled: { id: number; username: string; reason: string }[] = [];

  txDelete({
    candidates,
    operatorId: ctx.userId,
    onRemoved: removed,
    onDisabled: disabled,
  });

  // ④ 编号序列回到初始值；同时把自增计数器收回当前最大 id，避免留一大段空号
  const seqAfter = resetUserSeq();
  const maxId = compactUserAutoIncrement();

  writeLog({
    operatorId: ctx.userId,
    action: '账号初始化',
    targetType: 'user',
    detail: {
      backupId: backup.id,
      removed: removed.map((r) => r.username),
      disabled: disabled.map((r) => r.username),
      seqAfterReset: seqAfter,
      maxUserId: maxId,
    },
  });

  ok(res, {
    backupId: backup.id,
    removed,
    disabled,
    kept: BUILTIN_USERS.length,
    seq: { current: seqAfter, nextNo: formatUserNo(seqAfter + 1) },
  });
});

/**
 * 删除/停用新账号。
 * 被历史单据引用（外键挡住）的账号无法物理删除——这种账号只做「停用」处理，
 * 顺便保留了「这张单当初是谁做的」这条审计链。宁可留个停用账号，也不要留断链数据。
 */
function txDelete(args: {
  candidates: any[];
  operatorId: number;
  onRemoved: { id: number; username: string; user_no: string }[];
  onDisabled: { id: number; username: string; reason: string }[];
}): void {
  const del = db.prepare(`DELETE FROM users WHERE id = ?`);
  const disable = db.prepare(`UPDATE users SET status = 'disabled', updated_at = ? WHERE id = ?`);

  db.transaction(() => {
    for (const u of args.candidates) {
      // 永远不动当前操作者：哪怕它不在内置名单里，也是「正在点这个按钮的人」
      if (Number(u.id) === Number(args.operatorId)) continue;
      try {
        const info = del.run(u.id);
        if (info.changes > 0) {
          args.onRemoved.push({ id: u.id, username: u.username, user_no: u.user_no });
        }
      } catch (e: any) {
        disable.run(nowIso(), u.id);
        args.onDisabled.push({
          id: u.id,
          username: u.username,
          reason: '已被历史单据引用，无法物理删除，已改为停用',
        });
      }
    }

    // 初始化后其余账号的旧 token 立即失效（操作者自己除外，否则下一步就被踢出去了）
    db.prepare(
      `UPDATE users SET session_version = session_version + 1, updated_at = ? WHERE id <> ?`,
    ).run(nowIso(), args.operatorId);
  }).immediate();
}

// ---------------------------------------------------------------- 重号检测与修复

accountRouter.get('/duplicates', requirePerm('system.user.manage'), (_req, res) => {
  const dups = findDuplicateUserNos();
  ok(res, { duplicates: dups, count: dups.length });
});

const fixSchema = z.object({ password: z.string().min(1, '请输入当前登录账号的密码') });

accountRouter.post('/fix-duplicates', requirePerm('system.user.init'), (req, res) => {
  const parsed = fixSchema.safeParse(req.body);
  if (!parsed.success) throw Err.badRequest(parsed.error.issues[0].message);
  const ctx = req.ctx!;
  verifyOperator(ctx.userId, parsed.data.password);

  const result = fixDuplicateUserNos();
  writeLog({
    operatorId: ctx.userId,
    action: '修复用户编号重号',
    targetType: 'user',
    detail: { fixed: result.fixed, mapping: result.mapping },
  });

  ok(res, { ...result, checkedAt: nowIso() });
});

// ---------------------------------------------------------------- 备份与恢复

accountRouter.get('/backups', requirePerm('system.backup.manage'), (_req, res) => {
  const rows = db
    .prepare(
      `SELECT b.*, u.display_name AS operator_label
         FROM data_backups b LEFT JOIN users u ON u.id = b.operator_id
        ORDER BY b.id DESC LIMIT 100`,
    )
    .all() as any[];

  ok(res, {
    list: rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      scope: safeJson(r.scope, []),
      fileName: r.file_name,
      sizeBytes: r.size_bytes,
      rowCounts: safeJson(r.row_counts, {}),
      operatorName: r.operator_label ?? r.operator_name ?? '未知',
      note: r.note,
      restorable: Number(r.restorable) === 1 && fs.existsSync(path.join(BACKUP_DIR, String(r.file_name))),
      restoredAt: r.restored_at,
      createdAt: r.created_at,
    })),
    confirmText: CONFIRM_RESTORE,
  });
});

function safeJson(s: string | null, fallback: any): any {
  try {
    return s ? JSON.parse(s) : fallback;
  } catch {
    return fallback;
  }
}

const manualSchema = z.object({
  password: z.string().min(1, '请输入当前登录账号的密码'),
  note: z.string().optional(),
});

accountRouter.post('/backups', requirePerm('system.backup.manage'), (req, res) => {
  const parsed = manualSchema.safeParse(req.body);
  if (!parsed.success) throw Err.badRequest(parsed.error.issues[0].message);
  const ctx = req.ctx!;
  const operator = verifyOperator(ctx.userId, parsed.data.password);

  const backup = createBackup(
    'manual',
    ACCOUNT_TABLES,
    operator,
    parsed.data.note?.trim() || '手动备份',
  );
  writeLog({
    operatorId: ctx.userId,
    action: '创建账号数据备份',
    targetType: 'backup',
    targetId: backup.id,
    detail: { fileName: backup.fileName, rowCounts: backup.rowCounts },
  });

  ok(res, backup);
});

const restoreSchema = z.object({
  password: z.string().min(1, '请输入当前登录账号的密码'),
  confirmText: z.string().min(1, '请输入确认文字'),
});

accountRouter.post('/backups/:id/restore', requirePerm('system.backup.manage'), (req, res) => {
  const parsed = restoreSchema.safeParse(req.body);
  if (!parsed.success) throw Err.badRequest(parsed.error.issues[0].message);
  const ctx = req.ctx!;

  if (parsed.data.confirmText.trim() !== CONFIRM_RESTORE) {
    throw Err.badRequest(`确认文字不正确，请输入「${CONFIRM_RESTORE}」`);
  }
  const operator = verifyOperator(ctx.userId, parsed.data.password);

  const { row, full } = loadBackupRow(Number(req.params.id));
  const payload = JSON.parse(fs.readFileSync(full, 'utf8')) as {
    tables: { table: string; rows: any[] }[];
  };

  // 恢复之前先把「现在的状态」也存一份 —— 恢复错了还能再退回来
  const safety = createBackup(
    'pre_restore',
    ACCOUNT_TABLES,
    operator,
    `恢复备份 #${row.id} 前的自动快照`,
  );

  const summary: { table: string; before: number; after: number }[] = [];

  db.transaction(() => {
    // 允许事务内部短暂不一致，外键检查推迟到 COMMIT——否则「先删后插」会被引用的旧 id 挡住
    db.exec('PRAGMA defer_foreign_keys = ON');

    for (const t of payload.tables) {
      const before = Number(
        (db.prepare(`SELECT COUNT(*) AS c FROM "${t.table}"`).get() as { c: number }).c,
      );
      db.prepare(`DELETE FROM "${t.table}"`).run();

      const rows = t.rows ?? [];
      if (rows.length > 0) {
        const cols = Object.keys(rows[0]);
        const stmt = db.prepare(
          `INSERT INTO "${t.table}" (${cols.map((c) => `"${c}"`).join(',')})
           VALUES (${cols.map(() => '?').join(',')})`,
        );
        for (const r of rows) stmt.run(...cols.map((c) => r[c] ?? null));
      }
      summary.push({ table: t.table, before, after: rows.length });
    }
  }).immediate();

  // 恢复后必须保证操作者自己还在，否则他下一秒就被系统踢出去了
  const stillThere = db.prepare(`SELECT id FROM users WHERE id = ?`).get(ctx.userId) as
    | { id: number }
    | undefined;
  if (!stillThere) throw Err.conflict('备份中不含当前登录账号，系统已自动放弃该状态，请改用其它备份点');

  compactUserAutoIncrement();

  db.prepare(`UPDATE data_backups SET restored_at = ?, restored_by = ? WHERE id = ?`).run(
    nowIso(),
    ctx.userId,
    row.id,
  );

  writeLog({
    operatorId: ctx.userId,
    action: '恢复账号数据备份',
    targetType: 'backup',
    targetId: row.id,
    detail: { fileName: row.file_name, safetyBackupId: safety.id, summary },
  });

  ok(res, { restoredId: row.id, safetyBackupId: safety.id, summary, at: nowIso() });
});
