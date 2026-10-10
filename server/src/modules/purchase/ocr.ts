import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { db, nowIso } from '../../db/index.js';
import { Err } from '../../core/errors.js';
import { writeLog } from '../../core/log.js';
import {
  OCR_MIME_WHITELIST,
  MAX_OCR_FILE_SIZE,
  recognizePurchaseDoc,
  type OcrResult,
} from '../../core/ocr.js';
import { requirePerm } from '../../middleware/auth.js';
import { asyncRoute, ok } from '../../shared/http.js';

export const ocrRouter = Router();

/**
 * OCR 建单入口。
 *
 * 定位：**识别结果永远只是草稿**，必须经人工确认后才落库为入库单。
 * 所以这里只返回结构化结果 + 写一条 ocr_logs，真正的库存变更仍然走
 * `POST /purchase/receipts`（source='ocr'），库存依旧只由 ledger 变更。
 *
 * 传输方式取舍：用 JSON 传 base64 而不是 multipart —— 后端因此不必引入 multer，
 * 且前端可以直接复用统一的 request() 封装（含 401 踢线）。代价是体积膨胀约 33%，
 * 已用 4MB 上限和图片白名单兜住。
 */

const recognizeSchema = z.object({
  fileName: z.string().trim().min(1, '缺少文件名'),
  mimeType: z.string().trim().min(1, '缺少文件类型'),
  contentBase64: z.string().min(1, '缺少文件内容'),
});

function decodeSize(b64: string): number {
  const body = b64.includes(',') ? b64.slice(b64.indexOf(',') + 1) : b64;
  const padding = body.endsWith('==') ? 2 : body.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((body.length * 3) / 4) - padding);
}

ocrRouter.post(
  '/recognize',
  requirePerm('purchase.receipt.create'),
  asyncRoute(async (req, res) => {
  const parsed = recognizeSchema.safeParse(req.body);
  if (!parsed.success) throw Err.badRequest(parsed.error.issues[0].message);
  const { fileName, mimeType, contentBase64 } = parsed.data;
  const ctx = req.ctx!;

  if (!OCR_MIME_WHITELIST.includes(mimeType)) {
    throw Err.badRequest(`不支持的文件类型：${mimeType}，请上传 jpg / png / webp / bmp / pdf`);
  }
  const size = decodeSize(contentBase64);
  if (size > MAX_OCR_FILE_SIZE) {
    throw Err.badRequest(`文件过大（${(size / 1024 / 1024).toFixed(1)}MB），请压缩到 4MB 以内`);
  }

  const requestId = randomUUID();
  const started = Date.now();
  let result: OcrResult | null = null;
  let error: string | null = null;

  try {
    result = await recognizePurchaseDoc({ fileName, mimeType, contentBase64 });
  } catch (e: any) {
    error = e?.message ?? '识别失败';
  }

  const duration = Date.now() - started;

  db.prepare(
    `INSERT INTO ocr_logs
       (request_id, operator_id, provider, file_name, mime_type, file_size, status,
        duration_ms, line_count, result_json, error_message, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    requestId,
    ctx.userId,
    'mock',
    fileName,
    mimeType,
    size,
    error ? '失败' : '成功',
    duration,
    result?.lines.length ?? 0,
    result ? JSON.stringify(result) : null,
    error,
    nowIso(),
  );

  writeLog({
    operatorId: ctx.userId,
    action: 'OCR 识别采购单据',
    targetType: 'ocr',
    detail: { requestId, fileName, status: error ? '失败' : '成功', lines: result?.lines.length ?? 0 },
  });

  if (error) throw Err.badRequest(`识别失败：${error}`);

  ok(res, { requestId, result, durationMs: duration });
  }),
);

/** 建单完成后回写关联，便于统计「识别结果有多少被真正采纳」 */
export function linkOcrReceipt(requestId: string | undefined, receiptId: number): void {
  if (!requestId) return;
  db.prepare(`UPDATE ocr_logs SET status = '已建单', receipt_id = ? WHERE request_id = ?`).run(
    receiptId,
    requestId,
  );
}

ocrRouter.get('/logs', requirePerm('purchase.receipt.view'), (req, res) => {
  const limit = Math.min(100, Math.max(1, Number(req.query.limit ?? 20) || 20));
  const rows = db
    .prepare(
      `SELECT o.id, o.request_id, o.file_name, o.status, o.line_count, o.duration_ms,
              o.created_at, o.receipt_id, u.display_name AS operator_name
         FROM ocr_logs o LEFT JOIN users u ON u.id = o.operator_id
        ORDER BY o.id DESC LIMIT ?`,
    )
    .all(limit) as any[];
  ok(res, rows);
});

/** 识别准确率看板：给后续替换识别服务做对照用 */
ocrRouter.get('/stats', requirePerm('purchase.receipt.view'), (_req, res) => {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status <> '失败' THEN 1 ELSE 0 END) AS success,
              SUM(CASE WHEN status = '已建单' THEN 1 ELSE 0 END) AS adopted,
              AVG(duration_ms) AS avgMs
         FROM ocr_logs`,
    )
    .get() as any;
  ok(res, {
    total: Number(row.total ?? 0),
    success: Number(row.success ?? 0),
    adopted: Number(row.adopted ?? 0),
    avgMs: Math.round(Number(row.avgMs ?? 0)),
  });
});
