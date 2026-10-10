import { db, nowIso } from '../db/index.js';

/** 操作日志：所有写操作与敏感动作（改密码、撤销、初始化）均需落日志 */
export function writeLog(params: {
  operatorId?: number | null;
  action: string;
  targetType?: string;
  targetId?: number | null;
  detail?: unknown;
}): void {
  db.prepare(
    `INSERT INTO operation_logs (operator_id, action, target_type, target_id, detail, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    params.operatorId ?? null,
    params.action,
    params.targetType ?? null,
    params.targetId ?? null,
    params.detail ? JSON.stringify(params.detail) : null,
    nowIso(),
  );
}
