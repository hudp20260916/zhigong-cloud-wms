-- P3 生产模块：工单 / 领料 / 成品入库

-- 生产工单
CREATE TABLE IF NOT EXISTS work_orders (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  wo_no        TEXT    NOT NULL UNIQUE,
  product_id   INTEGER NOT NULL REFERENCES products (id),
  plan_qty     REAL    NOT NULL,
  bom_version  TEXT,
  plan_start   TEXT,
  plan_end     TEXT,
  issued_qty   REAL    NOT NULL DEFAULT 0,   -- 累计有效领料产量
  received_qty REAL    NOT NULL DEFAULT 0,   -- 累计成品入库量
  loss_qty     REAL    NOT NULL DEFAULT 0,   -- 损耗数量
  status       TEXT    NOT NULL DEFAULT '未开工',
  remark       TEXT,
  created_by   INTEGER REFERENCES users (id),
  created_at   TEXT    NOT NULL,
  updated_at   TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_wo_product ON work_orders (product_id);

-- 生产领料单：领料时即扣减子物料与外箱
CREATE TABLE IF NOT EXISTS material_issues (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_no    TEXT    NOT NULL UNIQUE,
  wo_id       INTEGER NOT NULL REFERENCES work_orders (id),
  issue_date  TEXT    NOT NULL,
  produce_qty REAL    NOT NULL,              -- 本单可生产的成品数量（决定可入库余量）
  status      TEXT    NOT NULL DEFAULT '有效',
  operator_id INTEGER REFERENCES users (id),
  remark      TEXT,
  created_at  TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS material_issue_items (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_id   INTEGER NOT NULL REFERENCES material_issues (id) ON DELETE CASCADE,
  material_id INTEGER NOT NULL REFERENCES materials (id),
  qty        REAL    NOT NULL,
  unit_price REAL    NOT NULL DEFAULT 0,
  remark     TEXT
);

-- 成品入库单：receipt_no 为内部追溯 ID，前端全链路不展示（需求 3.5.3 / 4.5）
CREATE TABLE IF NOT EXISTS product_receipts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  receipt_no   TEXT    NOT NULL UNIQUE,
  wo_id        INTEGER REFERENCES work_orders (id),
  issue_id     INTEGER REFERENCES material_issues (id),
  receipt_date TEXT    NOT NULL,
  receipt_type TEXT    NOT NULL,   -- 生产入库（已领料） / 售后返修入库 / 成品入库（直接扣料）
  status       TEXT    NOT NULL DEFAULT '有效',
  operator_id  INTEGER REFERENCES users (id),
  remark       TEXT,
  created_at   TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS product_receipt_items (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  receipt_id INTEGER NOT NULL REFERENCES product_receipts (id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products (id),
  qty        REAL    NOT NULL,
  remark     TEXT
);
