-- 不良品出库 · 领料溯源（2026-10-12）
--
-- 场景：生产中从领料单识别出的不良品，走「不良品出库」处置时，
-- 标注它来自哪张生产领料单，实现「领料 → 不良品出库」原路回溯。
--
-- 设计要点：
--  - 复用现有「不良品出库」单据（defective_outs / defective_out_items），
--    只加溯源字段，不新建单据类型，正常库存口径不变。
--  - source_type：
--      manual = 手工拣选不良品（原有行为，不关联领料单）
--      issue  = 生产领料后识别的不良品退回，关联 issue_id
--  - issue_id：来源生产领料单 id（source_type='issue' 时必填，外键弱校验）。
--  - produce_qty：本单不良品「对应的成品数量」（台/件），作为损耗从工单可入库余量中扣除；
--                 source_type='manual' 时固定 0。
--
-- 可入库余量收敛口径（与「生产退料」同一逻辑）：
--   可入库余量 = 累计有效领料 − 累计有效退料 − 累计领料来源不良品出库(produce_qty)
--   三者都代表「领了料、不会再变成合格成品」的部分，必须从可入库产能中扣除，
--   否则「领 100、不良 2」后仍能按 100 入库，合格产出虚高、账实不符。
--   helpers.refreshWorkOrder 已实现该口径（issued = 领料 − 退料 − 领料来源不良品出库）。
--
-- 迁移幂等：SQLite 的 ALTER ADD COLUMN 不支持 IF NOT EXISTS，
-- 按迁移框架（migrate() 按文件名记录、只应用一次）保证幂等；
-- 老库升级若已手工加过列，请先用 PRAGMA table_info 自查。

ALTER TABLE defective_outs ADD COLUMN source_type TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE defective_outs ADD COLUMN issue_id INTEGER;
ALTER TABLE defective_outs ADD COLUMN produce_qty REAL NOT NULL DEFAULT 0;

-- 追溯索引：按来源领料单反查不良品出库（「领料 → 不良品出库」原路回溯）
CREATE INDEX IF NOT EXISTS idx_defective_out_issue ON defective_outs (issue_id) WHERE issue_id IS NOT NULL;
