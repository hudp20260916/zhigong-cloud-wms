import { db, todayStr } from '../db/index.js';

/**
 * OCR 识别适配器（P6 扩展点）。
 *
 * 设计取舍：对外只暴露一个 `recognizePurchaseDoc()`，返回结构固定的 `OcrResult`。
 * 现阶段内部用 mock 实现（从当前物料档案里确定性抽样，保证任何库都能演示且匹配率高），
 * 接真实服务时**只需替换 `callProvider()` 的内部实现**，返回结构不变，
 * 上层的接口、日志、建单流程一行都不用改。
 */

export interface OcrLine {
  /** 物料档案匹配结果：命中的物料 id；未命中为 null，需要人工指定 */
  materialId: number | null;
  materialCode: string;
  materialName: string;
  spec: string;
  unit: string;
  qty: number;
  price: number;
  /** 置信度 0~1；低于 LOW_CONFIDENCE 的行会进 warnings，提示人工复核 */
  confidence: number;
}

export interface OcrResult {
  supplierId: number | null;
  supplierName: string;
  docDate: string;
  docNo: string;
  lines: OcrLine[];
  warnings: string[];
}

/** 低于该置信度的行判定为「需人工复核」 */
export const LOW_CONFIDENCE = 0.85;

/** 稳定字符串哈希：同一张图每次识别结果一致，便于演示与回归测试 */
function hashCode(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

function round(n: number, p = 2): number {
  const f = 10 ** p;
  return Math.round(n * f) / f;
}

/**
 * Mock 识别：从当前物料档案中按内容哈希抽样 2~4 个物料，
 * 单价取该物料最近一次采购入库价，并刻意制造一行低置信度用于演示复核提示。
 */
function mockRecognize(seed: string): OcrResult {
  const h = hashCode(seed);

  const materials = db
    .prepare(
      `SELECT m.id, m.code, m.name, m.spec, m.unit, m.avg_cost
         FROM materials m
        WHERE m.is_virtual = 0
        ORDER BY m.id`,
    )
    .all() as any[];

  if (materials.length === 0) {
    return {
      supplierId: null,
      supplierName: '',
      docDate: todayStr(),
      docNo: '',
      lines: [],
      warnings: ['物料档案为空，无法完成识别，请先维护物料档案'],
    };
  }

  const count = 2 + (h % 3); // 2~4 行
  const start = h % materials.length;
  const lines: OcrLine[] = [];

  for (let i = 0; i < count; i++) {
    const m = materials[(start + i) % materials.length];
    // 最近一次采购价，取不到则退回移动加权成本
    const last = db
      .prepare(
        `SELECT ri.price FROM purchase_receipt_items ri
           JOIN purchase_receipts r ON r.id = ri.receipt_id
          WHERE ri.material_id = ? AND r.status = '有效' AND ri.price > 0
          ORDER BY r.id DESC LIMIT 1`,
      )
      .get(m.id) as { price: number } | undefined;

    const price = Number(last?.price ?? m.avg_cost ?? 0);
    // 最后一行刻意给低置信度，演示「需人工复核」提示
    const confidence = i === count - 1 ? round(0.62 + ((h >> i) % 20) / 100) : round(0.88 + ((h >> (i + 2)) % 12) / 100);

    lines.push({
      materialId: Number(m.id),
      materialCode: m.code,
      materialName: m.name,
      spec: m.spec ?? '',
      unit: m.unit,
      qty: 50 + ((h >> (i * 3)) % 8) * 25,
      price: round(price),
      confidence,
    });
  }

  const suppliers = db.prepare(`SELECT id, name FROM suppliers ORDER BY id`).all() as any[];
  const supplier = suppliers.length > 0 ? suppliers[h % suppliers.length] : null;

  const warnings: string[] = [];
  const low = lines.filter((l) => l.confidence < LOW_CONFIDENCE);
  if (low.length > 0) {
    warnings.push(
      `${low.length} 行置信度低于 ${Math.round(LOW_CONFIDENCE * 100)}%（${low.map((l) => l.materialName).join('、')}），请人工核对数量与单价`,
    );
  }

  return {
    supplierId: supplier ? Number(supplier.id) : null,
    supplierName: supplier?.name ?? '',
    docDate: todayStr(),
    docNo: `SR-${String(h % 100000).padStart(5, '0')}`,
    lines,
    warnings,
  };
}

/**
 * ★ 真实识别服务的接入点。
 *
 * 替换实现时保持「入参为原始文件、出参为 OcrResult」即可，例如：
 *
 *   const r = await fetch(OCR_ENDPOINT, { method: 'POST', body: form });
 *   const json = await r.json();
 *   return normalize(json);   // 把服务商的字段映射到 OcrLine / OcrResult
 *
 * 建议保留 mock 作为降级：真实服务超时或报错时返回 mock 并在 warnings 里标注，
 * 这样 OCR 建单不会因外部服务抖动而完全不可用。
 */
async function callProvider(input: {
  fileName: string;
  mimeType: string;
  contentBase64: string;
}): Promise<OcrResult> {
  // 演示阶段直接返回 mock；接入真实服务时在此替换为 HTTP 调用
  void input.mimeType;
  return mockRecognize(`${input.fileName}|${input.contentBase64.length}|${input.contentBase64.slice(0, 512)}`);
}

export async function recognizePurchaseDoc(input: {
  fileName: string;
  mimeType: string;
  contentBase64: string;
}): Promise<OcrResult> {
  return callProvider(input);
}

/** 单文件上传上限（解码后字节）：4MB，避免超大图片打爆内存与请求体 */
export const MAX_OCR_FILE_SIZE = 4 * 1024 * 1024;

export const OCR_MIME_WHITELIST = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/bmp',
  'application/pdf',
];
