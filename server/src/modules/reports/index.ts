import { Router } from 'express';
import { DOC_STATUS } from '../../../../shared/enums.js';
import { db } from '../../db/index.js';
import { Err } from '../../core/errors.js';
import { maskList } from '../../core/serializer.js';
import { requirePerm } from '../../middleware/auth.js';
import { canViewPrice } from '../../middleware/context.js';
import { ok } from '../../shared/http.js';

export const reportRouter = Router();

/**
 * 报表中心：元数据驱动。
 *
 * 取舍：不为每个报表写一个页面和一个接口，而是「报表定义（列 + 取数）」集中在后端，
 * 前端只负责渲染 columns/rows 并导出。新增报表 = 往 REPORTS 里加一项，前端零改动。
 * 代价：无法做高度定制化的交互（如钻取），但 V1 阶段报表都是看数，不划算。
 */

export interface ReportColumn {
  title: string;
  key: string;
  width?: number;
  money?: boolean;   // 金额列：无价格权限时脱敏
  align?: 'right';
}

export interface ReportDef {
  kind: string;
  name: string;
  group: string;
  /** groupBy 候选，空数组表示不支持分组 */
  groupBy: { value: string; label: string }[];
  columns: ReportColumn[];
  run(from: string, to: string, groupBy: string): any[];
}

const V = DOC_STATUS.VALID;

/** 日期区间过滤：统一用 substr(created_at,1,10)，避免时区差异 */
function between(col: string, from: string, to: string): { sql: string; params: any[] } {
  if (!from && !to) return { sql: '1=1', params: [] };
  if (from && to) return { sql: `substr(${col},1,10) BETWEEN ? AND ?`, params: [from, to] };
  if (from) return { sql: `substr(${col},1,10) >= ?`, params: [from] };
  return { sql: `substr(${col},1,10) <= ?`, params: [to] };
}

// ---------------------------------------------------------------- 采购报表

const purchaseBySupplier: ReportDef = {
  kind: 'purchase.supplier',
  name: '采购汇总（按供应商）',
  group: '采购',
  groupBy: [],
  columns: [
    { title: '供应商编码', key: 'supplier_code', width: 120 },
    { title: '供应商名称', key: 'supplier_name' },
    { title: '入库单数', key: 'receipt_count', width: 100, align: 'right' },
    { title: '入库金额', key: 'receipt_amount', width: 130, money: true, align: 'right' },
    { title: '退货金额', key: 'return_amount', width: 130, money: true, align: 'right' },
    { title: '净采购额', key: 'net_amount', width: 130, money: true, align: 'right' },
    { title: '已结算', key: 'settled_amount', width: 130, money: true, align: 'right' },
    { title: '应付余额', key: 'payable_amount', width: 130, money: true, align: 'right' },
  ],
  run(from, to) {
    const f = between('r.receipt_date', from, to);
    const g = between('rt.return_date', from, to);
    return db
      .prepare(
        `SELECT s.code AS supplier_code, s.name AS supplier_name,
                (SELECT COUNT(*) FROM purchase_receipts r WHERE r.supplier_id = s.id AND r.status = '${V}' AND ${f.sql}) AS receipt_count,
                (SELECT IFNULL(SUM(total_amount),0) FROM purchase_receipts r WHERE r.supplier_id = s.id AND r.status = '${V}' AND ${f.sql}) AS receipt_amount,
                (SELECT IFNULL(SUM(total_amount),0) FROM purchase_returns rt WHERE rt.supplier_id = s.id AND rt.status = '${V}' AND ${g.sql}) AS return_amount,
                (SELECT IFNULL(SUM(settled_amount),0) FROM purchase_receipts r WHERE r.supplier_id = s.id AND r.status = '${V}') AS settled_amount
           FROM suppliers s
          ORDER BY s.name COLLATE NOCASE ASC`,
      )
      .all(...f.params, ...g.params, ...f.params) as any[];
  },
};

const purchaseByMaterial: ReportDef = {
  kind: 'purchase.material',
  name: '采购汇总（按物料）',
  group: '采购',
  groupBy: [],
  columns: [
    { title: '物料编码', key: 'material_code', width: 120 },
    { title: '物料名称', key: 'material_name' },
    { title: '规格', key: 'spec', width: 140 },
    { title: '单位', key: 'unit', width: 70 },
    { title: '入库数量', key: 'qty', width: 110, align: 'right' },
    { title: '入库金额', key: 'amount', width: 130, money: true, align: 'right' },
    { title: '加权均价', key: 'avg_price', width: 110, money: true, align: 'right' },
    { title: '退货数量', key: 'return_qty', width: 110, align: 'right' },
  ],
  run(from, to) {
    const f = between('r.receipt_date', from, to);
    const g = between('rt.return_date', from, to);
    return db
      .prepare(
        `SELECT m.code AS material_code, m.name AS material_name, m.spec, m.unit,
                (SELECT IFNULL(SUM(ri.qty),0) FROM purchase_receipt_items ri
                   JOIN purchase_receipts r ON r.id = ri.receipt_id
                  WHERE ri.material_id = m.id AND r.status = '${V}' AND ${f.sql}) AS qty,
                (SELECT IFNULL(SUM(ri.amount),0) FROM purchase_receipt_items ri
                   JOIN purchase_receipts r ON r.id = ri.receipt_id
                  WHERE ri.material_id = m.id AND r.status = '${V}' AND ${f.sql}) AS amount,
                (SELECT IFNULL(SUM(rti.qty),0) FROM purchase_return_items rti
                   JOIN purchase_returns rt ON rt.id = rti.return_id
                  WHERE rti.material_id = m.id AND rt.status = '${V}' AND ${g.sql}) AS return_qty
           FROM materials m
          WHERE m.is_virtual = 0
          ORDER BY m.name COLLATE NOCASE ASC`,
      )
      .all(...f.params, ...f.params, ...g.params) as any[];
  },
};

const purchaseDetail: ReportDef = {
  kind: 'purchase.detail',
  name: '采购入库明细',
  group: '采购',
  groupBy: [],
  columns: [
    { title: '入库日期', key: 'receipt_date', width: 110 },
    { title: '供应商', key: 'supplier_name' },
    { title: '物料编码', key: 'material_code', width: 120 },
    { title: '物料名称', key: 'material_name' },
    { title: '数量', key: 'qty', width: 90, align: 'right' },
    { title: '单价', key: 'price', width: 100, money: true, align: 'right' },
    { title: '金额', key: 'amount', width: 120, money: true, align: 'right' },
    { title: '赠品', key: 'is_gift', width: 70 },
    { title: '超量', key: 'over_qty', width: 70 },
  ],
  run(from, to) {
    const f = between('r.receipt_date', from, to);
    return db
      .prepare(
        `SELECT r.receipt_date, IFNULL(s.name,'') AS supplier_name,
                m.code AS material_code, m.name AS material_name, m.spec,
                ri.qty, ri.price, ri.amount,
                CASE ri.is_gift WHEN 1 THEN '是' ELSE '' END AS is_gift,
                CASE ri.over_qty WHEN 1 THEN '是' ELSE '' END AS over_qty
           FROM purchase_receipt_items ri
           JOIN purchase_receipts r ON r.id = ri.receipt_id
           JOIN materials m ON m.id = ri.material_id
           LEFT JOIN suppliers s ON s.id = r.supplier_id
          WHERE r.status = '${V}' AND ${f.sql}
          ORDER BY r.receipt_date DESC, r.id DESC, ri.id ASC`,
      )
      .all(...f.params) as any[];
  },
};

// ---------------------------------------------------------------- 生产报表

const productionWo: ReportDef = {
  kind: 'production.wo',
  name: '生产工单汇总',
  group: '生产',
  groupBy: [],
  columns: [
    { title: '工单号', key: 'wo_no', width: 160 },
    { title: '产品编码', key: 'product_code', width: 120 },
    { title: '产品名称', key: 'product_name' },
    { title: '计划数', key: 'plan_qty', width: 100, align: 'right' },
    { title: '已入库', key: 'received_qty', width: 100, align: 'right' },
    { title: '完成率', key: 'rate', width: 100, align: 'right' },
    { title: '已领料', key: 'issued', width: 90 },
    { title: '状态', key: 'status', width: 90 },
  ],
  run(from, to) {
    const f = between('w.created_at', from, to);
    return db
      .prepare(
        `SELECT w.wo_no, p.code AS product_code, p.name AS product_name,
                w.plan_qty, w.received_qty, w.issued_qty, w.status,
                CASE WHEN w.plan_qty > 0 THEN ROUND(w.received_qty * 100.0 / w.plan_qty, 1) ELSE 0 END AS rate,
                CASE WHEN w.issued_qty > 0 THEN '是' ELSE '否' END AS issued
           FROM work_orders w
           LEFT JOIN products p ON p.id = w.product_id
          WHERE ${f.sql}
          ORDER BY w.id DESC`,
      )
      .all(...f.params) as any[];
  },
};

const productionIssue: ReportDef = {
  kind: 'production.issue',
  name: '领料汇总（按物料）',
  group: '生产',
  groupBy: [],
  columns: [
    { title: '物料编码', key: 'material_code', width: 120 },
    { title: '物料名称', key: 'material_name' },
    { title: '单位', key: 'unit', width: 70 },
    { title: '领用数量', key: 'qty', width: 110, align: 'right' },
    { title: '领用金额', key: 'amount', width: 130, money: true, align: 'right' },
    { title: '领料次数', key: 'times', width: 100, align: 'right' },
  ],
  run(from, to) {
    const f = between('mi.created_at', from, to);
    return db
      .prepare(
        `SELECT m.code AS material_code, m.name AS material_name, m.unit,
                IFNULL(SUM(ii.qty), 0) AS qty,
                IFNULL(SUM(ii.qty * IFNULL(ii.unit_price,0)), 0) AS amount,
                COUNT(DISTINCT ii.issue_id) AS times
           FROM material_issue_items ii
           JOIN material_issues mi ON mi.id = ii.issue_id
           JOIN materials m ON m.id = ii.material_id
          WHERE ${f.sql}
          GROUP BY m.id
          ORDER BY m.name COLLATE NOCASE ASC`,
      )
      .all(...f.params) as any[];
  },
};

// ---------------------------------------------------------------- 销售报表

const saleByCustomer: ReportDef = {
  kind: 'sale.customer',
  name: '销售汇总（按客户）',
  group: '销售',
  groupBy: [],
  columns: [
    { title: '客户编码', key: 'customer_code', width: 120 },
    { title: '客户名称', key: 'customer_name' },
    { title: '订单数', key: 'order_count', width: 90, align: 'right' },
    { title: '订单金额', key: 'order_amount', width: 130, money: true, align: 'right' },
    { title: '出库金额', key: 'delivery_amount', width: 130, money: true, align: 'right' },
    { title: '退货金额', key: 'return_amount', width: 130, money: true, align: 'right' },
    { title: '净销售额', key: 'net_amount', width: 130, money: true, align: 'right' },
  ],
  run(from, to) {
    const f = between('o.order_date', from, to);
    const g = between('d.delivery_date', from, to);
    const h = between('sr.return_date', from, to);
    return db
      .prepare(
        `SELECT c.code AS customer_code, c.name AS customer_name,
                (SELECT COUNT(*) FROM sale_orders o WHERE o.customer_id = c.id AND ${f.sql}) AS order_count,
                (SELECT IFNULL(SUM(o.total_amount),0) FROM sale_orders o WHERE o.customer_id = c.id AND ${f.sql}) AS order_amount,
                (SELECT IFNULL(SUM(d.total_amount),0) FROM sale_deliveries d WHERE d.customer_id = c.id AND d.status = '${V}' AND ${g.sql}) AS delivery_amount,
                (SELECT IFNULL(SUM(sr.total_amount),0) FROM sale_returns sr WHERE sr.customer_id = c.id AND sr.status = '${V}' AND ${h.sql}) AS return_amount
           FROM customers c
          ORDER BY c.name COLLATE NOCASE ASC`,
      )
      .all(...f.params, ...f.params, ...g.params, ...h.params) as any[];
  },
};

const saleByProduct: ReportDef = {
  kind: 'sale.product',
  name: '销售汇总（按成品）',
  group: '销售',
  groupBy: [],
  columns: [
    { title: '成品编码', key: 'product_code', width: 120 },
    { title: '成品名称', key: 'product_name' },
    { title: '单位', key: 'unit', width: 70 },
    { title: '出库数量', key: 'qty', width: 110, align: 'right' },
    { title: '出库金额', key: 'amount', width: 130, money: true, align: 'right' },
    { title: '退货数量', key: 'return_qty', width: 110, align: 'right' },
  ],
  run(from, to) {
    const g = between('d.delivery_date', from, to);
    const h = between('sr.return_date', from, to);
    return db
      .prepare(
        `SELECT p.code AS product_code, p.name AS product_name, p.unit,
                (SELECT IFNULL(SUM(di.qty),0) FROM sale_delivery_items di
                   JOIN sale_deliveries d ON d.id = di.delivery_id
                  WHERE di.product_id = p.id AND d.status = '${V}' AND ${g.sql}) AS qty,
                (SELECT IFNULL(SUM(di.qty * di.price),0) FROM sale_delivery_items di
                   JOIN sale_deliveries d ON d.id = di.delivery_id
                  WHERE di.product_id = p.id AND d.status = '${V}' AND ${g.sql}) AS amount,
                (SELECT IFNULL(SUM(sri.qty),0) FROM sale_return_items sri
                   JOIN sale_returns sr ON sr.id = sri.return_id
                  WHERE sri.product_id = p.id AND sr.status = '${V}' AND ${h.sql}) AS return_qty
           FROM products p
          ORDER BY p.name COLLATE NOCASE ASC`,
      )
      .all(...g.params, ...g.params, ...h.params) as any[];
  },
};

// ---------------------------------------------------------------- 库存报表

/** 收发存汇总：期初 / 期间入 / 期间出 / 期末，全部来自库存流水（唯一事实来源） */
const stockIo: ReportDef = {
  kind: 'stock.io',
  name: '收发存汇总',
  group: '库存',
  groupBy: [],
  columns: [
    { title: '编码', key: 'item_code', width: 120 },
    { title: '名称', key: 'item_name' },
    { title: '类型', key: 'item_type', width: 70 },
    { title: '单位', key: 'unit', width: 70 },
    { title: '期初', key: 'open_qty', width: 100, align: 'right' },
    { title: '期间入库', key: 'in_qty', width: 100, align: 'right' },
    { title: '期间出库', key: 'out_qty', width: 100, align: 'right' },
    { title: '期末', key: 'close_qty', width: 100, align: 'right' },
    { title: '期末金额', key: 'close_amount', width: 130, money: true, align: 'right' },
  ],
  run(from, to) {
    const items: any[] = [
      ...(db
        .prepare(`SELECT id, code, name, unit, current_stock, avg_cost FROM materials WHERE is_virtual = 0`)
        .all() as any[]).map((m) => ({ ...m, itemType: 'material' })),
      ...(db.prepare(`SELECT id, code, name, unit, current_stock FROM products`).all() as any[]).map(
        (p) => ({ ...p, itemType: 'product', avg_cost: 0 }),
      ),
    ];

    // 区间过滤用 created_at（流水只记录发生时刻，与业务单据日期可能有一天偏差）
    // 用命名参数，避免 12 个 ? 的位置对错位
    const q = db.prepare(
      `SELECT
         (SELECT IFNULL(SUM(CASE WHEN direction='in' THEN qty ELSE -qty END), 0) FROM stock_ledger l
           WHERE l.item_type = @t AND l.item_id = @id AND l.status = '${V}'
             AND (@from = '' OR substr(l.created_at,1,10) < @from)) AS open_qty,
         (SELECT IFNULL(SUM(qty), 0) FROM stock_ledger l
           WHERE l.item_type = @t AND l.item_id = @id AND l.status = '${V}' AND direction='in'
             AND (@hasRange = 0 OR substr(l.created_at,1,10) BETWEEN @lo AND @hi)) AS in_qty,
         (SELECT IFNULL(SUM(qty), 0) FROM stock_ledger l
           WHERE l.item_type = @t AND l.item_id = @id AND l.status = '${V}' AND direction='out'
             AND (@hasRange = 0 OR substr(l.created_at,1,10) BETWEEN @lo AND @hi)) AS out_qty`,
    );
    const hasRange = from || to ? 1 : 0;
    const lo = from || '0000-01-01';
    const hi = to || '9999-12-31';

    return items.map((it) => {
      const r = q.get({ t: it.itemType, id: it.id, from, hasRange, lo, hi }) as any;
      const close = Number(r.open_qty) + Number(r.in_qty) - Number(r.out_qty);
      return {
        item_code: it.code,
        item_name: it.name,
        item_type: it.itemType === 'material' ? '物料' : '成品',
        unit: it.unit,
        open_qty: Number(r.open_qty),
        in_qty: Number(r.in_qty),
        out_qty: Number(r.out_qty),
        close_qty: close,
        close_amount: Math.round(close * Number(it.avg_cost ?? 0) * 100) / 100,
      };
    });
  },
};

const stockValue: ReportDef = {
  kind: 'stock.value',
  name: '库存金额明细',
  group: '库存',
  groupBy: [],
  columns: [
    { title: '编码', key: 'item_code', width: 120 },
    { title: '名称', key: 'item_name' },
    { title: '类型', key: 'item_type', width: 70 },
    { title: '库存数量', key: 'qty', width: 110, align: 'right' },
    { title: '单价/成本', key: 'price', width: 120, money: true, align: 'right' },
    { title: '库存金额', key: 'amount', width: 130, money: true, align: 'right' },
    { title: '安全库存', key: 'safety_stock', width: 100, align: 'right' },
    { title: '状态', key: 'flag', width: 90 },
  ],
  run() {
    const rows: any[] = [
      ...(db
        .prepare(
          `SELECT code, name, unit, current_stock, avg_cost, safety_stock FROM materials WHERE is_virtual = 0`,
        )
        .all() as any[]).map((m) => ({ ...m, itemType: '物料' })),
      ...(db
        .prepare(`SELECT code, name, unit, current_stock, safety_stock FROM products`)
        .all() as any[]).map((p) => ({ ...p, itemType: '成品', avg_cost: 0 })),
    ];
    return rows
      .map((r) => {
        const qty = Number(r.current_stock ?? 0);
        const price = Number(r.avg_cost ?? 0);
        const safety = Number(r.safety_stock ?? 0);
        return {
          item_code: r.code,
          item_name: r.name,
          item_type: r.itemType,
          qty,
          price,
          amount: Math.round(qty * price * 100) / 100,
          safety_stock: safety,
          flag: safety > 0 && qty < safety ? '低于安全库存' : '',
        };
      })
      .sort((a, b) => b.amount - a.amount);
  },
};

// ---------------------------------------------------------------- 注册表

export const REPORTS: ReportDef[] = [
  purchaseBySupplier,
  purchaseByMaterial,
  purchaseDetail,
  productionWo,
  productionIssue,
  saleByCustomer,
  saleByProduct,
  stockIo,
  stockValue,
];

function findReport(kind: string): ReportDef {
  const r = REPORTS.find((x) => x.kind === kind);
  if (!r) throw Err.badRequest(`未知报表类型：${kind}`);
  return r;
}

/** 报表清单：前端下拉直接用 */
reportRouter.get('/meta', requirePerm('report.view'), (_req, res) => {
  ok(
    res,
    REPORTS.map((r) => ({
      kind: r.kind,
      name: r.name,
      group: r.group,
      groupBy: r.groupBy,
      columns: r.columns,
    })),
  );
});

reportRouter.get('/data', requirePerm('report.view'), (req, res) => {
  const kind = String(req.query.kind ?? '');
  const from = String(req.query.from ?? '').trim();
  const to = String(req.query.to ?? '').trim();
  const groupBy = String(req.query.groupBy ?? '').trim();

  const def = findReport(kind);
  const rows = def.run(from, to, groupBy);

  const ctx = req.ctx!;
  const can = canViewPrice(ctx);

  // 无价格权限：金额列整体剔除（与导出规则一致），而不是填 ***
  const data = can
    ? maskList(rows, { canViewPrice: true })
    : (() => {
        const moneyKeys = def.columns.filter((c) => c.money).map((c) => c.key);
        return maskList(rows, { canViewPrice: true }).map((r: any) => {
          const out = { ...r };
          for (const k of moneyKeys) delete out[k];
          return out;
        });
      })();

  ok(res, {
    columns: can ? def.columns : def.columns.filter((c) => !c.money),
    rows: data,
    meta: { kind: def.kind, name: def.name, from, to },
  });
});
