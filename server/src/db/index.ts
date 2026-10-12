import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from '../config.js';

/**
 * SQLite 连接。
 * 选型理由：better-sqlite3 是同步 API，事务内不会出现异步回调割裂，
 * 对「扣库存 + 写流水 + 防超产校验」这类必须原子执行的操作最友好。
 * 若后续需要换 Postgres，只需替换本文件实现，业务代码不变。
 */

fs.mkdirSync(path.dirname(config.dbFile), { recursive: true });

export const db = new Database(config.dbFile);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

/**
 * 执行迁移（按文件名排序，只执行一次）。
 *
 * 幂等性由 _migrations 表保证：每个 .sql 文件只跑一次。
 * 老库升级时，若某表的 ALTER ADD COLUMN 在列已存在会报 duplicate column——
 * 由各迁移文件自身的「注释 + 顺序」管理；框架不额外插一层补列逻辑，
 * 避免"新库建表前补列→表不存在"的时序坑（defective_outs 缺 issue_id 事故根因）。
 */
export function migrate(): void {
  const dir = path.join(config.serverRoot, 'src/db');
  const files = fs
    .readdirSync(dir)
    .filter((f) => /^\d+_.*\.sql$/.test(f))
    .sort();

  db.exec(
    `CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`,
  );

  const applied = new Set(
    db.prepare(`SELECT name FROM _migrations`).all().map((r: any) => r.name as string),
  );

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    db.exec('BEGIN');
    try {
      db.exec(sql);
      db.prepare(`INSERT INTO _migrations (name, applied_at) VALUES (?, ?)`).run(
        file,
        new Date().toISOString(),
      );
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    console.log(`[db] 已应用迁移 ${file}`);
  }
}

/**
 * 事务包装。better-sqlite3 支持嵌套调用自动降级为 SAVEPOINT，
 * 因此领域服务内部可以安全地在已开启的事务中再次声明事务边界。
 */
export function tx<T>(fn: () => T): T {
  return db.transaction(fn)();
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function todayStr(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
