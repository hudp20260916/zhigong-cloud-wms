import { Router } from 'express';
import { z } from 'zod';
import { db, nowIso, tx } from '../../db/index.js';
import { Err } from '../../core/errors.js';
import { pinyinInitials } from '../../core/pinyin.js';
import { writeLog } from '../../core/log.js';
import { bomLinesOf, replaceBom } from '../../core/bom.js';
import { requirePerm } from '../../middleware/auth.js';
import { countRows, nameOrderSql, normalizeDir, parsePage } from '../../shared/query.js';
import { ok, okList } from '../../shared/http.js';

export const productRouter = Router();

const bomLineSchema = z.object({
  materialId: z.number().int().positive(),
  qty: z.number().positive('BOM 物料单件耗用量必须大于 0'),
});

const productSchema = z.object({
  code: z.string().trim().optional(),
  name: z.string().trim().min(1, '成品名称不能为空'),
  spec: z.string().trim().optional().default(''),
  /** 分类（选填），与物料档案 materials.category 口径一致 */
  category: z.string().trim().optional().default(''),
  unit: z.string().trim().default('台'),
  packingSpec: z.string().trim().optional().default(''),
  cartonMaterialId: z.number().int().nullable().optional(),
  safetyStock: z.number().min(0).default(0),
  bomVersion: z.string().trim().default('V1.0'),
  remark: z.string().trim().optional().default(''),
  bom: z.array(bomLineSchema).default([]),
  /** 未配置 BOM 时保存需前端二次确认后传入 true（需求 5） */
  confirmNoBom: z.boolean().default(false),
});

/** 复制建档时的编码自动生成：不继承源成品编码（需求 4.2） */
function nextProductCode(): string {
  const row = db.prepare(`SELECT code FROM products ORDER BY id DESC LIMIT 1`).get() as any;
  const seq = (Number(row?.code?.replace(/\D/g, '')) || 1000) + 1;
  return `P${seq}`;
}

function validateBom(bom: { materialId: number; qty: number }[], confirmNoBom: boolean): void {
  const seen = new Set<number>();
  for (const line of bom) {
    if (seen.has(line.materialId)) {
      const m = db.prepare(`SELECT name FROM materials WHERE id = ?`).get(line.materialId) as any;
      throw Err.conflict(`BOM 中存在重复物料【${m?.name ?? line.materialId}】，请合并后再保存`);
    }
    seen.add(line.materialId);
    if (line.qty <= 0) {
      const m = db.prepare(`SELECT name FROM materials WHERE id = ?`).get(line.materialId) as any;
      throw Err.badRequest(`物料【${m?.name ?? line.materialId}】单件耗用量必须大于 0`);
    }
  }
  if (bom.length === 0 && !confirmNoBom) {
    throw Err.conflict('当前成品未配置 BOM 清单，确认保存？', { needConfirm: true });
  }
}

productRouter.get('/', requirePerm('archive.product.view'), (req, res) => {
  const { page, pageSize, offset, keyword } = parsePage(req);
  const order = nameOrderSql('p.name', normalizeDir(req.query.sortDir));

  const where = keyword
    ? `(p.code LIKE @kw OR p.name LIKE @kw OR IFNULL(p.pinyin,'') LIKE @kw OR IFNULL(p.spec,'') LIKE @kw)`
    : '1=1';
  const params = keyword ? { kw: `%${keyword}%`, limit: pageSize, offset } : { limit: pageSize, offset };

  const rows = db
    .prepare(
      `SELECT p.*, cm.name AS carton_material_name,
              (SELECT COUNT(*) FROM bom_items b WHERE b.product_id = p.id) AS bom_count
         FROM products p LEFT JOIN materials cm ON cm.id = p.carton_material_id
        WHERE ${where}
        ORDER BY ${order}
        LIMIT @limit OFFSET @offset`,
    )
    .all(params) as any[];

  const total = countRows(
    `products p`,
    keyword
      ? `(p.code LIKE @kw OR p.name LIKE @kw OR IFNULL(p.pinyin,'') LIKE @kw OR IFNULL(p.spec,'') LIKE @kw)`
      : '1=1',
    keyword ? [`%${keyword}%`] : [],
  );

  okList(res, rows, total);
});

productRouter.get('/options', requirePerm('archive.product.view'), (_req, res) => {
  const rows = db
    .prepare(
      `SELECT id, code, name, spec, unit, pinyin, bom_version, current_stock, safety_stock
         FROM products ORDER BY name COLLATE NOCASE`,
    )
    .all();
  ok(res, rows);
});

/** 详情含完整 BOM，成品复制功能以此为预填数据源 */
productRouter.get('/:id', requirePerm('archive.product.view'), (req, res) => {
  const id = Number(req.params.id);
  const product = db.prepare(`SELECT * FROM products WHERE id = ?`).get(id) as any;
  if (!product) throw Err.notFound('成品不存在');
  ok(res, { ...product, bom: bomLinesOf(id) });
});

productRouter.post('/', requirePerm('archive.product.manage'), (req, res) => {
  const parsed = productSchema.safeParse(req.body);
  if (!parsed.success) throw Err.badRequest(parsed.error.issues[0].message);
  const d = parsed.data;

  const id = tx(() => {
    if (d.code) {
      const dup = db.prepare(`SELECT id FROM products WHERE code = ?`).get(d.code);
      if (dup) throw Err.conflict(`成品编码【${d.code}】已存在，请重新输入`);
    }
    validateBom(d.bom, d.confirmNoBom);

    const code = d.code?.trim() || nextProductCode();
    const info = db
      .prepare(
        `INSERT INTO products (code, name, pinyin, spec, category, unit, packing_spec, carton_material_id,
           safety_stock, bom_version, remark, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        code,
        d.name,
        pinyinInitials(d.name),
        d.spec,
        d.category || null,
        d.unit,
        d.packingSpec,
        d.cartonMaterialId ?? null,
        d.safetyStock,
        d.bomVersion || 'V1.0',
        d.remark,
        nowIso(),
        nowIso(),
      );

    const newId = Number(info.lastInsertRowid);
    replaceBom(
      newId,
      d.bom.map((l) => ({ materialId: l.materialId, qty: l.qty })),
    );

    writeLog({
      operatorId: req.ctx!.userId,
      action: '新增成品档案',
      targetType: 'product',
      targetId: newId,
      detail: { code, name: d.name, bomCount: d.bom.length },
    });
    return newId;
  });

  ok(res, { id });
});

productRouter.put('/:id', requirePerm('archive.product.manage'), (req, res) => {
  const parsed = productSchema.safeParse(req.body);
  if (!parsed.success) throw Err.badRequest(parsed.error.issues[0].message);
  const d = parsed.data;
  const id = Number(req.params.id);

  tx(() => {
    const exists = db.prepare(`SELECT id FROM products WHERE id = ?`).get(id);
    if (!exists) throw Err.notFound('成品不存在');
    if (d.code) {
      const dup = db.prepare(`SELECT id FROM products WHERE code = ? AND id <> ?`).get(d.code, id);
      if (dup) throw Err.conflict(`成品编码【${d.code}】已存在，请重新输入`);
    }
    validateBom(d.bom, d.confirmNoBom);

    db.prepare(
      `UPDATE products SET name=?, pinyin=?, spec=?, category=?, unit=?, packing_spec=?, carton_material_id=?,
         safety_stock=?, bom_version=?, remark=?, updated_at=?
       WHERE id=?`,
    ).run(
      d.name,
      pinyinInitials(d.name),
      d.spec,
      d.category || null,
      d.unit,
      d.packingSpec,
      d.cartonMaterialId ?? null,
      d.safetyStock,
      d.bomVersion || 'V1.0',
      d.remark,
      nowIso(),
      id,
    );
    replaceBom(
      id,
      d.bom.map((l) => ({ materialId: l.materialId, qty: l.qty })),
    );
    writeLog({
      operatorId: req.ctx!.userId,
      action: '修改成品档案',
      targetType: 'product',
      targetId: id,
      detail: { name: d.name },
    });
  });

  ok(res, { id });
});

productRouter.delete('/:id', requirePerm('archive.product.manage'), (req, res) => {
  const id = Number(req.params.id);
  tx(() => {
    const row = db.prepare(`SELECT name, current_stock FROM products WHERE id = ?`).get(id) as any;
    if (!row) throw Err.notFound('成品不存在');
    if (Number(row.current_stock) !== 0) {
      throw Err.conflict(`成品【${row.name}】当前库存不为 0，禁止删除`);
    }
    db.prepare(`DELETE FROM products WHERE id = ?`).run(id);
    writeLog({
      operatorId: req.ctx!.userId,
      action: '删除成品档案',
      targetType: 'product',
      targetId: id,
    });
  });
  ok(res, { id });
});
