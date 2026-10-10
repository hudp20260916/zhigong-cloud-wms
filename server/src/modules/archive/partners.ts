import { Router } from 'express';
import { z } from 'zod';
import { db, nowIso, tx } from '../../db/index.js';
import { Err } from '../../core/errors.js';
import { writeLog } from '../../core/log.js';
import { requirePerm } from '../../middleware/auth.js';
import { countRows, nameOrderSql, normalizeDir, parsePage } from '../../shared/query.js';
import { ok, okList } from '../../shared/http.js';

/** 供应商与客户档案结构一致，用工厂函数生成两套路由，避免复制粘贴 */
function partnerRouter(kind: 'supplier' | 'customer') {
  const router = Router();
  const table = kind === 'supplier' ? 'suppliers' : 'customers';
  const label = kind === 'supplier' ? '供应商' : '客户';
  const prefix = kind === 'supplier' ? 'S' : 'C';

  const schema = z.object({
    code: z.string().trim().optional(),
    name: z.string().trim().min(1, `${label}名称不能为空`),
    contact: z.string().trim().optional().default(''),
    phone: z.string().trim().optional().default(''),
    remark: z.string().trim().optional().default(''),
  });

  function nextCode(): string {
    const row = db.prepare(`SELECT code FROM ${table} ORDER BY id DESC LIMIT 1`).get() as any;
    const seq = (Number(row?.code?.replace(/\D/g, '')) || 100) + 1;
    return `${prefix}${seq}`;
  }

  router.get('/', requirePerm('archive.partner.view'), (req, res) => {
    const { page, pageSize, offset, keyword } = parsePage(req);
    const order = nameOrderSql('name', normalizeDir(req.query.sortDir));
    const where = keyword ? `(code LIKE @kw OR name LIKE @kw OR IFNULL(phone,'') LIKE @kw)` : '1=1';
    const params = keyword
      ? { kw: `%${keyword}%`, limit: pageSize, offset }
      : { limit: pageSize, offset };

    const rows = db
      .prepare(`SELECT * FROM ${table} WHERE ${where} ORDER BY ${order} LIMIT @limit OFFSET @offset`)
      .all(params);
    // countRows 走位置参数，这里必须用 ? 版本（用 @kw 会导致参数个数不匹配）
    const total = countRows(
      table,
      keyword ? `(code LIKE ? OR name LIKE ? OR IFNULL(phone,'') LIKE ?)` : '1=1',
      keyword ? [`%${keyword}%`, `%${keyword}%`, `%${keyword}%`] : [],
    );
    okList(res, rows, total);
  });

  router.get('/options', requirePerm('archive.partner.view'), (_req, res) => {
    ok(res, db.prepare(`SELECT id, code, name FROM ${table} ORDER BY name COLLATE NOCASE`).all());
  });

  router.post('/', requirePerm('archive.partner.manage'), (req, res) => {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) throw Err.badRequest(parsed.error.issues[0].message);
    const d = parsed.data;

    const id = tx(() => {
      if (d.code) {
        const dup = db.prepare(`SELECT id FROM ${table} WHERE code = ?`).get(d.code);
        if (dup) throw Err.conflict(`${label}编码【${d.code}】已存在，请重新输入`);
      }
      const code = d.code?.trim() || nextCode();
      const info = db
        .prepare(
          `INSERT INTO ${table} (code, name, contact, phone, remark, created_at) VALUES (?,?,?,?,?,?)`,
        )
        .run(code, d.name, d.contact, d.phone, d.remark, nowIso());
      writeLog({
        operatorId: req.ctx!.userId,
        action: `新增${label}档案`,
        targetType: kind,
        targetId: Number(info.lastInsertRowid),
      });
      return Number(info.lastInsertRowid);
    });
    ok(res, { id });
  });

  router.put('/:id', requirePerm('archive.partner.manage'), (req, res) => {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) throw Err.badRequest(parsed.error.issues[0].message);
    const d = parsed.data;
    const id = Number(req.params.id);

    tx(() => {
      if (!db.prepare(`SELECT id FROM ${table} WHERE id = ?`).get(id)) {
        throw Err.notFound(`${label}不存在`);
      }
      if (d.code) {
        const dup = db.prepare(`SELECT id FROM ${table} WHERE code = ? AND id <> ?`).get(d.code, id);
        if (dup) throw Err.conflict(`${label}编码【${d.code}】已存在，请重新输入`);
      }
      db.prepare(
        `UPDATE ${table} SET name=?, contact=?, phone=?, remark=? WHERE id=?`,
      ).run(d.name, d.contact, d.phone, d.remark, id);
      writeLog({
        operatorId: req.ctx!.userId,
        action: `修改${label}档案`,
        targetType: kind,
        targetId: id,
      });
    });
    ok(res, { id });
  });

  router.delete('/:id', requirePerm('archive.partner.manage'), (req, res) => {
    const id = Number(req.params.id);
    tx(() => {
      db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
      writeLog({
        operatorId: req.ctx!.userId,
        action: `删除${label}档案`,
        targetType: kind,
        targetId: id,
      });
    });
    ok(res, { id });
  });

  return router;
}

export const supplierRouter = partnerRouter('supplier');
export const customerRouter = partnerRouter('customer');
