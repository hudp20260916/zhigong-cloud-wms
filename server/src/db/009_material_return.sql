-- 生产退料（2026-10-12）
--
-- 场景：工单计划 100，按 100 领料，实际只产出 98 台就停工转产，
-- 剩余未使用的物料需要按「原领料单、原量」退回物料库存，供其它产品使用。
--
-- 设计要点：
--  1. 退料单必须关联一条「原领料单」（issue_id），明细记录源领料明细 id（src_item_id），
--     实现「原路退回」的可追溯性：从哪张领料单扣的，就从哪张退回来。
--  2. 退料产生的是「物料入库」流水（biz_type='生产退料'），与领料出库方向相反，
--     库存数量与金额同步回补；撤销即反向对冲（复用 reverseStock）。
--  3. 退料后工单的 issued_qty 同步核减（refreshWorkOrder 需把退料量扣掉），
--     于是「可入库余量 = 领料 - 退料 - 已入库」自动收敛到实际投产数量，无需改入库锁量逻辑。

CREATE TABLE IF NOT EXISTS material_returns (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  return_no   TEXT    NOT NULL UNIQUE,
  wo_id       INTEGER NOT NULL REFERENCES work_orders (id),
  issue_id    INTEGER NOT NULL REFERENCES material_issues (id),   -- 原领料单（原路退回的依据）
  return_date TEXT    NOT NULL,
  return_qty  REAL    NOT NULL,              -- 本次退回对应的「成品数量」（台/件），用于核减领料产量
  status      TEXT    NOT NULL DEFAULT '有效',
  operator_id INTEGER REFERENCES users (id),
  remark      TEXT,
  created_at  TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_material_returns_wo ON material_returns (wo_id);
CREATE INDEX IF NOT EXISTS idx_material_returns_issue ON material_returns (issue_id);

CREATE TABLE IF NOT EXISTS material_return_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  return_id   INTEGER NOT NULL REFERENCES material_returns (id) ON DELETE CASCADE,
  material_id INTEGER NOT NULL REFERENCES materials (id),
  src_item_id INTEGER REFERENCES material_issue_items (id),  -- 源领料明细，原路回溯
  qty         REAL    NOT NULL,
  unit_price  REAL    NOT NULL DEFAULT 0,
  remark      TEXT
);
