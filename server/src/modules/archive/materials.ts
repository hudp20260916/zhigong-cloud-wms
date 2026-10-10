import { Router } from 'express';
import { z } from 'zod';
import { db, nowIso, tx } from '../../db/index.js';
import { Err } from '../../core/errors.js';
import { pinyinInitials } from '../../core/pinyin.js';
import { writeLog } from '../../core/log.js';
import { maskList } from '../../core/serializer.js';
import { canViewPrice } from '../../middleware/context.js';
import { requirePerm } from '../../middleware/auth.js';
import { countRows, nameOrderSql, normalizeDir, parsePage } from '../../shared/query.js';
import { ok, okList } from '../../shared/http.js';

export const materialRouter = Router();

const materialSchema = z.object({
  code: z.string().trim().optional(),
  name: z.string().trim().min(1, '物料名称不能为空'),
  spec: z.string().trim().optional().default(''),
  category: z.string().trim().optional().default(''),
  unit: z.string().trim().default('个'),
  defaultSupplierId: z.number().int().nullable().optional(),
  safetyStock: z.number().min(0).default(0),
  isVirtual: z.boolean().default(false),
  remark: z.string().trim().optional().default(''),
});

materialRouter.get('/', requirePerm('archive.material.view'), (req, res) => {
  const { page, pageSize, offset, keyword } = parsePage(req);
  const dir = normalizeDir(req.query.sortDir);
  const order = nameOrderSql('m.name', dir);

  const where = keyword
    ? `(m.code LIKE @kw OR m.name LIKE @kw OR IFNULL(m.pinyin,'') LIKE @kw OR IFNULL(m.spec,'') LIKE @kw)`
    : '1=1';
  const p = keyword ? { kw: `%${keyword}%` } : {};

  const rows = db
    .prepare(
      `SELECT m.*, s.name AS default_supplier_name
         FROM materials m LEFT JOIN suppliers s ON s.id = m.default_supplier_id
        WHERE ${where}
        ORDER BY ${order}
        LIMIT @limit OFFSET @offset`,
    )
    .all({ ...p, limit: pageSize, offset }) as any[];

  const total = countRows(
    `materials m`,
    keyword
      ? `(m.code LIKE @kw OR m.name LIKE @kw OR IFNULL(m.pinyin,'') LIKE @kw OR IFNULL(m.spec,'') LIKE @kw)`
      : '1=1',
    keyword ? [`%${keyword}%`] : [],
  );

  okList(res, maskList(rows, { canViewPrice: canViewPrice(req.ctx!) }), total);
});

materialRouter.get('/options', requirePerm('archive.material.view'), (_req, res) => {
  const rows = db
    .prepare(
      `SELECT id, code, name, spec, unit, pinyin, is_virtual, current_stock, safety_stock,
              default_supplier_id, avg_cost
         FROM materials ORDER BY name COLLATE NOCASE`,
    )
    .all() as any[];
  ok(res, maskList(rows, { canViewPrice: true }));
});

materialRouter.get('/:id', requirePerm('archive.material.view'), (req, res) => {
  const row = db
    .prepare(
      `SELECT m.*, s.name AS default_supplier_name
         FROM materials m LEFT JOIN suppliers s ON s.id = m.default_supplier_id
        WHERE m.id = ?`,
    )
    .get(Number(req.params.id)) as any;
  if (!row) throw Err.notFound('物料不存在');
  ok(res, maskList([row], { canViewPrice: canViewPrice(req.ctx!) })[0]);
});

materialRouter.post('/', requirePerm('archive.material.manage'), (req, res) => {
  const parsed = materialSchema.safeParse(req.body);
  if (!parsed.success) throw Err.badRequest(parsed.error.issues[0].message);
  const d = parsed.data;

  const id = tx(() => {
    const dup = db.prepare(`SELECT id FROM materials WHERE code = ?`).get(d.code ?? '');
    if (d.code && dup) throw Err.conflict(`物料编码【${d.code}】已存在，请重新输入`);

    const code = d.code?.trim() || nextMaterialCode();
    const info = db
      .prepare(
        `INSERT INTO materials (code, name, pinyin, spec, category, unit, default_supplier_id,
           safety_stock, is_virtual, remark, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        code,
        d.name,
        pinyinInitials(d.name),
        d.spec,
        d.category,
        d.unit,
        d.defaultSupplierId ?? null,
        d.safetyStock,
        d.isVirtual ? 1 : 0,
        d.remark,
        nowIso(),
        nowIso(),
      );
    writeLog({
      operatorId: req.ctx!.userId,
      action: '新增物料档案',
      targetType: 'material',
      targetId: Number(info.lastInsertRowid),
      detail: { code, name: d.name },
    });
    return Number(info.lastInsertRowid);
  });

  ok(res, { id });
});

materialRouter.put('/:id', requirePerm('archive.material.manage'), (req, res) => {
  const parsed = materialSchema.safeParse(req.body);
  if (!parsed.success) throw Err.badRequest(parsed.error.issues[0].message);
  const d = parsed.data;
  const id = Number(req.params.id);

  tx(() => {
    const exists = db.prepare(`SELECT id FROM materials WHERE id = ?`).get(id);
    if (!exists) throw Err.notFound('物料不存在');
    if (d.code) {
      const dup = db.prepare(`SELECT id FROM materials WHERE code = ? AND id <> ?`).get(d.code, id);
      if (dup) throw Err.conflict(`物料编码【${d.code}】已存在，请重新输入`);
    }
    db.prepare(
      `UPDATE materials SET name=?, pinyin=?, spec=?, category=?, unit=?, default_supplier_id=?,
         safety_stock=?, is_virtual=?, remark=?, updated_at=?
       WHERE id=?`,
    ).run(
      d.name,
      pinyinInitials(d.name),
      d.spec,
      d.category,
      d.unit,
      d.defaultSupplierId ?? null,
      d.safetyStock,
      d.isVirtual ? 1 : 0,
      d.remark,
      nowIso(),
      id,
    );
    writeLog({
      operatorId: req.ctx!.userId,
      action: '修改物料档案',
      targetType: 'material',
      targetId: id,
      detail: { name: d.name },
    });
  });

  ok(res, { id });
});

materialRouter.delete('/:id', requirePerm('archive.material.manage'), (req, res) => {
  const id = Number(req.params.id);
  tx(() => {
    const row = db.prepare(`SELECT current_stock, name FROM materials WHERE id = ?`).get(id) as any;
    if (!row) throw Err.notFound('物料不存在');
    if (Number(row.current_stock) !== 0) {
      throw Err.conflict(`物料【${row.name}】当前库存不为 0，禁止删除`);
    }
    db.prepare(`DELETE FROM materials WHERE id = ?`).run(id);
    writeLog({
      operatorId: req.ctx!.userId,
      action: '删除物料档案',
      targetType: 'material',
      targetId: id,
    });
  });
  ok(res, { id });
});

function nextMaterialCode(): string {
  const row = db.prepare(`SELECT code FROM materials ORDER BY id DESC LIMIT 1`).get() as any;
  const seq = (Number(row?.code?.replace(/\D/g, '')) || 1000) + 1;
  return `M${seq}`;
}
