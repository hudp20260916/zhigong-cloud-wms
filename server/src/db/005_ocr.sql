-- ============================================================
-- P6 OCR 建单扩展点
--   ocr_logs 记录每次识别请求，便于追溯「这张入库单是识别出来的还是手填的」，
--   也便于后期评估识别准确率、替换识别服务时做对照。
-- ============================================================

CREATE TABLE IF NOT EXISTS ocr_logs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id   TEXT    NOT NULL UNIQUE,
  operator_id  INTEGER REFERENCES users (id),
  provider     TEXT    NOT NULL DEFAULT 'mock',   -- mock | 真实服务商标识
  file_name    TEXT,
  mime_type    TEXT,
  file_size    INTEGER NOT NULL DEFAULT 0,
  status       TEXT    NOT NULL,                  -- 成功 | 失败 | 已建单
  duration_ms  INTEGER NOT NULL DEFAULT 0,
  line_count   INTEGER NOT NULL DEFAULT 0,
  result_json  TEXT,                              -- 识别结果快照（JSON）
  error_message TEXT,
  receipt_id   INTEGER,                           -- 基于该识别结果生成的入库单
  created_at   TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ocr_time ON ocr_logs (created_at);
CREATE INDEX IF NOT EXISTS idx_ocr_receipt ON ocr_logs (receipt_id);
