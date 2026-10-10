-- ============================================================
-- P5 财务与系统设置
--  1. 采购结算（付款单 + 核销明细）
--  2. 打印模板持久化
--  3. Excel 导入日志
--  4. 系统参数（预警配置等）
-- ============================================================

PRAGMA foreign_keys = ON;

-- ---------- 采购单据增加「已结算金额」 ----------
-- 结算采用「单据维度」而非「明细维度」：
-- 一个入库单可以被多张付款单分批核销，用累计已结算金额即可表达，
-- 不需要为每次核销生成对冲记录，模型更轻。
ALTER TABLE purchase_receipts ADD COLUMN settled_amount REAL NOT NULL DEFAULT 0;
ALTER TABLE purchase_returns  ADD COLUMN settled_amount REAL NOT NULL DEFAULT 0;

-- ---------- 供应商付款单 ----------
CREATE TABLE IF NOT EXISTS supplier_settlements (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  settle_no      TEXT    NOT NULL UNIQUE,
  supplier_id    INTEGER NOT NULL REFERENCES suppliers (id),
  settle_date    TEXT    NOT NULL,
  method         TEXT    NOT NULL DEFAULT '转账',   -- 现金 | 转账 | 承兑 | 其他
  amount         REAL    NOT NULL DEFAULT 0,        -- 本次付款金额
  applied_amount REAL    NOT NULL DEFAULT 0,        -- 已核销到单据的金额
  operator_id    INTEGER REFERENCES users (id),
  status         TEXT    NOT NULL DEFAULT '有效',   -- 有效 | 已撤销
  remark         TEXT,
  created_at     TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_settle_supplier ON supplier_settlements (supplier_id, settle_date);

-- ---------- 付款单核销明细 ----------
-- doc_type = 'receipt'（应付，正向）| 'return'（退货，冲减应付）
-- receipt_no 仅作内部追溯，出口层统一剥离（需求 4.5）
CREATE TABLE IF NOT EXISTS settlement_items (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  settlement_id INTEGER NOT NULL REFERENCES supplier_settlements (id) ON DELETE CASCADE,
  doc_type      TEXT    NOT NULL,
  doc_id        INTEGER NOT NULL,
  receipt_no    TEXT,
  return_no     TEXT,
  doc_date      TEXT,
  doc_amount    REAL    NOT NULL DEFAULT 0,   -- 单据原始金额
  apply_amount  REAL    NOT NULL DEFAULT 0    -- 本次核销金额
);

CREATE INDEX IF NOT EXISTS idx_settle_item ON settlement_items (settlement_id);

-- ---------- 打印模板 ----------
-- 9 类单据各一条；content 为 HTML 模板，支持 {{字段}} 与 {{#items}} 循环
CREATE TABLE IF NOT EXISTS print_templates (
  doc_type    TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  paper       TEXT NOT NULL DEFAULT 'A4',        -- A4 | A5 | 241x140
  orientation TEXT NOT NULL DEFAULT 'portrait',  -- portrait | landscape
  content     TEXT NOT NULL,
  is_custom   INTEGER NOT NULL DEFAULT 0,        -- 1=用户改过，恢复默认时提示
  updated_by  INTEGER REFERENCES users (id),
  updated_at  TEXT NOT NULL
);

-- ---------- Excel 导入日志 ----------
CREATE TABLE IF NOT EXISTS import_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL,             -- material | customer | supplier | initial_stock
  file_name   TEXT,
  total       INTEGER NOT NULL DEFAULT 0,
  success     INTEGER NOT NULL DEFAULT 0,
  failed      INTEGER NOT NULL DEFAULT 0,
  errors      TEXT,                      -- JSON 数组：[{row, message}]
  operator_id INTEGER REFERENCES users (id),
  created_at  TEXT NOT NULL
);

-- ---------- 系统参数 ----------
-- 预警阈值等可变配置放这里，避免为改一个数字发版
CREATE TABLE IF NOT EXISTS app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 默认预警配置
INSERT OR IGNORE INTO app_settings (key, value, updated_at) VALUES
  ('alert.safetyRatio',     '1',   datetime('now')),   -- 低于安全库存比例触发告警（1=低于安全库存即告警）
  ('alert.severeRatio',     '0.5', datetime('now')),   -- 低于安全库存 50% 判定严重缺货
  ('alert.overStockRatio',  '3',   datetime('now')),   -- 高于安全库存 N 倍判定超储
  ('alert.idleDays',        '60',  datetime('now')),   -- 呆滞库存天数
  ('company.name',          '啊平智能', datetime('now')),
  ('company.phone',         '',    datetime('now')),
  ('company.address',       '',    datetime('now'));
