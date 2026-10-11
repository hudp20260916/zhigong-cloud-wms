import { Router } from 'express';
import { z } from 'zod';
import { PO_STATUS } from '../../../../shared/enums.js';
import { db, nowIso, tx } from '../../db/index.js';
import { Err } from '../../core/errors.js';
import { nextCode } from '../../core/code.js';
import { writeLog } from '../../core/log.js';
import { maskList } from '../../core/serializer.js';
import { requirePerm } from '../../middleware/auth.js';
import { canViewPrice } from '../../middleware/context.js';
import { countRows, parsePage } from '../../shared/query.js';
import { ok, okList } from '../../shared/http.js';
import {
  buildSummary,
  hasPending,
  materialNames,
  pendingItemsOf,
  refreshOrderStatus,
  syncParentStatus,
} from './helpers.js';

export const purchaseOrderRouter = Router();

const itemSchema = z.object({
  materialId: z.number().int().positive(),
  qty: z.number().positive('采购数量必须大于 0'),
  price: z.number().min(0).default(0),
});

const createSchema = z.object({
  mode: z.enum(['bom', 'direct']),
  items: z.array(itemSchema).min(1, '请至少选择一项采购内容'),
  /** bom 模式：主产品与计划产量，用于记录 BOM 版本与展开来源 */
  productId: z.number().int().nullable().optional(),
  planQty: z.number().positive().nullable().optional(),
  /**
   * 坑（本次修复的根因）：「直接采购物料」模式下前端会显式提交 bomVersion: null，
   * 而 z.string().optional() 只放行 undefined、不放行 null，
   * 于是整单被 400 "Expected string, received null" 拦下 —— 表现为「直接采购保存报错」。
   * 「按主产品采购」展开 BOM 后 bomVersion 有值，所以那个流程一直是好的。
   * 这里把所有可选项统一放开 nullish，落库前再归一。
   */
  bomVersion: z.string().trim().optional().nullable(),
  /** 手工指定供应商时覆盖物料默认供应商 */
  supplierId: z.number().int().nullable().optional(),
  orderDate: z.string().min(1, '请选择下单日期'),
  expectedDate: z.string().optional().nullable().default(''),
  remark: z.string().trim().optional().nullable().default(''),
});

/** 列表：附带采购摘要、是否可去入库（需求 4.1 状态与权限联动） */
purchaseOrderRouter.get('/', requirePerm('purchase.order.view'), (req, res) => {
  const { page, pageSize, offset, keyword } = parsePage(req);
  const status = String(req.query.status ?? '').trim();
  // 需求 5：供应商下拉筛选 + 物料名称/编码包含字筛选
  const supplierId = Number(req.query.supplierId ?? 0) || 0;
  const materialKeyword = String(req.query.materialKeyword ?? '').trim();

  const bind: any = { limit: pageSize, offset };
  if (keyword) bind.kw = `%${keyword}%`;
  if (status) bind.status = status;
  if (supplierId) bind.supplierId = supplierId;
  if (materialKeyword) bind.mkw = `%${materialKeyword}%`;

  const cond: string[] = ['1=1'];
  if (keyword) {
    /**
     * 先把「哪些物料命中」一次性查出来（materials 通常只有几千行，扫一遍很快）。
     * 拿不到任何命中时，说明这个关键词跟物料无关（比如只输订单号片段），
     * 这时候整个 EXISTS 分支可以从条件里彻底删掉 —— 压测里这一手让
     * 「订单号片段」场景从 610ms 降到 ~200ms：每行订单少做一次明细表索引查找。
     */
    const hitMaterials = db
      .prepare(`SELECT id FROM materials WHERE name LIKE @kw OR code LIKE @kw`)
      .all({ kw: bind.kw }) as { id: number }[];

    const kwParts = [
      'o.order_no LIKE @kw',
      `IFNULL(o.summary,'') LIKE @kw`,
      `IFNULL(s.name,'') LIKE @kw`,
      `IFNULL(p.name,'') LIKE @kw`,
    ];
    if (hitMaterials.length > 0) {
      // 命中太多时用 IN 列表会把占位符撑爆（SQLite 上限 32766），回退到子查询形式
      if (hitMaterials.length <= 1000) {
        const names = hitMaterials.map((m, i) => {
          const n = `m${i}`;
          bind[n] = m.id;
          return `@${n}`;
        });
        kwParts.push(
          `EXISTS (SELECT 1 FROM purchase_order_items oi
                    WHERE oi.order_id = o.id AND oi.material_id IN (${names.join(',')}))`,
        );
      } else {
        kwParts.push(
          `EXISTS (SELECT 1 FROM purchase_order_items oi
                    WHERE oi.order_id = o.id
                      AND oi.material_id IN (SELECT id FROM materials
                                              WHERE name LIKE @kw OR code LIKE @kw))`,
        );
      }
    }
    cond.push(`(${kwParts.join(' OR ')})`);
  }
  if (status) {
    cond.push('o.status = @status');
  }
  if (supplierId) {
    cond.push('o.supplier_id = @supplierId');
  }
  if (materialKeyword) {
    // 与 keyword 同一套思路：先一次性查出命中的物料 id，再用 EXISTS + IN 直连，
    // 避免写成相关子查询让每行订单都扫一遍明细表。
    const hits = db
      .prepare(`SELECT id FROM materials WHERE name LIKE @mkw OR code LIKE @mkw`)
      .all({ mkw: bind.mkw }) as { id: number }[];

    if (hits.length === 0) {
      // 一个物料都没命中，结果必然为空，直接短路
      cond.push('1=0');
    } else if (hits.length <= 1000) {
      const names = hits.map((m, i) => {
        const n = `mm${i}`;
        bind[n] = m.id;
        return `@${n}`;
      });
      cond.push(
        `EXISTS (SELECT 1 FROM purchase_order_items oi
                  WHERE oi.order_id = o.id AND oi.material_id IN (${names.join(',')}))`,
      );
    } else {
      cond.push(
        `EXISTS (SELECT 1 FROM purchase_order_items oi
                  WHERE oi.order_id = o.id
                    AND oi.material_id IN (SELECT id FROM materials
                                            WHERE name LIKE @mkw OR code LIKE @mkw))`,
      );
    }
  }

  const rows = db
    .prepare(
      `SELECT o.*, s.name AS supplier_name, u.display_name AS creator_name, p.name AS product_name,
              (SELECT COUNT(*) FROM purchase_order_items i WHERE i.order_id = o.id) AS item_count
         FROM purchase_orders o
         LEFT JOIN suppliers s ON s.id = o.supplier_id
         LEFT JOIN users u ON u.id = o.created_by
         LEFT JOIN products p ON p.id = o.product_id
        WHERE ${cond.join(' AND ')}
        ORDER BY o.id DESC
        LIMIT @limit OFFSET @offset`,
    )
    .all(bind) as any[];

  /**
   * 总数：只有「当页被填满」时才可能有下一页，才需要 COUNT。
   * 少于一页时直接用 offset + 已取条数推导，省掉一次全表 COUNT ——
   * 几十万条数据下，这个 COUNT 才是真正吃掉时间的那一下。
   */
  let total = offset + rows.length;
  if (rows.length === pageSize) {
    /**
     * countRows 走位置参数，而上面的条件用的是命名参数，且 @kw 一段里出现了 6 次
     * （单号 / 摘要 / 供应商 / 主产品 / 物料名称 / 物料编码）。
     * 早期写法是「遇到含 @kw 的条件就 push 一个值」，结果 SQL 有 6 个 ? 却只给了 1 个值，
     * 在 30 万条压测里才暴露出来：参数个数不匹配 → 500 Too few parameter values。
     * 这里改成按占位符在 SQL 中出现的先后顺序逐个入参，无论条件怎么改都不会错位。
     */
    const totalParams: any[] = [];
    const totalCond = cond.map((c) =>
      c.replace(/@(\w+)/g, (_m, name: string) => {
        totalParams.push(bind[name]);
        return '?';
      }),
    );
    total = countRows(
      `purchase_orders o
        LEFT JOIN suppliers s ON s.id = o.supplier_id
        LEFT JOIN products p ON p.id = o.product_id`,
      totalCond.join(' AND '),
      totalParams,
    );
  }

  const ctx = req.ctx!;
  const canReceive = ctx.role === 'admin' || ctx.permissions.includes('purchase.receipt.create');
  const canEditOrder = ctx.permissions.includes('purchase.order.update');

  const list = maskList(rows, { canViewPrice: canViewPrice(ctx) }).map((row: any) => {
    // 列表不再暴露父订单号（列已移除）；拆单的父子关系仍由库内 parent_order_no 维护，
    // 只是不作为列表字段输出。
    const { parent_order_no, ...r } = row;
    const isParent = r.item_count === 0;
    // 采购员只能改自己建的，管理员可改全部进行中订单
    const editable =
      canEditOrder &&
      !isParent &&
      r.status === PO_STATUS.ONGOING &&
      (ctx.role === 'admin' || r.created_by === ctx.userId);

    return {
      ...r,
      isParent,
      canReceive: canReceive && !isParent && r.status === PO_STATUS.ONGOING && hasPending(r.id),
      canEdit: editable,
      canDelete: ctx.permissions.includes('purchase.order.delete') && !isParent,
    };
  });

  okList(res, list, total);
});

/** 去入库预填数据：带出订单与待入库明细（需求 4.1） */
purchaseOrderRouter.get('/:id/pending', requirePerm('purchase.receipt.create'), (req, res) => {
  const id = Number(req.params.id);
  const order = db
    .prepare(
      `SELECT o.*, s.name AS supplier_name, p.name AS product_name
         FROM purchase_orders o
         LEFT JOIN suppliers s ON s.id = o.supplier_id
         LEFT JOIN products p ON p.id = o.product_id
        WHERE o.id = ?`,
    )
    .get(id) as any;
  if (!order) throw Err.notFound('采购订单不存在');
  if (order.status !== PO_STATUS.ONGOING) {
    throw Err.conflict('该订单当前状态不可入库');
  }
  ok(res, { order, items: pendingItemsOf(id) });
});

purchaseOrderRouter.get('/:id', requirePerm('purchase.order.view'), (req, res) => {
  const id = Number(req.params.id);
  const order = db
    .prepare(
      `SELECT o.*, s.name AS supplier_name, p.name AS product_name
         FROM purchase_orders o
         LEFT JOIN suppliers s ON s.id = o.supplier_id
         LEFT JOIN products p ON p.id = o.product_id
        WHERE o.id = ?`,
    )
    .get(id) as any;
  if (!order) throw Err.notFound('采购订单不存在');

  const items = db
    .prepare(
      `SELECT i.*, m.code, m.name, m.spec, m.unit
         FROM purchase_order_items i JOIN materials m ON m.id = i.material_id
        WHERE i.order_id = ?`,
    )
    .all(id) as any[];

  ok(res, {
    order: maskList([order], { canViewPrice: canViewPrice(req.ctx!) })[0],
    items: maskList(items, { canViewPrice: canViewPrice(req.ctx!) }),
  });
});

/**
 * 新增采购订单（双模式 + 按默认供应商拆单）。
 * 拆单规则：单个供应商 -> 一条订单；多个供应商 -> 一条父单（无明细，仅汇总）+ N 条子单。
 * 父单不参与入库，避免出现重复入库入口。
 */
purchaseOrderRouter.post('/', requirePerm('purchase.order.create'), (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) throw Err.badRequest(parsed.error.issues[0].message);
  const d = parsed.data;
  const ctx = req.ctx!;

  const result = tx(() => {
    // 去重合并同一物料
    const merged = new Map<number, { qty: number; price: number }>();
    for (const it of d.items) {
      const cur = merged.get(it.materialId);
      if (cur) {
        cur.qty += it.qty;
        if (!cur.price && it.price) cur.price = it.price;
      } else {
        merged.set(it.materialId, { qty: it.qty, price: it.price });
      }
    }

    // 按供应商分组
    const groups = new Map<number | null, { materialId: number; qty: number; price: number }[]>();
    for (const [materialId, v] of merged) {
      const m = db.prepare(`SELECT default_supplier_id FROM materials WHERE id = ?`).get(materialId) as
        | { default_supplier_id: number | null }
        | undefined;
      if (!m) throw Err.badRequest(`物料 #${materialId} 不存在`);
      const supplier = d.supplierId ?? m.default_supplier_id ?? null;
      const arr = groups.get(supplier) ?? [];
      arr.push({ materialId, ...v });
      groups.set(supplier, arr);
    }

    const allNames = materialNames([...merged.keys()]);
    const summary = buildSummary(allNames);
    const created: { id: number; orderNo: string; supplierId: number | null }[] = [];

    const insertOrder = (supplierId: number | null, parentNo: string | null, names: string[]) => {
      const orderNo = nextCode('purchaseOrder', d.orderDate);
      const info = db
        .prepare(
          `INSERT INTO purchase_orders
             (order_no, parent_order_no, supplier_id, order_date, expected_date, created_by,
              status, mode, product_id, plan_qty, bom_version, summary, remark, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          orderNo,
          parentNo,
          supplierId,
          d.orderDate,
          d.expectedDate || null,
          ctx.userId,
          PO_STATUS.ONGOING,
          d.mode,
          d.productId ?? null,
          d.planQty ?? null,
          d.bomVersion ?? null,
          buildSummary(names),
          d.remark,
          nowIso(),
          nowIso(),
        );
      return { id: Number(info.lastInsertRowid), orderNo };
    };

    const insertItems = (orderId: number, items: { materialId: number; qty: number; price: number }[]) => {
      const stmt = db.prepare(
        `INSERT INTO purchase_order_items (order_id, material_id, qty, price, received_qty) VALUES (?,?,?,?,0)`,
      );
      for (const it of items) stmt.run(orderId, it.materialId, it.qty, it.price);
    };

    if (groups.size === 1) {
      const [supplierId, items] = [...groups.entries()][0];
      const o = insertOrder(supplierId, null, materialNames(items.map((i) => i.materialId)));
      insertItems(o.id, items);
      created.push({ ...o, supplierId });
    } else {
      const parent = insertOrder(null, null, allNames);
      for (const [supplierId, items] of groups.entries()) {
        const child = insertOrder(supplierId, parent.orderNo, materialNames(items.map((i) => i.materialId)));
        insertItems(child.id, items);
        created.push({ ...child, supplierId });
      }
      created.unshift({ ...parent, supplierId: null });
    }

    writeLog({
      operatorId: ctx.userId,
      action: '新增采购订单',
      targetType: 'purchase_order',
      targetId: created[0].id,
      detail: { mode: d.mode, summary, children: created.length },
    });

    return { orderNo: created[0].orderNo, orders: created, summary };
  });

  ok(res, result);
});

/** 编辑：仅进行中、未全部入库/未结算/未关闭；采购员限本人，管理员不限（需求 4.4） */
purchaseOrderRouter.put('/:id', requirePerm('purchase.order.update'), (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) throw Err.badRequest(parsed.error.issues[0].message);
  const d = parsed.data;
  const id = Number(req.params.id);
  const ctx = req.ctx!;

  tx(() => {
    const order = db.prepare(`SELECT * FROM purchase_orders WHERE id = ?`).get(id) as any;
    if (!order) throw Err.notFound('采购订单不存在');
    if (order.status !== PO_STATUS.ONGOING) {
      throw Err.conflict('仅进行中的订单可编辑；已入库完成、已结算或已关闭的订单禁止修改');
    }
    if (ctx.role !== 'admin' && order.created_by !== ctx.userId) {
      throw Err.forbidden('仅允许修改本人创建的采购订单');
    }
    const received = db
      .prepare(`SELECT COALESCE(SUM(received_qty),0) AS done FROM purchase_order_items WHERE order_id = ?`)
      .get(id) as { done: number };
    if (Number(received.done) > 0) {
      throw Err.conflict('该订单已发生入库，禁止修改');
    }

    const merged = new Map<number, { qty: number; price: number }>();
    for (const it of d.items) {
      const cur = merged.get(it.materialId);
      if (cur) {
        cur.qty += it.qty;
        if (!cur.price && it.price) cur.price = it.price;
      } else merged.set(it.materialId, { qty: it.qty, price: it.price });
    }

    db.prepare(`DELETE FROM purchase_order_items WHERE order_id = ?`).run(id);
    const stmt = db.prepare(
      `INSERT INTO purchase_order_items (order_id, material_id, qty, price, received_qty) VALUES (?,?,?,?,0)`,
    );
    for (const [materialId, v] of merged) stmt.run(id, materialId, v.qty, v.price);

    db.prepare(
      `UPDATE purchase_orders SET supplier_id=?, order_date=?, expected_date=?, mode=?, product_id=?,
         plan_qty=?, bom_version=?, summary=?, remark=?, updated_at=?
       WHERE id=?`,
    ).run(
      d.supplierId ?? null,
      d.orderDate,
      d.expectedDate || null,
      d.mode,
      d.productId ?? null,
      d.planQty ?? null,
      d.bomVersion ?? null,
      buildSummary(materialNames([...merged.keys()])),
      d.remark,
      nowIso(),
      id,
    );

    refreshOrderStatus(id);
    if (order.parent_order_no) syncParentStatus(order.parent_order_no);

    writeLog({
      operatorId: ctx.userId,
      action: '修改采购订单',
      targetType: 'purchase_order',
      targetId: id,
      detail: { orderNo: order.order_no },
    });
  });

  ok(res, { id });
});

purchaseOrderRouter.delete('/:id', requirePerm('purchase.order.delete'), (req, res) => {
  const id = Number(req.params.id);
  const ctx = req.ctx!;
  tx(() => {
    const order = db.prepare(`SELECT * FROM purchase_orders WHERE id = ?`).get(id) as any;
    if (!order) throw Err.notFound('采购订单不存在');
    if (order.status !== PO_STATUS.ONGOING) throw Err.conflict('仅进行中的订单可删除');
    if (ctx.role !== 'admin' && order.created_by !== ctx.userId) {
      throw Err.forbidden('仅允许删除本人创建的采购订单');
    }
    db.prepare(`DELETE FROM purchase_orders WHERE id = ?`).run(id);
    if (order.parent_order_no) syncParentStatus(order.parent_order_no);
    writeLog({
      operatorId: ctx.userId,
      action: '删除采购订单',
      targetType: 'purchase_order',
      targetId: id,
      detail: { orderNo: order.order_no },
    });
  });
  ok(res, { id });
});

export { refreshOrderStatus };
