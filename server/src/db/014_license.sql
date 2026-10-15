-- ============================================================
-- 授权（License）—— 单行表，永远只有 id=1 这一行
--
-- 设计约定：
--   1. 没有激活码时走试用期（trial_start 首次启动写入），到期进宽限期，宽限过完转「只读模式」；
--   2. 激活码由离线签发工具生成（deploy/keys 私钥签名，服务端内置公钥校验），
--      携带 plan / seats / expire / 机器指纹三分量；
--   3. **绝不锁死客户数据**：最严重的状态也只是「禁止写入」，查询永远放行，
--      且全模块导出功能不受影响 —— 这条是商业伦理底线，改代码时别破坏它。
-- ============================================================

CREATE TABLE IF NOT EXISTS license (
  id             INTEGER PRIMARY KEY CHECK (id = 1),
  license_no     TEXT,
  licensee       TEXT,                 -- 被授权公司名（与系统参数的公司名交叉校验用）
  plan           TEXT,                 -- basic | standard | full
  seats          INTEGER,              -- 允许的账号数上限（NULL = 不限）
  expire_at      TEXT,                 -- 到期日 YYYY-MM-DD
  grace_days     INTEGER NOT NULL DEFAULT 7,
  license_key    TEXT,                 -- 完整激活码（payload.signature）
  fingerprint    TEXT,                 -- 激活时机器指纹三分量（JSON 数组）
  trial_start    TEXT,                 -- 试用期起点（首次启动写入）
  last_check_at  TEXT,
  activated_at   TEXT
);
