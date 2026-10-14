-- ============================================================
-- 用户管理增强：用户编号 + 编号序列 + 备份登记表
--
-- 背景：
--   1. users 表原来只有自增 id，没有对外可见的「用户编号」，
--      因此既没有编号序列可重置，也不存在重号可检测；本次补上 user_no；
--   2. 编号序列复用 code_sequences（kind='user'），与单据编号同一套机制，
--      好处是老逻辑「序列只增不重置」的约定不会被绕过；
--   3. data_backups 记录每一次自动/手动备份，restorable 即「可回滚标识」，
--      恢复功能只认这张表登记过的备份点。
-- ============================================================

-- ---------- 用户编号 ----------
ALTER TABLE users ADD COLUMN user_no TEXT;

-- 存量账号回填：按注册顺序（id）生成 U0001 / U0002 …
-- 用 id 而不是窗口函数，兼容性最好且不依赖 SQLite 版本。
UPDATE users
   SET user_no = 'U' || printf('%04d', id)
 WHERE user_no IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_user_no ON users (user_no);
CREATE INDEX IF NOT EXISTS idx_users_no ON users (user_no);

-- ---------- 用户编号序列 ----------
-- 幂等：已存在则不动（INSERT OR IGNORE + 单独的 UPDATE 回填初值）。
-- 初值取当前最大用户编号的序号部分，保证新建账号不会撞历史编号。
INSERT OR IGNORE INTO code_sequences (prefix, kind, current, updated_at)
VALUES ('USER', 'user', 0, datetime('now'));

UPDATE code_sequences
   SET kind = 'user',
       current = (
         SELECT IFNULL(MAX(CAST(REPLACE(user_no, 'U', '') AS INTEGER)), 0)
           FROM users
          WHERE user_no LIKE 'U%'
       ),
       updated_at = datetime('now')
 WHERE prefix = 'USER';

-- ---------- 备份登记表 ----------
CREATE TABLE IF NOT EXISTS data_backups (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  kind          TEXT    NOT NULL,   -- user_init | pre_restore | manual
  scope         TEXT    NOT NULL,   -- JSON 数组：本次备份涉及的表
  file_name     TEXT    NOT NULL,   -- 落盘文件名（server/data/backups/ 下）
  size_bytes    INTEGER NOT NULL DEFAULT 0,
  row_counts    TEXT    NOT NULL,   -- JSON：{"users": 12}
  operator_id   INTEGER REFERENCES users (id),
  operator_name TEXT,
  note          TEXT,
  restorable    INTEGER NOT NULL DEFAULT 1,  -- 可回滚标识：文件缺失/损坏时置 0
  restored_at   TEXT,
  restored_by   INTEGER,
  created_at    TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_backup_created ON data_backups (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_backup_kind ON data_backups (kind);
