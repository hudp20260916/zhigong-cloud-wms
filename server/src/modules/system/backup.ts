import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { db, nowIso } from '../../db/index.js';
import { config } from '../../config.js';
import { Err } from '../../core/errors.js';
import { writeLog } from '../../core/log.js';
import { requirePerm } from '../../middleware/auth.js';
import { ok } from '../../shared/http.js';

export const backupRouter = Router();

/**
 * 需求 30：备份所有模块数据。
 *
 * 提供两种形态，各有用途：
 *  1. `/db`    —— 整库快照（SQLite 文件），能原样还原，是真正的「备份」；
 *  2. `/export`—— 全表数据 JSON，前端拼成多 Sheet Excel，给人看、给人对账。
 *
 * 表清单动态取自 sqlite_master，不手写清单：以后加模块不用回来改这里，
 * 也不会漏掉某张表导致备份不完整。
 */

/** 单表导出行数上限，防止误把超大表一次性拉爆内存 */
const MAX_ROWS = 50_000;

/** 系统内部表与迁移记录不属于业务数据，不导出 */
const SKIP_PREFIXES = ['sqlite_', '_'];

interface TableInfo {
  name: string;
  rows: number;
}

function businessTables(): TableInfo[] {
  const rows = db
    .prepare(
      `SELECT name FROM sqlite_master
        WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
        ORDER BY name`,
    )
    .all() as { name: string }[];

  const out: TableInfo[] = [];
  for (const { name } of rows) {
    if (SKIP_PREFIXES.some((p) => name.startsWith(p))) continue;
    const r = db.prepare(`SELECT COUNT(*) AS c FROM "${name}"`).get() as { c: number };
    out.push({ name, rows: Number(r.c) || 0 });
  }
  return out;
}

/** 表清单与行数，供前端展示「这次会备份什么」 */
backupRouter.get('/tables', requirePerm('system.init.execute'), (_req, res) => {
  const tables = businessTables();
  ok(res, {
    at: nowIso(),
    tableCount: tables.length,
    rowCount: tables.reduce((s, t) => s + t.rows, 0),
    tables,
  });
});

/** 全表数据导出（JSON）。前端用 xlsx 组装成多 Sheet 工作簿 */
backupRouter.get('/export', requirePerm('system.init.execute'), (_req, res) => {
  const tables = businessTables();
  const payload = tables.map((t) => {
    const rows = db.prepare(`SELECT * FROM "${t.name}" LIMIT ${MAX_ROWS}`).all() as any[];
    return {
      table: t.name,
      total: t.rows,
      exported: rows.length,
      truncated: t.rows > rows.length,
      columns: rows.length > 0 ? Object.keys(rows[0]) : [],
      rows,
    };
  });

  writeLog({
    operatorId: _req.ctx!.userId,
    action: '导出全模块数据',
    targetType: 'backup',
    detail: { tables: tables.length },
  });

  ok(res, {
    at: nowIso(),
    dbFile: path.basename(config.dbFile),
    tables: payload,
  });
});

/** 整库快照下载。用 VACUUM INTO 生成一致性副本，不锁业务写入 */
backupRouter.get('/db', requirePerm('system.init.execute'), (_req, res) => {
  const stamp = nowIso().replace(/[:T]/g, '-').slice(0, 19).replace(/ /g, '_');
  const dir = path.dirname(config.dbFile);
  const file = path.join(dir, `backup-${stamp}.db`);

  try {
    // VACUUM INTO 不接受绑定参数，文件名由服务端自己生成，不含外部输入
    db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  } catch (e: any) {
    throw Err.conflict(`生成备份失败：${e.message}`);
  }

  writeLog({
    operatorId: _req.ctx!.userId,
    action: '下载数据库备份',
    targetType: 'backup',
    detail: { file: path.basename(file) },
  });

  res.download(file, `数据备份-${stamp}.db`, (err) => {
    // 无论成功失败都清理临时快照，避免备份文件堆在数据目录
    fs.rmSync(file, { force: true });
    if (err) console.error('[backup] 下载中断：', err.message);
  });
});
