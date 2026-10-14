-- ============================================================
-- 012 多仓库：仓库档案 / 分仓库存 / 仓库调拨
--
-- 设计口径（与平哥确认）：
--   1. 真·分仓库存 —— 每个仓库独立记数量，库存引擎按仓扣减与校验；
--   2. 仓与品类绑定 —— 物料库只放物料、成品库只放成品、「主仓库」两类都能放；
--   3. 历史数据 —— 物料库存与流水归入物料库，成品归入成品库（不丢数、不改总量）。
--
-- 向后兼容：
--   * materials.current_stock / products.current_stock **保留且含义不变**（仍是该对象的总库存），
--     分仓数量单独落在 stock_warehouse，二者恒等由 core/ledger.ts 保证；
--   * stock_ledger.warehouse_id 允许为空，为空一律按该品类的默认仓解读，老流水不受影响；
--   * 所有单据表的 warehouse_id 同理可空，老单据照常查询与撤销。
-- ============================================================

-- ---------- 仓库档案 ----------
CREATE TABLE IF NOT EXISTS warehouses (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  code        TEXT    NOT NULL UNIQUE,
  name        TEXT    NOT NULL UNIQUE,
  -- main=主仓库（成品/物料都能放）| material=物料库 | product=成品库
  kind        TEXT    NOT NULL DEFAULT 'main',
  -- 该品类下的默认仓（出入库未指定仓库时的兜底）
  is_default  INTEGER NOT NULL DEFAULT 0,
  status      TEXT    NOT NULL DEFAULT '启用',      -- 启用 | 停用
  remark      TEXT,
  created_at  TEXT    NOT NULL,
  updated_at  TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_warehouses_kind ON warehouses (kind, is_default);

-- 预置两个业务仓：物料库 / 成品库（历史库存就落在它们身上，保证老业务不受影响）
INSERT OR IGNORE INTO warehouses (code, name, kind, is_default, status, remark, created_at, updated_at)
VALUES ('WL', '物料库', 'material', 1, '启用', '系统预置：物料类库存默认仓', datetime('now'), datetime('now'));

INSERT OR IGNORE INTO warehouses (code, name, kind, is_default, status, remark, created_at, updated_at)
VALUES ('CP', '成品库', 'product', 1, '启用', '系统预置：成品类库存默认仓', datetime('now'), datetime('now'));

-- ---------- 分仓库存 ----------
-- 一个对象在一个仓里只有一行；总库存 = 该对象所有仓 qty 之和（= materials.current_stock）
CREATE TABLE IF NOT EXISTS stock_warehouse (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  item_type    TEXT    NOT NULL,                 -- material | product
  item_id      INTEGER NOT NULL,
  warehouse_id INTEGER NOT NULL REFERENCES warehouses (id),
  qty          REAL    NOT NULL DEFAULT 0,
  updated_at   TEXT    NOT NULL,
  UNIQUE (item_type, item_id, warehouse_id)
);

CREATE INDEX IF NOT EXISTS idx_stock_wh_item ON stock_warehouse (item_type, item_id);
CREATE INDEX IF NOT EXISTS idx_stock_wh_wh ON stock_warehouse (warehouse_id);

-- ---------- 仓库调拨 ----------
-- 一张调拨单 = 一个调出仓 + 一个调入仓；明细按「对象 + 批次」记录
CREATE TABLE IF NOT EXISTS warehouse_transfers (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  transfer_no    TEXT    NOT NULL UNIQUE,
  from_warehouse_id INTEGER NOT NULL REFERENCES warehouses (id),
  to_warehouse_id   INTEGER NOT NULL REFERENCES warehouses (id),
  transfer_date  TEXT    NOT NULL,
  operator_id    INTEGER REFERENCES users (id),
  status         TEXT    NOT NULL DEFAULT '有效',   -- 有效 | 已撤销
  remark         TEXT,
  created_at     TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_transfer_time ON warehouse_transfers (created_at);

CREATE TABLE IF NOT EXISTS warehouse_transfer_items (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  transfer_id  INTEGER NOT NULL REFERENCES warehouse_transfers (id) ON DELETE CASCADE,
  item_type    TEXT    NOT NULL,
  item_id      INTEGER NOT NULL,
  -- 批次号：可空（未启用批次管理的对象为空串处理）
  batch_no     TEXT,
  qty          REAL    NOT NULL,
  unit_price   REAL    NOT NULL DEFAULT 0,
  remark       TEXT
);

CREATE INDEX IF NOT EXISTS idx_transfer_items ON warehouse_transfer_items (transfer_id);

-- 调拨单号序列
INSERT OR IGNORE INTO code_sequences (prefix, current) VALUES ('TR', 0);

-- ---------- 老表加仓库字段（可空 = 按品类默认仓解读） ----------
ALTER TABLE stock_ledger       ADD COLUMN warehouse_id INTEGER;
ALTER TABLE purchase_receipts  ADD COLUMN warehouse_id INTEGER;
ALTER TABLE purchase_returns   ADD COLUMN warehouse_id INTEGER;
ALTER TABLE sale_deliveries    ADD COLUMN warehouse_id INTEGER;
ALTER TABLE sale_returns       ADD COLUMN warehouse_id INTEGER;
ALTER TABLE material_issues    ADD COLUMN warehouse_id INTEGER;
ALTER TABLE material_returns   ADD COLUMN warehouse_id INTEGER;
ALTER TABLE product_receipts   ADD COLUMN warehouse_id INTEGER;
ALTER TABLE material_sales     ADD COLUMN warehouse_id INTEGER;
ALTER TABLE defective_outs     ADD COLUMN warehouse_id INTEGER;
ALTER TABLE stock_checks       ADD COLUMN warehouse_id INTEGER;

CREATE INDEX IF NOT EXISTS idx_ledger_wh ON stock_ledger (warehouse_id);

-- ---------- 一次性回填历史数据（物料→物料库，成品→成品库） ----------
-- 老流水：按 item_type 归到对应仓
UPDATE stock_ledger SET warehouse_id =
  (SELECT id FROM warehouses WHERE kind = 'material' AND code = 'WL' LIMIT 1)
 WHERE warehouse_id IS NULL AND item_type = 'material';

UPDATE stock_ledger SET warehouse_id =
  (SELECT id FROM warehouses WHERE kind = 'product' AND code = 'CP' LIMIT 1)
 WHERE warehouse_id IS NULL AND item_type = 'product';

-- 老库存：把 materials.current_stock 整份落到物料库、products.current_stock 落到成品库
INSERT OR IGNORE INTO stock_warehouse (item_type, item_id, warehouse_id, qty, updated_at)
SELECT 'material', m.id,
       (SELECT id FROM warehouses WHERE kind = 'material' AND code = 'WL' LIMIT 1),
       m.current_stock, datetime('now')
  FROM materials m
 WHERE (SELECT id FROM warehouses WHERE kind = 'material' AND code = 'WL' LIMIT 1) IS NOT NULL;

INSERT OR IGNORE INTO stock_warehouse (item_type, item_id, warehouse_id, qty, updated_at)
SELECT 'product', p.id,
       (SELECT id FROM warehouses WHERE kind = 'product' AND code = 'CP' LIMIT 1),
       p.current_stock, datetime('now')
  FROM products p
 WHERE (SELECT id FROM warehouses WHERE kind = 'product' AND code = 'CP' LIMIT 1) IS NOT NULL;

-- 老单据：同样按品类回填，保证「单据上的仓库」与「流水上的仓库」口径一致
UPDATE purchase_receipts SET warehouse_id =
  (SELECT id FROM warehouses WHERE kind = 'material' AND code = 'WL' LIMIT 1) WHERE warehouse_id IS NULL;
UPDATE purchase_returns SET warehouse_id =
  (SELECT id FROM warehouses WHERE kind = 'material' AND code = 'WL' LIMIT 1) WHERE warehouse_id IS NULL;
UPDATE material_issues SET warehouse_id =
  (SELECT id FROM warehouses WHERE kind = 'material' AND code = 'WL' LIMIT 1) WHERE warehouse_id IS NULL;
UPDATE material_returns SET warehouse_id =
  (SELECT id FROM warehouses WHERE kind = 'material' AND code = 'WL' LIMIT 1) WHERE warehouse_id IS NULL;
UPDATE material_sales SET warehouse_id =
  (SELECT id FROM warehouses WHERE kind = 'material' AND code = 'WL' LIMIT 1) WHERE warehouse_id IS NULL;
UPDATE defective_outs SET warehouse_id =
  (SELECT id FROM warehouses WHERE kind = 'material' AND code = 'WL' LIMIT 1) WHERE warehouse_id IS NULL;
UPDATE sale_deliveries SET warehouse_id =
  (SELECT id FROM warehouses WHERE kind = 'product' AND code = 'CP' LIMIT 1) WHERE warehouse_id IS NULL;
UPDATE sale_returns SET warehouse_id =
  (SELECT id FROM warehouses WHERE kind = 'product' AND code = 'CP' LIMIT 1) WHERE warehouse_id IS NULL;
UPDATE product_receipts SET warehouse_id =
  (SELECT id FROM warehouses WHERE kind = 'product' AND code = 'CP' LIMIT 1) WHERE warehouse_id IS NULL;
-- 盘点单：明细全是物料 → 物料库；全是成品 → 成品库；混合品类 → 留 NULL。
-- NULL 的语义是「各明细按自身品类归默认仓」，所以历史混合盘点单审核时依旧各归各仓，
-- 不会因为「一个盘点单只能一个仓」被卡死。
UPDATE stock_checks SET warehouse_id =
  (SELECT id FROM warehouses WHERE kind = 'material' AND code = 'WL' LIMIT 1)
 WHERE warehouse_id IS NULL
   AND EXISTS (SELECT 1 FROM stock_check_items i WHERE i.check_id = stock_checks.id AND i.item_type = 'material')
   AND NOT EXISTS (SELECT 1 FROM stock_check_items i WHERE i.check_id = stock_checks.id AND i.item_type = 'product');

UPDATE stock_checks SET warehouse_id =
  (SELECT id FROM warehouses WHERE kind = 'product' AND code = 'CP' LIMIT 1)
 WHERE warehouse_id IS NULL
   AND EXISTS (SELECT 1 FROM stock_check_items i WHERE i.check_id = stock_checks.id AND i.item_type = 'product')
   AND NOT EXISTS (SELECT 1 FROM stock_check_items i WHERE i.check_id = stock_checks.id AND i.item_type = 'material');
