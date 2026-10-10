-- P4 销售与仓储作业

-- ---------- 销售 ----------
CREATE TABLE IF NOT EXISTS sale_orders (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  order_no     TEXT    NOT NULL UNIQUE,
  customer_id  INTEGER REFERENCES customers (id),
  order_date   TEXT    NOT NULL,
  status       TEXT    NOT NULL DEFAULT '待出库',   -- 待出库 / 已出库 / 已撤销
  total_amount REAL    NOT NULL DEFAULT 0,
  remark       TEXT,
  created_by   INTEGER REFERENCES users (id),
  created_at   TEXT    NOT NULL,
  updated_at   TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS sale_order_items (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id      INTEGER NOT NULL REFERENCES sale_orders (id) ON DELETE CASCADE,
  product_id    INTEGER NOT NULL REFERENCES products (id),
  qty           REAL    NOT NULL,
  price         REAL    NOT NULL DEFAULT 0,
  delivered_qty REAL    NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sale_deliveries (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  delivery_no   TEXT    NOT NULL UNIQUE,
  order_id      INTEGER REFERENCES sale_orders (id),
  customer_id   INTEGER REFERENCES customers (id),
  delivery_date TEXT    NOT NULL,
  status        TEXT    NOT NULL DEFAULT '有效',
  total_amount  REAL    NOT NULL DEFAULT 0,
  operator_id   INTEGER REFERENCES users (id),
  remark        TEXT,
  created_at    TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS sale_delivery_items (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  delivery_id INTEGER NOT NULL REFERENCES sale_deliveries (id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products (id),
  qty        REAL    NOT NULL,
  price      REAL    NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sale_returns (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  return_no   TEXT    NOT NULL UNIQUE,
  order_id    INTEGER REFERENCES sale_orders (id),
  customer_id INTEGER REFERENCES customers (id),
  return_date TEXT    NOT NULL,
  status      TEXT    NOT NULL DEFAULT '有效',
  total_amount REAL   NOT NULL DEFAULT 0,
  operator_id INTEGER REFERENCES users (id),
  remark      TEXT,
  created_at  TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS sale_return_items (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  return_id  INTEGER NOT NULL REFERENCES sale_returns (id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products (id),
  qty        REAL    NOT NULL,
  price      REAL    NOT NULL DEFAULT 0
);

-- ---------- 仓储作业 ----------
CREATE TABLE IF NOT EXISTS material_sales (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_no     TEXT    NOT NULL UNIQUE,
  customer_id INTEGER REFERENCES customers (id),
  sale_date   TEXT    NOT NULL,
  status      TEXT    NOT NULL DEFAULT '有效',
  total_amount REAL   NOT NULL DEFAULT 0,
  operator_id INTEGER REFERENCES users (id),
  remark      TEXT,
  created_at  TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS material_sale_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_id     INTEGER NOT NULL REFERENCES material_sales (id) ON DELETE CASCADE,
  material_id INTEGER NOT NULL REFERENCES materials (id),
  qty         REAL    NOT NULL,
  price       REAL    NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS defective_outs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  out_no      TEXT    NOT NULL UNIQUE,
  out_date    TEXT    NOT NULL,
  status      TEXT    NOT NULL DEFAULT '有效',
  operator_id INTEGER REFERENCES users (id),
  remark      TEXT,
  created_at  TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS defective_out_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  out_id      INTEGER NOT NULL REFERENCES defective_outs (id) ON DELETE CASCADE,
  material_id INTEGER NOT NULL REFERENCES materials (id),
  qty         REAL    NOT NULL,
  reason      TEXT
);

-- 库存盘点：审核后自动生成调整流水
CREATE TABLE IF NOT EXISTS stock_checks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  check_no   TEXT    NOT NULL UNIQUE,
  check_date TEXT    NOT NULL,
  status     TEXT    NOT NULL DEFAULT '待审核',   -- 待审核 / 已审核 / 已撤销
  operator_id INTEGER REFERENCES users (id),
  auditor_id INTEGER REFERENCES users (id),
  remark     TEXT,
  created_at TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS stock_check_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  check_id    INTEGER NOT NULL REFERENCES stock_checks (id) ON DELETE CASCADE,
  item_type   TEXT    NOT NULL,
  item_id     INTEGER NOT NULL,
  book_qty    REAL    NOT NULL,
  actual_qty  REAL    NOT NULL,
  diff_qty    REAL    NOT NULL
);

-- 模拟出货与排产建议
CREATE TABLE IF NOT EXISTS simulate_shipments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  sim_no      TEXT    NOT NULL UNIQUE,
  sim_date    TEXT    NOT NULL,
  operator_id INTEGER REFERENCES users (id),
  remark      TEXT,
  created_at  TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS simulate_shipment_items (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  sim_id     INTEGER NOT NULL REFERENCES simulate_shipments (id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products (id),
  qty        REAL    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_check_items ON stock_check_items (item_type, item_id);
