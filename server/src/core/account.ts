import type { Role } from '../../../shared/permissions.js';
import { db, nowIso } from '../db/index.js';

/**
 * 用户管理的领域规则收敛点。
 *
 * 三条硬规则，任何地方都绕不过：
 *  1. **7 个内置账号是唯一来源** —— 名单在这里定义，种子数据（seed.ts）、
 *     账号初始化、删除保护三处共用，避免「这边加了那边没加」；
 *  2. **用户编号只增不乱** —— 统一走 nextUserNo()，内部一枚 IMMEDIATE 事务
 *     同时读序列、取当前最大编号、写回序列，并发下不可能拿到同一个号；
 *  3. **内置账号不可删除** —— 由 isBuiltinUsername() 统一判定，
 *     初始化、账号删除两处都走它。
 */

export interface BuiltinUser {
  username: string;
  name: string;
  role: Role;
}

/** 系统默认 7 个内置账号：账号初始化后必须完整保留，且不可重复创建 */
export const BUILTIN_USERS: readonly BuiltinUser[] = [
  { username: 'admin', name: '系统管理员', role: 'admin' },
  { username: 'purchaser', name: '采购员小李', role: 'purchaser' },
  { username: 'warehouse', name: '库管老王', role: 'warehouse' },
  { username: 'finance', name: '财务小张', role: 'finance' },
  { username: 'producer', name: '生产员小赵', role: 'producer' },
  { username: 'sales', name: '销售员小孙', role: 'sales' },
  { username: 'viewer', name: '查询员小陈', role: 'viewer' },
];

export const BUILTIN_USERNAMES: readonly string[] = BUILTIN_USERS.map((u) => u.username);

/** 编号序列的初始值：内置账号占掉前 N 位，新账号从第 N+1 位开始 */
export const USER_SEQ_INITIAL = BUILTIN_USERS.length;

export function isBuiltinUsername(username: string): boolean {
  return BUILTIN_USERNAMES.includes(String(username ?? '').trim());
}

// ---------------------------------------------------------------- 编号序列

const SEQ_PREFIX = 'USER';
const SEQ_WIDTH = 4;

export function formatUserNo(seq: number): string {
  return `U${String(seq).padStart(SEQ_WIDTH, '0')}`;
}

function seqRow(): { current: number } | undefined {
  return db.prepare(`SELECT current FROM code_sequences WHERE prefix = ?`).get(SEQ_PREFIX) as
    | { current: number }
    | undefined;
}

/**
 * 直接写序列值（慎用）。
 * 只有三处可以调：迁移/种子初始化（初值）、账号初始化（重置回初始值）、重号修复（抬到下界）。
 * 除此以外一律走 nextUserNo()，避免绕过「只增不减」的约定。
 */
export const writeUserSeq = writeSeq;

export function userSeqCurrent(): number {
  return Number(seqRow()?.current ?? 0) || 0;
}

/** 现有数据里最大的编号序号（比只看序列更可靠：老数据可能是手工导入的） */
function maxNoSuffix(): number {
  const row = db
    .prepare(
      `SELECT IFNULL(MAX(CAST(REPLACE(user_no, 'U', '') AS INTEGER)), 0) AS c
         FROM users WHERE user_no LIKE 'U%'`,
    )
    .get() as { c: number };
  return Number(row?.c ?? 0) || 0;
}

export function writeSeq(n: number): void {  const now = nowIso();
  const hit = db
    .prepare(`UPDATE code_sequences SET current = ?, kind = 'user', updated_at = ? WHERE prefix = ?`)
    .run(n, now, SEQ_PREFIX);
  if (hit.changes > 0) return;
  db.prepare(
    `INSERT INTO code_sequences (prefix, kind, current, updated_at) VALUES (?, 'user', ?, ?)`,
  ).run(SEQ_PREFIX, n, now);
}

/**
 * 取下一个用户编号。
 * 必须是 IMMEDIATE 事务：BEGIN 就抢写锁，先到的先算号，
 * 否则两个并发请求会读到同一个 current，生成重号。
 */
export function nextUserNo(): string {
  const run = db.transaction((): string => {
    const seq = Math.max(userSeqCurrent(), maxNoSuffix()) + 1;
    writeSeq(seq);
    return formatUserNo(seq);
  });
  return run.immediate();
}

/** 初始化时重置序列：回到初始值（内置账号数量），下一个新账号 = U0008 */
export function resetUserSeq(): number {
  writeSeq(USER_SEQ_INITIAL);
  return USER_SEQ_INITIAL;
}

/**
 * 同步 AUTOINCREMENT 计数器，避免删了一批账号后 id 还留在很大的数字上。
 * 只往「当前最大 id」收，绝不倒退到比现有数据小的值（会造成主键冲突）。
 */
export function compactUserAutoIncrement(): number {
  const row = db.prepare(`SELECT IFNULL(MAX(id), 0) AS c FROM users`).get() as { c: number };
  const maxId = Number(row?.c ?? 0) || 0;
  db.prepare(`UPDATE sqlite_sequence SET seq = ? WHERE name = 'users'`).run(maxId);
  return maxId;
}

// ---------------------------------------------------------------- 重号治理

export interface DuplicateGroup {
  user_no: string;
  count: number;
  keepId: number;
  conflictIds: number[];
}

/** 检测现有数据里的重复用户编号。返回空数组即无重号 */
export function findDuplicateUserNos(): DuplicateGroup[] {
  const rows = db
    .prepare(
      `SELECT user_no, COUNT(*) AS c, MIN(id) AS keepId
         FROM users
        WHERE user_no IS NOT NULL AND user_no <> ''
        GROUP BY user_no
        HAVING COUNT(*) > 1
        ORDER BY user_no`,
    )
    .all() as { user_no: string; c: number; keepId: number }[];

  return rows.map((r) => ({
    user_no: r.user_no,
    count: Number(r.c),
    keepId: Number(r.keepId),
    conflictIds: (
      db.prepare(`SELECT id FROM users WHERE user_no = ? AND id <> ? ORDER BY id`).all(
        r.user_no,
        r.keepId,
      ) as { id: number }[]
    ).map((x) => Number(x.id)),
  }));
}

/**
 * 修复重号：每组保留 id 最小的那条，其余按 id 顺序重新分配全新编号。
 * 新号一定大于当前最大号，不会与任何现存编号冲突（配合 users.user_no 的唯一索引）。
 */
export function fixDuplicateUserNos(): { fixed: number; mapping: { id: number; from: string; to: string }[] } {
  const groups = findDuplicateUserNos();
  if (groups.length === 0) return { fixed: 0, mapping: [] };

  const run = db.transaction(() => {
    const mapping: { id: number; from: string; to: string }[] = [];
    let floor = Math.max(userSeqCurrent(), maxNoSuffix());
    const upd = db.prepare(`UPDATE users SET user_no = ?, updated_at = ? WHERE id = ?`);
    for (const g of groups) {
      for (const id of g.conflictIds) {
        floor += 1;
        const no = formatUserNo(floor);
        upd.run(no, nowIso(), id);
        mapping.push({ id, from: g.user_no, to: no });
      }
    }
    writeSeq(floor);
    return { fixed: mapping.length, mapping };
  });

  return run.immediate();
}
