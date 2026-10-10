import { Router } from 'express';
import { z } from 'zod';
import { db, nowIso, tx } from '../../db/index.js';
import { Err } from '../../core/errors.js';
import { writeLog } from '../../core/log.js';
import { requirePerm } from '../../middleware/auth.js';
import { ok } from '../../shared/http.js';

export const initRouter = Router();

/**
 * 系统初始化（清空数据）。
 *
 * 三个必须守住的点：
 *  1. **原子性** —— 整批删表放在一个事务里，中途报错全部回滚，绝不会出现「订单没了但流水还在」；
 *  2. **不重置编号序列** —— 需求 4.8 要求编号持续递增不重置，code_sequences 永不清理，
 *     否则清空后新建单据会产生与历史重复的单号；
 *  3. **二次确认** —— 必须输入「确认清空」四个字，且由服务端校验（前端校验可绕过）。
 *
 * 账号与权限、打印模板、系统参数一律保留：它们属于系统配置而非业务数据。
 */

/** 清空分组：业务单据 / 基础档案 / 全部 */
const GROUP_TABLES: Record<string, { label: string; tables: string[] }> = {
  // 顺序即外键依赖拓扑：先删子表，再删被引用的父表。
  // 例如 purchase_receipts 引用 purchase_orders，所以入库单必须先于订单删除。
  biz: {
    label: '业务单据',
    tables: [
      'settlement_items',
      'supplier_settlements',
      'purchase_receipt_items',
      'purchase_return_items',
      'purchase_returns',
      'purchase_receipts',
      'purchase_order_items',
      'purchase_orders',
      'product_receipt_items',
      'product_receipts',
      'material_issue_items',
      'material_issues',
      'work_orders',
      'sale_delivery_items',
      'sale_deliveries',
      'sale_return_items',
      'sale_returns',
      'sale_order_items',
      'sale_orders',
      'material_sale_items',
      'material_sales',
      'defective_out_items',
      'defective_outs',
      'stock_check_items',
      'stock_checks',
      'simulate_shipment_items',
      'simulate_shipments',
      'import_logs',
      'stock_ledger',
    ],
  },
  archive: {
    label: '基础档案',
    // 顺序：先删引用方，避免外键约束报错
    tables: [
      'bom_items',
      'virtual_bom_items',
      'products',
      'materials',
      'suppliers',
      'customers',
    ],
  },
};

function tablesOf(groups: string[]): string[] {
  const set = new Set<string>();
  for (const g of groups) {
    const def = GROUP_TABLES[g];
    if (!def) throw Err.badRequest(`未知清空范围：${g}`);
    for (const t of def.tables) set.add(t);
  }
  // 「全部」= 业务单据 + 基础档案，且档案必须在单据之后删
  const ordered: string[] = [];
  for (const t of GROUP_TABLES.biz.tables) if (set.has(t)) ordered.push(t);
  for (const t of GROUP_TABLES.archive.tables) if (set.has(t)) ordered.push(t);
  return ordered;
}

function countOf(tables: string[]): { table: string; count: number }[] {
  return tables.map((t) => {
    const row = db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get() as { c: number };
    return { table: t, count: Number(row.c) };
  });
}

/** 预检：返回将被清空的对象数量，供前端展示确认信息 */
initRouter.get('/preview', requirePerm('system.init.execute'), (_req, res) => {
  const biz = countOf(GROUP_TABLES.biz.tables);
  const archive = countOf(GROUP_TABLES.archive.tables);
  ok(res, {
    groups: [
      {
        value: 'biz',
        label: GROUP_TABLES.biz.label,
        total: biz.reduce((s, x) => s + x.count, 0),
        detail: biz.filter((x) => x.count > 0),
      },
      {
        value: 'archive',
        label: GROUP_TABLES.archive.label,
        total: archive.reduce((s, x) => s + x.count, 0),
        detail: archive.filter((x) => x.count > 0),
      },
    ],
    // 明确告知：编号序列与账号不会被清空
    keep: ['单据编号序列（编号持续递增不重置）', '账号与权限', '打印模板', '系统参数', '操作日志'],
  });
});

const initSchema = z.object({
  groups: z.array(z.enum(['biz', 'archive'])).min(1, '请选择清空范围'),
  clearStock: z.boolean().default(false),
  confirmText: z.string().min(1, '请输入确认文字'),
});

initRouter.post('/execute', requirePerm('system.init.execute'), (req, res) => {
  const parsed = initSchema.safeParse(req.body);
  if (!parsed.success) throw Err.badRequest(parsed.error.issues[0].message);
  const d = parsed.data;

  // 服务端强制确认 —— 前端可绕过，这里不可
  if (d.confirmText.trim() !== '确认清空') {
    throw Err.badRequest('确认文字不正确，请输入「确认清空」');
  }

  // 只清档案但业务单据还在：外键会挡住，提前给出可操作的提示而不是 500
  if (d.groups.includes('archive') && !d.groups.includes('biz')) {
    const bizRows = countOf(GROUP_TABLES.biz.tables).reduce((s, x) => s + x.count, 0);
    if (bizRows > 0) {
      throw Err.conflict('业务单据仍存在，档案被引用无法单独清空；请同时勾选「业务单据」');
    }
  }

  const tables = tablesOf(d.groups);
  const ctx = req.ctx!;

  const result = tx(() => {
    let deleted = 0;
    for (const t of tables) {
      deleted += Number(db.prepare(`DELETE FROM ${t}`).run().changes);
    }

    // 库存清零：流水删掉后把余额字段归零，避免残留脏值
    let cleared = 0;
    if (d.clearStock) {
      db.prepare(`UPDATE materials SET current_stock = 0, avg_cost = 0`).run();
      db.prepare(`UPDATE products SET current_stock = 0`).run();
      cleared = 1;
    } else if (d.groups.includes('archive')) {
      // 档案已清空，余额自然也不存在
      cleared = 1;
    }

    writeLog({
      operatorId: ctx.userId,
      action: '系统初始化（清空数据）',
      targetType: 'system',
      detail: { groups: d.groups, clearStock: d.clearStock, deletedRows: deleted },
    });

    return { deletedRows: deleted, cleared };
  });

  ok(res, { ...result, at: nowIso() });
});

export { GROUP_TABLES };
