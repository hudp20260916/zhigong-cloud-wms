-- ============================================================
-- 啊平智能 数据库结构
-- 迁移按序执行：目录下 00x_*.sql
-- ============================================================

PRAGMA foreign_keys = ON;

-- ---------- 账号与权限 ----------
CREATE TABLE IF NOT EXISTS users (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  username        TEXT    NOT NULL UNIQUE,
  password_hash   TEXT    NOT NULL,
  display_name    TEXT    NOT NULL,
  role            TEXT    NOT NULL,
  status          TEXT    NOT NULL DEFAULT 'active',
  -- 会话版本：管理员改密码后自增，使该账号所有已签发 token 立即失效
  session_version INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT    NOT NULL,
  updated_at      TEXT    NOT NULL
);

-- ---------- 基础档案 ----------
CREATE TABLE IF NOT EXISTS suppliers (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  code       TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  contact    TEXT,
  phone      TEXT,
  remark     TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS customers (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  code       TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  contact    TEXT,
  phone      TEXT,
  remark     TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS materials (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  code                TEXT    NOT NULL UNIQUE,
  name                TEXT    NOT NULL,
  pinyin              TEXT,             -- 拼音首字母，用于快速检索
  spec                TEXT,
  category            TEXT,
  unit                TEXT    NOT NULL DEFAULT '个',
  default_supplier_id INTEGER REFERENCES suppliers (id),
  safety_stock        REAL    NOT NULL DEFAULT 0,
  current_stock       REAL    NOT NULL DEFAULT 0,
  avg_cost            REAL    NOT NULL DEFAULT 0,
  is_virtual          INTEGER NOT NULL DEFAULT 0,   -- 1=虚拟件（穿透到实阶物料）
  remark              TEXT,
  created_at          TEXT    NOT NULL,
  updated_at          TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS products (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  code              TEXT    NOT NULL UNIQUE,
  name              TEXT    NOT NULL,
  pinyin            TEXT,
  spec              TEXT,
  unit              TEXT    NOT NULL DEFAULT '台',
  packing_spec      TEXT,                            -- 装箱规格
  carton_material_id INTEGER REFERENCES materials (id),  -- 外箱物料
  safety_stock      REAL    NOT NULL DEFAULT 0,
  current_stock     REAL    NOT NULL DEFAULT 0,
  bom_version       TEXT    NOT NULL DEFAULT 'V1.0',
  remark            TEXT,
  created_at        TEXT    NOT NULL,
  updated_at        TEXT    NOT NULL
);

-- 成品 BOM：单件耗用量
CREATE TABLE IF NOT EXISTS bom_items (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id   INTEGER NOT NULL REFERENCES products (id) ON DELETE CASCADE,
  material_id  INTEGER NOT NULL REFERENCES materials (id),
  qty_per_unit REAL    NOT NULL,
  remark       TEXT,
  UNIQUE (product_id, material_id)
);

-- 虚拟件构成：虚拟物料展开为实阶物料（P3 领料穿透时使用）
CREATE TABLE IF NOT EXISTS virtual_bom_items (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_material_id INTEGER NOT NULL REFERENCES materials (id) ON DELETE CASCADE,
  child_material_id  INTEGER NOT NULL REFERENCES materials (id),
  qty_per_unit       REAL    NOT NULL,
  UNIQUE (parent_material_id, child_material_id)
);

-- ---------- 采购 ----------
CREATE TABLE IF NOT EXISTS purchase_orders (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  order_no        TEXT    NOT NULL UNIQUE,
  parent_order_no TEXT,                      -- 拆单后的父单号
  supplier_id     INTEGER REFERENCES suppliers (id),
  order_date      TEXT    NOT NULL,
  expected_date   TEXT,
  created_by      INTEGER REFERENCES users (id),
  status          TEXT    NOT NULL DEFAULT '进行中',
  mode            TEXT    NOT NULL,          -- bom | direct
  product_id      INTEGER REFERENCES products (id),  -- bom 模式的主产品
  plan_qty        REAL,
  bom_version     TEXT,
  summary         TEXT,                      -- 采购摘要（合并格式）
  remark          TEXT,
  created_at      TEXT    NOT NULL,
  updated_at      TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS purchase_order_items (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id     INTEGER NOT NULL REFERENCES purchase_orders (id) ON DELETE CASCADE,
  material_id  INTEGER NOT NULL REFERENCES materials (id),
  qty          REAL    NOT NULL,
  price        REAL    NOT NULL DEFAULT 0,
  received_qty REAL    NOT NULL DEFAULT 0,
  remark       TEXT
);

-- 采购入库单：receipt_no 为内部追溯 ID，前端全链路不展示（需求 4.5）
CREATE TABLE IF NOT EXISTS purchase_receipts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  receipt_no   TEXT    NOT NULL UNIQUE,
  order_id     INTEGER REFERENCES purchase_orders (id),
  supplier_id  INTEGER REFERENCES suppliers (id),
  receipt_date TEXT    NOT NULL,
  operator_id  INTEGER REFERENCES users (id),
  status       TEXT    NOT NULL DEFAULT '有效',
  source       TEXT    NOT NULL DEFAULT 'order',   -- order | ocr
  total_amount REAL    NOT NULL DEFAULT 0,
  remark       TEXT,
  created_at   TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS purchase_receipt_items (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  receipt_id INTEGER NOT NULL REFERENCES purchase_receipts (id) ON DELETE CASCADE,
  material_id INTEGER NOT NULL REFERENCES materials (id),
  qty        REAL    NOT NULL,
  price      REAL    NOT NULL DEFAULT 0,
  amount     REAL    NOT NULL DEFAULT 0,
  is_gift    INTEGER NOT NULL DEFAULT 0,   -- 赠品行
  over_qty   INTEGER NOT NULL DEFAULT 0,   -- 超量待结算标记
  remark     TEXT
);

CREATE TABLE IF NOT EXISTS purchase_returns (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  return_no    TEXT    NOT NULL UNIQUE,
  receipt_id   INTEGER REFERENCES purchase_receipts (id),
  supplier_id  INTEGER REFERENCES suppliers (id),
  return_date  TEXT    NOT NULL,
  operator_id  INTEGER REFERENCES users (id),
  status       TEXT    NOT NULL DEFAULT '有效',
  total_amount REAL    NOT NULL DEFAULT 0,
  remark       TEXT,
  created_at   TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS purchase_return_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  return_id   INTEGER NOT NULL REFERENCES purchase_returns (id) ON DELETE CASCADE,
  material_id INTEGER NOT NULL REFERENCES materials (id),
  qty         REAL    NOT NULL,
  price       REAL    NOT NULL DEFAULT 0,
  amount      REAL    NOT NULL DEFAULT 0,
  remark      TEXT
);

-- ---------- 库存流水（唯一事实来源） ----------
CREATE TABLE IF NOT EXISTS stock_ledger (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  item_type         TEXT    NOT NULL,        -- material | product
  item_id           INTEGER NOT NULL,
  direction         TEXT    NOT NULL,        -- in | out
  qty               REAL    NOT NULL,
  biz_type          TEXT    NOT NULL,
  biz_id            INTEGER,
  biz_no            TEXT,                    -- 入库类单号一律留空，前端不可见
  unit_price        REAL,
  amount            REAL,
  balance_after     REAL    NOT NULL,
  status            TEXT    NOT NULL DEFAULT '有效',   -- 有效 | 已撤销
  is_reversal       INTEGER NOT NULL DEFAULT 0,        -- 1=撤销产生的对冲记录
  reversed_ledger_id INTEGER,                          -- 指向被撤销的原始流水
  operator_id       INTEGER REFERENCES users (id),
  created_at        TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ledger_item ON stock_ledger (item_type, item_id);
CREATE INDEX IF NOT EXISTS idx_ledger_biz ON stock_ledger (biz_type, biz_id);
CREATE INDEX IF NOT EXISTS idx_ledger_time ON stock_ledger (created_at);

-- ---------- 编号序列 ----------
-- 需求 4.8：编号持续递增不重置，防止单号重复
CREATE TABLE IF NOT EXISTS code_sequences (
  prefix   TEXT    PRIMARY KEY,
  current  INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT  NOT NULL
);

-- ---------- 审计日志 ----------
CREATE TABLE IF NOT EXISTS operation_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  operator_id INTEGER REFERENCES users (id),
  action      TEXT    NOT NULL,
  target_type TEXT,
  target_id   INTEGER,
  detail      TEXT,
  created_at  TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_oplog_time ON operation_logs (created_at);
