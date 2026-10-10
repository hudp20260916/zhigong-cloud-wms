import { Router } from 'express';
import { z } from 'zod';
import type { ItemType } from '../../../../shared/enums.js';
import { db, nowIso, tx } from '../../db/index.js';
import { Err } from '../../core/errors.js';
import { writeLog } from '../../core/log.js';
import { pinyinInitials } from '../../core/pinyin.js';
import { requirePerm } from '../../middleware/auth.js';
import { setInitialStock } from '../inventory/initial.js';
import { ok } from '../../shared/http.js';

export const importRouter = Router();

/**
 * Excel 批量导入。
 *
 * 取舍：**解析在前端（SheetJS），校验与落库在服务端**。
 *  - 前端解析：用户选完文件立即看到预览表格，能逐行改，体验好；
 *  - 服务端校验：唯一性、外键、数量合法性这些必须查库，放前端等于没校验；
 *  - 服务端落库：整个批次一个事务，任一失败整批回滚，不会留半截数据。
 *
 * 服务端只接收行数组，因此不绑定具体 Excel 库；后续换解析库不动后端。
 */

type RowErr = { row: number; message: string };

export interface ImportKindDef {
  kind: string;
  name: string;
  /** 模板列名（同时作为导入表头约定） */
  columns: { key: string; label: string; required?: boolean }[];
  hint: string;
}

export const IMPORT_KINDS: ImportKindDef[] = [
  {
    kind: 'material',
    name: '物料档案',
    hint: '编码、名称为必填且不可重复；默认供应商可填名称或编码，留空表示不指定；虚拟件填「是」将由构成物料穿透展开。',
    columns: [
      { key: 'code', label: '物料编码', required: true },
      { key: 'name', label: '物料名称', required: true },
      { key: 'spec', label: '规格型号' },
      { key: 'category', label: '分类' },
      { key: 'unit', label: '单位' },
      { key: 'safetyStock', label: '安全库存' },
      { key: 'supplier', label: '默认供应商' },
      { key: 'isVirtual', label: '虚拟件' },
      { key: 'remark', label: '备注' },
    ],
  },
  {
    kind: 'supplier',
    name: '供应商档案',
    hint: '编码、名称为必填且不可重复。',
    columns: [
      { key: 'code', label: '供应商编码', required: true },
      { key: 'name', label: '供应商名称', required: true },
      { key: 'contact', label: '联系人' },
      { key: 'phone', label: '联系电话' },
      { key: 'remark', label: '备注' },
    ],
  },
  {
    kind: 'customer',
    name: '客户档案',
    hint: '编码、名称为必填且不可重复。',
    columns: [
      { key: 'code', label: '客户编码', required: true },
      { key: 'name', label: '客户名称', required: true },
      { key: 'contact', label: '联系人' },
      { key: 'phone', label: '联系电话' },
      { key: 'remark', label: '备注' },
    ],
  },
  {
    kind: 'initial_stock',
    name: '期初库存',
    hint: '类型填「物料」或「成品」，留空时按编码自动识别；数量为必填且不小于 0；单价仅对物料生效，用于初始化移动加权成本。每个对象的期初库存为「设定」语义，重复导入会覆盖上次结果。',
    columns: [
      { key: 'code', label: '编码', required: true },
      { key: 'itemType', label: '类型' },
      { key: 'qty', label: '期初数量', required: true },
      { key: 'price', label: '单价' },
    ],
  },
];

function kindDef(kind: string): ImportKindDef {
  const d = IMPORT_KINDS.find((x) => x.kind === kind);
  if (!d) throw Err.badRequest(`未知导入类型：${kind}`);
  return d;
}

// ---------------------------------------------------------------- 工具

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).trim());
  return Number.isFinite(n) ? n : null;
}

function str(v: unknown): string {
  return String(v ?? '').trim();
}

function yes(v: unknown): boolean {
  const s = str(v).toLowerCase();
  return s === '是' || s === 'yes' || s === 'y' || s === '1' || s === 'true';
}

// ---------------------------------------------------------------- 路由

/** 导入模板定义（前端生成下载模板 / 表头映射） */
importRouter.get('/kinds', requirePerm('system.import.execute'), (_req, res) => {
  ok(res, IMPORT_KINDS);
});

const rowSchema = z.record(z.any());

const importSchema = z.object({
  kind: z.string().min(1),
  fileName: z.string().optional().default(''),
  rows: z.array(rowSchema).min(1, '没有可导入的数据'),
});

importRouter.post('/preview', requirePerm('system.import.execute'), (req, res) => {
  const parsed = importSchema.safeParse(req.body);
  if (!parsed.success) throw Err.badRequest(parsed.error.issues[0].message);
  const { kind, rows } = parsed.data;
  const def = kindDef(kind);

  // 预览只做「不查库也能判断」的校验：必填、数字格式
  const errors: RowErr[] = [];
  rows.forEach((r, i) => {
    const rowNo = i + 2; // 第 1 行是表头
    for (const c of def.columns) {
      if (c.required && !str(r[c.key])) {
        errors.push({ row: rowNo, message: `「${c.label}」不能为空` });
        return;
      }
    }
    if (kind === 'initial_stock') {
      const q = num(r.qty);
      if (q === null) errors.push({ row: rowNo, message: '「期初数量」必须是数字' });
      else if (q < 0) errors.push({ row: rowNo, message: '「期初数量」不能为负数' });
    }
    if (kind === 'material') {
      const s = num(r.safetyStock);
      if (s !== null && s < 0) errors.push({ row: rowNo, message: '「安全库存」不能为负数' });
    }
  });

  ok(res, { total: rows.length, errors });
});

importRouter.post('/execute', requirePerm('system.import.execute'), (req, res) => {
  const parsed = importSchema.safeParse(req.body);
  if (!parsed.success) throw Err.badRequest(parsed.error.issues[0].message);
  const { kind, rows, fileName } = parsed.data;
  kindDef(kind);
  const ctx = req.ctx!;

  let success = 0;
  let errors: RowErr[] = [];

  try {
    tx(() => {
      for (let i = 0; i < rows.length; i++) {
        const rowNo = i + 2;
        const r = rows[i];
        try {
          applyRow(kind, r, ctx.userId);
          success++;
        } catch (e: any) {
          errors.push({ row: rowNo, message: e?.message ?? '导入失败' });
        }
      }

      // 只要有失败行就整批回滚 —— 导入要么全成，要么一条不留
      if (errors.length > 0) {
        success = 0;
        throw new BatchRollback(errors);
      }

      db.prepare(
        `INSERT INTO import_logs (kind, file_name, total, success, failed, errors, operator_id, created_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      ).run(kind, fileName, rows.length, success, 0, '[]', ctx.userId, nowIso());

      writeLog({
        operatorId: ctx.userId,
        action: 'Excel 批量导入',
        targetType: 'import',
        detail: { kind, total: rows.length, success, file: fileName },
      });
    });
  } catch (e) {
    if (e instanceof BatchRollback) errors = e.errors;
    else throw e;
  }

  // 失败时也要留一条日志，便于事后追溯「谁导入失败在哪一行」
  if (errors.length > 0) {
    db.prepare(
      `INSERT INTO import_logs (kind, file_name, total, success, failed, errors, operator_id, created_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).run(kind, fileName, rows.length, 0, errors.length, JSON.stringify(errors), ctx.userId, nowIso());
  }

  ok(res, { total: rows.length, success, failed: errors.length, errors });
});

/** 用异常做事务回滚信号：better-sqlite3 的 tx() 会捕获并向上抛 */
class BatchRollback extends Error {
  constructor(public errors: RowErr[]) {
    super('BATCH_ROLLBACK');
  }
}

function applyRow(kind: string, r: Record<string, any>, operatorId: number): void {
  if (kind === 'material') return importMaterial(r);
  if (kind === 'supplier') return importPartner('suppliers', r);
  if (kind === 'customer') return importPartner('customers', r);
  if (kind === 'initial_stock') return importInitial(r, operatorId);
  throw Err.badRequest(`未知导入类型：${kind}`);
}

function ensureUnique(table: string, code: string, name: string): void {
  const byCode = db.prepare(`SELECT id FROM ${table} WHERE code = ?`).get(code);
  if (byCode) throw new Error(`编码「${code}」已存在`);
  const byName = db.prepare(`SELECT id FROM ${table} WHERE name = ?`).get(name);
  if (byName) throw new Error(`名称「${name}」已存在`);
}

function importMaterial(r: Record<string, any>): void {
  const code = str(r.code);
  const name = str(r.name);
  if (!code) throw new Error('物料编码不能为空');
  if (!name) throw new Error('物料名称不能为空');
  ensureUnique('materials', code, name);

  let supplierId: number | null = null;
  const supplier = str(r.supplier);
  if (supplier) {
    const s = db
      .prepare(`SELECT id FROM suppliers WHERE name = ? OR code = ? LIMIT 1`)
      .get(supplier, supplier) as { id: number } | undefined;
    if (!s) throw new Error(`默认供应商「${supplier}」不存在，请先导入供应商档案`);
    supplierId = s.id;
  }

  const safety = num(r.safetyStock);
  if (safety !== null && safety < 0) throw new Error('安全库存不能为负数');

  db.prepare(
    `INSERT INTO materials (code, name, pinyin, spec, category, unit, default_supplier_id,
                            safety_stock, current_stock, avg_cost, is_virtual, remark, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,0,0,?,?,?,?)`,
  ).run(
    code,
    name,
    pinyinInitials(name),
    str(r.spec),
    str(r.category),
    str(r.unit) || '个',
    supplierId,
    safety ?? 0,
    yes(r.isVirtual) ? 1 : 0,
    str(r.remark),
    nowIso(),
    nowIso(),
  );
}

function importPartner(table: 'suppliers' | 'customers', r: Record<string, any>): void {
  const code = str(r.code);
  const name = str(r.name);
  if (!code) throw new Error('编码不能为空');
  if (!name) throw new Error('名称不能为空');
  ensureUnique(table, code, name);

  db.prepare(
    `INSERT INTO ${table} (code, name, contact, phone, remark, created_at) VALUES (?,?,?,?,?,?)`,
  ).run(code, name, str(r.contact), str(r.phone), str(r.remark), nowIso());
}

function importInitial(r: Record<string, any>, operatorId: number): void {
  const code = str(r.code);
  if (!code) throw new Error('编码不能为空');
  const qty = num(r.qty);
  if (qty === null) throw new Error('期初数量必须是数字');
  if (qty < 0) throw new Error('期初数量不能为负数');
  const price = num(r.price);

  const rawType = str(r.itemType);
  if (rawType && !['物料', '成品', 'material', 'product'].includes(rawType)) {
    throw new Error('类型只能填「物料」或「成品」');
  }
  const normalized: ItemType | '' =
    rawType === '物料' || rawType === 'material'
      ? 'material'
      : rawType === '成品' || rawType === 'product'
        ? 'product'
        : '';

  let resolved = normalized;
  let itemId = 0;
  if (resolved) {
    const row = db.prepare(`SELECT id FROM ${resolved === 'material' ? 'materials' : 'products'} WHERE code = ?`).get(code) as
      | { id: number }
      | undefined;
    if (!row) throw new Error(`${resolved === 'material' ? '物料' : '成品'}编码「${code}」不存在`);
    itemId = row.id;
  } else {
    const m = db.prepare(`SELECT id FROM materials WHERE code = ?`).get(code) as { id: number } | undefined;
    if (m) {
      resolved = 'material';
      itemId = m.id;
    } else {
      const p = db.prepare(`SELECT id FROM products WHERE code = ?`).get(code) as { id: number } | undefined;
      if (!p) throw new Error(`编码「${code}」在物料与成品档案中都不存在`);
      resolved = 'product';
      itemId = p.id;
    }
  }

  setInitialStock(resolved, itemId, qty, price ?? undefined, operatorId);
}

/** 导入历史 */
importRouter.get('/logs', requirePerm('system.import.execute'), (req, res) => {
  const limit = Math.min(100, Math.max(1, Number(req.query.limit ?? 20) || 20));
  const rows = db
    .prepare(
      `SELECT l.*, u.display_name AS operator_name FROM import_logs l
         LEFT JOIN users u ON u.id = l.operator_id
        ORDER BY l.id DESC LIMIT ?`,
    )
    .all(limit) as any[];
  ok(res, rows);
});
