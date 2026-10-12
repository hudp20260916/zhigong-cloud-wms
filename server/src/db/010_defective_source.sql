-- 不良品出库 · 领料溯源 + 可入库余量收敛（2026-10-12）
--
-- 场景：生产中从领料单识别出的不良品，走「不良品出库」处置时，
-- 标注它来自哪张生产领料单（原路回溯），并按「对应成品数量」
-- 把产能损耗从工单可入库余量中扣除。
--
-- 设计要点：
--  - source_type：manual=手工拣选（原有行为，不联动工单产能）/ issue=生产领料来源
--  - issue_id：来源生产领料单 id（source_type='issue' 时必填）
--  - produce_qty：本单不良品「对应的成品数量」（台/件），作为损耗从工单可入库余量中扣除；
--                 source_type='manual' 时固定 0。
--
-- 可入库余量收敛口径（与「生产退料」同一逻辑）：
--   可入库余量 = 累计有效领料 − 累计有效退料 − 累计领料来源不良品出库(produce_qty)
--   helpers.refreshWorkOrder 已实现该口径（issued = 领料 − 退料 − 领料来源不良品出库）。
--
-- 迁移顺序：本文件在 010 建表阶段运行（defective_outs 已由前置迁移建好），
-- 先补列（幂等：已在的列由迁移框架 _migrations 表保证只跑一次，不会重跑重复列），
-- 再建追溯索引。

ALTER TABLE defective_outs ADD COLUMN source_type TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE defective_outs ADD COLUMN issue_id INTEGER;
ALTER TABLE defective_outs ADD COLUMN produce_qty REAL NOT NULL DEFAULT 0;

-- 追溯索引：按来源领料单反查不良品出库（「领料 → 不良品出库」原路回溯）
CREATE INDEX IF NOT EXISTS idx_defective_out_issue ON defective_outs (issue_id) WHERE issue_id IS NOT NULL;
