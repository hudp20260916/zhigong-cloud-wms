import { Router } from 'express';
import { z } from 'zod';
import { db, nowIso } from '../../db/index.js';
import { Err } from '../../core/errors.js';
import { writeLog } from '../../core/log.js';
import { renderTemplate } from '../../core/template.js';
import { requirePerm } from '../../middleware/auth.js';
import { canViewPrice } from '../../middleware/context.js';
import { ok } from '../../shared/http.js';

export const printRouter = Router();

/**
 * 打印中心。
 *
 * 三个关键取舍：
 *  1. 模板存库（print_templates），管理员可改，改完立即对所有单据生效，不用发版；
 *  2. 渲染只在服务端做 —— 保证「入库单号不出现在打印件」只有一个出口可控；
 *  3. 打印数据里根本不放 receipt_no 字段，模板即使写了 {{receipt_no}} 也是空的，双保险。
 */

// ---------------------------------------------------------------- 单据类型

export interface DocTypeDef {
  docType: string;
  name: string;
  paper: string;
  orientation: string;
  meta: { label: string; key: string }[];
  itemColumns: { title: string; key: string; width?: string; money?: boolean }[];
}

export const DOC_TYPES: DocTypeDef[] = [
  {
    docType: 'purchase_order',
    name: '采购订单',
    paper: 'A4',
    orientation: 'portrait',
    meta: [
      { label: '订单编号', key: 'no' },
      { label: '供应商', key: 'partnerName' },
      { label: '订单日期', key: 'docDate' },
      { label: '采购内容', key: 'summary' },
    ],
    itemColumns: [
      { title: '物料编码', key: 'code' },
      { title: '物料名称', key: 'name' },
      { title: '规格', key: 'spec' },
      { title: '单位', key: 'unit' },
      { title: '数量', key: 'qty' },
      { title: '单价', key: 'price', money: true },
      { title: '金额', key: 'amount', money: true },
    ],
  },
  {
    docType: 'purchase_receipt',
    name: '采购入库单',
    paper: 'A4',
    orientation: 'portrait',
    // 需求 4.5：打印件不得出现入库单号，故只有日期 / 供应商 / 关联订单
    meta: [
      { label: '入库日期', key: 'docDate' },
      { label: '供应商', key: 'partnerName' },
      { label: '关联订单', key: 'refNo' },
      { label: '采购内容', key: 'summary' },
    ],
    itemColumns: [
      { title: '物料编码', key: 'code' },
      { title: '物料名称', key: 'name' },
      { title: '规格', key: 'spec' },
      { title: '单位', key: 'unit' },
      { title: '数量', key: 'qty' },
      { title: '单价', key: 'price', money: true },
      { title: '金额', key: 'amount', money: true },
      { title: '备注', key: 'remark' },
    ],
  },
  {
    docType: 'purchase_return',
    name: '采购退货单',
    paper: 'A4',
    orientation: 'portrait',
    meta: [
      { label: '退货单号', key: 'no' },
      { label: '供应商', key: 'partnerName' },
      { label: '退货日期', key: 'docDate' },
      { label: '退货原因', key: 'remark' },
    ],
    itemColumns: [
      { title: '物料编码', key: 'code' },
      { title: '物料名称', key: 'name' },
      { title: '规格', key: 'spec' },
      { title: '单位', key: 'unit' },
      { title: '数量', key: 'qty' },
      { title: '单价', key: 'price', money: true },
      { title: '金额', key: 'amount', money: true },
    ],
  },
  {
    docType: 'work_order',
    name: '生产工单',
    paper: 'A4',
    orientation: 'portrait',
    meta: [
      { label: '工单号', key: 'no' },
      { label: '产品', key: 'productName' },
      { label: '计划产量', key: 'planQty' },
      { label: '计划开工', key: 'planStart' },
      { label: '计划完工', key: 'planEnd' },
      { label: 'BOM版本', key: 'bomVersion' },
    ],
    itemColumns: [
      { title: '物料编码', key: 'code' },
      { title: '物料名称', key: 'name' },
      { title: '规格', key: 'spec' },
      { title: '单位', key: 'unit' },
      { title: '单耗', key: 'qtyPerUnit' },
      { title: '计划用量', key: 'qty' },
    ],
  },
  {
    docType: 'material_issue',
    name: '生产领料单',
    paper: 'A4',
    orientation: 'portrait',
    meta: [
      { label: '领料单号', key: 'no' },
      { label: '工单号', key: 'refNo' },
      { label: '产品', key: 'productName' },
      { label: '领料日期', key: 'docDate' },
      { label: '生产数量', key: 'produceQty' },
    ],
    itemColumns: [
      { title: '物料编码', key: 'code' },
      { title: '物料名称', key: 'name' },
      { title: '规格', key: 'spec' },
      { title: '单位', key: 'unit' },
      { title: '领用数量', key: 'qty' },
      { title: '单价', key: 'price', money: true },
      { title: '金额', key: 'amount', money: true },
    ],
  },
  {
    docType: 'product_receipt',
    name: '成品入库单',
    paper: 'A4',
    orientation: 'portrait',
    // 同样是入库类：不出现单号
    meta: [
      { label: '入库日期', key: 'docDate' },
      { label: '关联工单', key: 'refNo' },
      { label: '入库类型', key: 'receiptType' },
      { label: '产品', key: 'productName' },
    ],
    itemColumns: [
      { title: '成品编码', key: 'code' },
      { title: '成品名称', key: 'name' },
      { title: '规格', key: 'spec' },
      { title: '单位', key: 'unit' },
      { title: '数量', key: 'qty' },
      { title: '备注', key: 'remark' },
    ],
  },
  {
    docType: 'sale_order',
    name: '销售订单',
    paper: 'A4',
    orientation: 'portrait',
    meta: [
      { label: '订单编号', key: 'no' },
      { label: '客户', key: 'partnerName' },
      { label: '订单日期', key: 'docDate' },
      { label: '备注', key: 'remark' },
    ],
    itemColumns: [
      { title: '成品编码', key: 'code' },
      { title: '成品名称', key: 'name' },
      { title: '规格', key: 'spec' },
      { title: '单位', key: 'unit' },
      { title: '数量', key: 'qty' },
      { title: '单价', key: 'price', money: true },
      { title: '金额', key: 'amount', money: true },
    ],
  },
  {
    docType: 'sale_delivery',
    name: '销售出库单',
    paper: 'A4',
    orientation: 'portrait',
    meta: [
      { label: '出库单号', key: 'no' },
      { label: '客户', key: 'partnerName' },
      { label: '出库日期', key: 'docDate' },
      { label: '关联订单', key: 'refNo' },
    ],
    itemColumns: [
      { title: '成品编码', key: 'code' },
      { title: '成品名称', key: 'name' },
      { title: '规格', key: 'spec' },
      { title: '单位', key: 'unit' },
      { title: '数量', key: 'qty' },
      { title: '单价', key: 'price', money: true },
      { title: '金额', key: 'amount', money: true },
    ],
  },
  {
    docType: 'sale_return',
    name: '销售退货单',
    paper: 'A4',
    orientation: 'portrait',
    meta: [
      { label: '退货单号', key: 'no' },
      { label: '客户', key: 'partnerName' },
      { label: '退货日期', key: 'docDate' },
      { label: '关联订单', key: 'refNo' },
    ],
    itemColumns: [
      { title: '成品编码', key: 'code' },
      { title: '成品名称', key: 'name' },
      { title: '规格', key: 'spec' },
      { title: '单位', key: 'unit' },
      { title: '数量', key: 'qty' },
      { title: '单价', key: 'price', money: true },
      { title: '金额', key: 'amount', money: true },
    ],
  },
];

function docTypeDef(docType: string): DocTypeDef {
  const d = DOC_TYPES.find((x) => x.docType === docType);
  if (!d) throw Err.badRequest(`未知单据类型：${docType}`);
  return d;
}

// ---------------------------------------------------------------- 默认模板

function metaRows(def: DocTypeDef): string {
  const half = Math.ceil(def.meta.length / 2);
  const cell = (m: { label: string; key: string }) =>
    `<div class="meta-item"><span class="meta-label">${m.label}</span><span class="meta-value">{{${m.key}}}</span></div>`;
  const left = def.meta.slice(0, half).map(cell).join('');
  const right = def.meta.slice(half).map(cell).join('');
  return `<div class="meta-grid"><div class="meta-col">${left}</div><div class="meta-col">${right}</div></div>`;
}

function itemTable(def: DocTypeDef): string {
  const hasMoney = def.itemColumns.some((c) => c.money);
  const th = def.itemColumns
    .map((c) => `<th${c.width ? ` style="width:${c.width}"` : ''}>${c.title}</th>`)
    .join('');
  const td = def.itemColumns
    .map((c) => `<td class="${c.money ? 'num' : ''}">{{${c.key}}}</td>`)
    .join('');
  // 表头列数 = 序号(1) + 明细列数。表尾「合计」格必须吃掉剩余列，
  // 总数才与表头对齐；否则表格会凭空多出一列，合计金额被顶出右边框。
  const footCount = hasMoney ? 3 : 1; // 有金额：数量/单价/金额 3 格；无金额：仅数量 1 格
  const span = Math.max(1, def.itemColumns.length + 1 - footCount);
  const footTd = hasMoney ? `<td class="num">{{totalQty}}</td><td></td><td class="num">{{totalAmount}}</td>` : `<td class="num">{{totalQty}}</td>`;
  return `<table class="items">
  <thead><tr><th style="width:40px">序号</th>${th}</tr></thead>
  <tbody>{{#items}}<tr><td class="idx">{{__index}}</td>${td}</tr>{{/items}}</tbody>
  <tfoot><tr><td colspan="${span}">合计</td>${footTd}</tr></tfoot>
</table>`;
}

function defaultContent(def: DocTypeDef): string {
  return `<div class="doc">
  <div class="doc-head">
    <div class="doc-title">{{title}}</div>
    <div class="doc-sub">{{companyName}}</div>
  </div>
  ${metaRows(def)}
  ${itemTable(def)}
  <div class="amount-cn">金额大写：{{amountCn}}</div>
  <div class="doc-foot">
    <div class="sign">制单：{{operatorName}}</div>
    <div class="sign">审核：</div>
    <div class="sign">签收：</div>
    <div class="sign">日期：{{printDate}}</div>
  </div>
</div>`;
}

export const PRINT_CSS = `
* { box-sizing: border-box; }
body { margin: 0; font-family: "Microsoft YaHei", "PingFang SC", sans-serif; color: #1f2328; background: #f5f5f5; }
.page { background: #fff; margin: 0 auto; padding: 14mm 12mm; }
.page.A4.portrait  { width: 210mm; min-height: 297mm; }
.page.A4.landscape { width: 297mm; min-height: 210mm; }
.page.A5.portrait  { width: 148mm; min-height: 210mm; }
.page.A5.landscape { width: 210mm; min-height: 148mm; }
.page.P241.portrait { width: 241mm; min-height: 140mm; padding: 6mm 5mm; }
.doc-title { text-align: center; font-size: 20px; font-weight: 700; letter-spacing: 4px; }
.doc-sub { text-align: center; font-size: 12px; color: #666; margin-top: 4px; }
.doc-head { margin-bottom: 12px; }
.meta-grid { display: flex; gap: 24px; border-top: 1px solid #333; border-bottom: 1px solid #333; padding: 8px 0; margin-bottom: 10px; }
.meta-col { flex: 1; }
.meta-item { display: flex; font-size: 12px; line-height: 22px; }
.meta-label { width: 72px; color: #666; }
.meta-value { font-weight: 600; }
table.items { width: 100%; border-collapse: collapse; font-size: 12px; }
table.items th, table.items td { border: 1px solid #444; padding: 5px 6px; }
table.items th { background: #f0f0f0; text-align: left; }
table.items td.idx { text-align: center; color: #666; }
table.items td.num { text-align: right; font-variant-numeric: tabular-nums; }
table.items tfoot td { font-weight: 700; background: #fafafa; }
.amount-cn { font-size: 12px; margin-top: 8px; }
.doc-foot { display: flex; gap: 40px; margin-top: 28px; font-size: 12px; }
.sign { flex: 1; }
@media print { body { background: #fff; } .page { margin: 0; box-shadow: none; } }
`;

// ---------------------------------------------------------------- 人民币大写

const CN_DIGITS = ['零', '壹', '贰', '叁', '肆', '伍', '陆', '柒', '捌', '玖'];
const CN_UNITS = ['', '拾', '佰', '仟'];
const CN_SECTIONS = ['', '万', '亿', '兆'];

/** 金额转人民币大写，打印件必备 */
export function rmbUpper(amount: number): string {
  const n = Math.round(Math.abs(Number(amount) || 0) * 100);
  if (n === 0) return '零元整';
  const intPart = Math.floor(n / 100);
  const jiao = Math.floor((n % 100) / 10);
  const fen = n % 10;

  let intStr = '';
  let rest = intPart;
  let section = 0;
  if (rest === 0) intStr = '零';
  while (rest > 0) {
    const chunk = rest % 10000;
    let chunkStr = '';
    let zero = false;
    let c = chunk;
    for (let i = 0; i < 4 && c > 0; i++) {
      const d = c % 10;
      if (d === 0) {
        zero = true;
      } else {
        chunkStr = CN_DIGITS[d] + CN_UNITS[i] + (zero ? '零' : '') + chunkStr;
        zero = false;
      }
      c = Math.floor(c / 10);
    }
    chunkStr = chunkStr.replace(/零+$/, '');
    if (chunkStr) intStr = chunkStr + CN_SECTIONS[section] + (intStr && intStr !== '零' ? intStr : '');
    else if (intStr && !intStr.startsWith('零')) intStr = '零' + intStr;
    rest = Math.floor(rest / 10000);
    section++;
  }
  intStr = intStr || '零';

  let decStr = '';
  if (jiao === 0 && fen === 0) decStr = '整';
  else {
    if (jiao > 0) decStr += `${CN_DIGITS[jiao]}角`;
    else if (fen > 0) decStr += '零';
    if (fen > 0) decStr += `${CN_DIGITS[fen]}分`;
  }
  return `${intStr}元${decStr}`;
}

// ---------------------------------------------------------------- 取数

function setting(key: string): string {
  const row = db.prepare(`SELECT value FROM app_settings WHERE key = ?`).get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? '';
}

function companyInfo() {
  return {
    companyName: setting('company.name') || '智工云仓',
    companyPhone: setting('company.phone'),
    companyAddress: setting('company.address'),
  };
}

function round2(n: number): number {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/** 打印数据。注意：入库类单据不返回 receipt_no（需求 4.5，打印件不得出现） */
export function buildPrintData(docType: string, id: number, withPrice: boolean): Record<string, any> {
  const def = docTypeDef(docType);
  const base = {
    ...companyInfo(),
    title: def.name,
    printDate: new Date().toISOString().slice(0, 10),
  };

  const hide = (rows: any[]) =>
    withPrice
      ? rows
      : rows.map((r) => {
          const o = { ...r };
          delete o.price;
          delete o.amount;
          return o;
        });

  let data: Record<string, any>;

  switch (docType) {
    case 'purchase_order': {
      const h = db
        .prepare(
          `SELECT o.*, s.name AS supplier_name FROM purchase_orders o
             LEFT JOIN suppliers s ON s.id = o.supplier_id WHERE o.id = ?`,
        )
        .get(id) as any;
      if (!h) throw Err.notFound('采购订单不存在');
      const items = db
        .prepare(
          `SELECT m.code, m.name, m.spec, m.unit, i.qty, i.price, (i.qty * i.price) AS amount, i.remark
             FROM purchase_order_items i JOIN materials m ON m.id = i.material_id
            WHERE i.order_id = ? ORDER BY i.id`,
        )
        .all(id) as any[];
      data = {
        no: h.order_no,
        partnerName: h.supplier_name ?? '',
        docDate: h.order_date,
        summary: h.summary ?? '',
        remark: h.remark ?? '',
        operatorName: operatorName(h.created_by),
        items: hide(items),
      };
      break;
    }
    case 'purchase_receipt': {
      const h = db
        .prepare(
          `SELECT r.*, s.name AS supplier_name, o.order_no
             FROM purchase_receipts r
             LEFT JOIN suppliers s ON s.id = r.supplier_id
             LEFT JOIN purchase_orders o ON o.id = r.order_id
            WHERE r.id = ?`,
        )
        .get(id) as any;
      if (!h) throw Err.notFound('入库单不存在');
      const items = db
        .prepare(
          `SELECT m.code, m.name, m.spec, m.unit, ri.qty, ri.price, ri.amount,
                  CASE WHEN ri.is_gift = 1 THEN '赠品' ELSE IFNULL(ri.remark,'') END AS remark
             FROM purchase_receipt_items ri JOIN materials m ON m.id = ri.material_id
            WHERE ri.receipt_id = ? ORDER BY ri.id`,
        )
        .all(id) as any[];
      data = {
        // 不输出 receipt_no
        partnerName: h.supplier_name ?? '',
        docDate: h.receipt_date,
        refNo: h.order_no ?? '',
        summary: '',
        remark: h.remark ?? '',
        operatorName: operatorName(h.operator_id),
        items: hide(items),
      };
      break;
    }
    case 'purchase_return': {
      const h = db
        .prepare(
          `SELECT rt.*, s.name AS supplier_name FROM purchase_returns rt
             LEFT JOIN suppliers s ON s.id = rt.supplier_id WHERE rt.id = ?`,
        )
        .get(id) as any;
      if (!h) throw Err.notFound('退货单不存在');
      const items = db
        .prepare(
          `SELECT m.code, m.name, m.spec, m.unit, ri.qty, ri.price, ri.amount, ri.remark
             FROM purchase_return_items ri JOIN materials m ON m.id = ri.material_id
            WHERE ri.return_id = ? ORDER BY ri.id`,
        )
        .all(id) as any[];
      data = {
        no: h.return_no,
        partnerName: h.supplier_name ?? '',
        docDate: h.return_date,
        remark: h.remark ?? '',
        operatorName: operatorName(h.operator_id),
        items: hide(items),
      };
      break;
    }
    case 'work_order': {
      const h = db
        .prepare(
          `SELECT w.*, p.code AS product_code, p.name AS product_name, p.spec
             FROM work_orders w LEFT JOIN products p ON p.id = w.product_id WHERE w.id = ?`,
        )
        .get(id) as any;
      if (!h) throw Err.notFound('工单不存在');
      const items = db
        .prepare(
          `SELECT m.code, m.name, m.spec, m.unit, b.qty_per_unit,
                  (b.qty_per_unit * ?) AS qty
             FROM bom_items b JOIN materials m ON m.id = b.material_id
            WHERE b.product_id = ? ORDER BY m.name`,
        )
        .all(Number(h.plan_qty), h.product_id) as any[];
      data = {
        no: h.wo_no,
        productName: `${h.product_name ?? ''}${h.product_code ? `（${h.product_code}）` : ''}`,
        planQty: Number(h.plan_qty),
        planStart: h.plan_start ?? '',
        planEnd: h.plan_end ?? '',
        bomVersion: h.bom_version ?? '',
        remark: h.remark ?? '',
        operatorName: operatorName(h.created_by),
        items: hide(items),
      };
      break;
    }
    case 'material_issue': {
      const h = db
        .prepare(
          `SELECT mi.*, w.wo_no, p.name AS product_name, p.code AS product_code
             FROM material_issues mi
             LEFT JOIN work_orders w ON w.id = mi.wo_id
             LEFT JOIN products p ON p.id = w.product_id WHERE mi.id = ?`,
        )
        .get(id) as any;
      if (!h) throw Err.notFound('领料单不存在');
      const items = db
        .prepare(
          `SELECT m.code, m.name, m.spec, m.unit, ii.qty, ii.unit_price AS price,
                  (ii.qty * ii.unit_price) AS amount
             FROM material_issue_items ii JOIN materials m ON m.id = ii.material_id
            WHERE ii.issue_id = ? ORDER BY ii.id`,
        )
        .all(id) as any[];
      data = {
        no: h.issue_no,
        refNo: h.wo_no ?? '',
        productName: h.product_name ?? '',
        docDate: h.issue_date,
        produceQty: Number(h.produce_qty),
        remark: h.remark ?? '',
        operatorName: operatorName(h.operator_id),
        items: hide(items),
      };
      break;
    }
    case 'product_receipt': {
      const h = db
        .prepare(
          `SELECT pr.*, w.wo_no FROM product_receipts pr
             LEFT JOIN work_orders w ON w.id = pr.wo_id WHERE pr.id = ?`,
        )
        .get(id) as any;
      if (!h) throw Err.notFound('成品入库单不存在');
      const items = db
        .prepare(
          `SELECT p.code, p.name, p.spec, p.unit, pri.qty, pri.remark
             FROM product_receipt_items pri JOIN products p ON p.id = pri.product_id
            WHERE pri.receipt_id = ? ORDER BY pri.id`,
        )
        .all(id) as any[];
      data = {
        // 不输出 receipt_no
        docDate: h.receipt_date,
        refNo: h.wo_no ?? '',
        receiptType: h.receipt_type ?? '',
        productName: items[0]?.name ?? '',
        remark: h.remark ?? '',
        operatorName: operatorName(h.operator_id),
        items: hide(items),
      };
      break;
    }
    case 'sale_order': {
      const h = db
        .prepare(
          `SELECT o.*, c.name AS customer_name FROM sale_orders o
             LEFT JOIN customers c ON c.id = o.customer_id WHERE o.id = ?`,
        )
        .get(id) as any;
      if (!h) throw Err.notFound('销售订单不存在');
      const items = db
        .prepare(
          `SELECT p.code, p.name, p.spec, p.unit, i.qty, i.price, (i.qty * i.price) AS amount
             FROM sale_order_items i JOIN products p ON p.id = i.product_id
            WHERE i.order_id = ? ORDER BY i.id`,
        )
        .all(id) as any[];
      data = {
        no: h.order_no,
        partnerName: h.customer_name ?? '',
        docDate: h.order_date,
        remark: h.remark ?? '',
        operatorName: operatorName(h.created_by),
        items: hide(items),
      };
      break;
    }
    case 'sale_delivery': {
      const h = db
        .prepare(
          `SELECT d.*, c.name AS customer_name, o.order_no FROM sale_deliveries d
             LEFT JOIN customers c ON c.id = d.customer_id
             LEFT JOIN sale_orders o ON o.id = d.order_id WHERE d.id = ?`,
        )
        .get(id) as any;
      if (!h) throw Err.notFound('出库单不存在');
      const items = db
        .prepare(
          `SELECT p.code, p.name, p.spec, p.unit, i.qty, i.price, (i.qty * i.price) AS amount
             FROM sale_delivery_items i JOIN products p ON p.id = i.product_id
            WHERE i.delivery_id = ? ORDER BY i.id`,
        )
        .all(id) as any[];
      data = {
        no: h.delivery_no,
        partnerName: h.customer_name ?? '',
        docDate: h.delivery_date,
        refNo: h.order_no ?? '',
        remark: h.remark ?? '',
        operatorName: operatorName(h.operator_id),
        items: hide(items),
      };
      break;
    }
    case 'sale_return': {
      const h = db
        .prepare(
          `SELECT r.*, c.name AS customer_name, o.order_no FROM sale_returns r
             LEFT JOIN customers c ON c.id = r.customer_id
             LEFT JOIN sale_orders o ON o.id = r.order_id WHERE r.id = ?`,
        )
        .get(id) as any;
      if (!h) throw Err.notFound('退货单不存在');
      const items = db
        .prepare(
          `SELECT p.code, p.name, p.spec, p.unit, i.qty, i.price, (i.qty * i.price) AS amount
             FROM sale_return_items i JOIN products p ON p.id = i.product_id
            WHERE i.return_id = ? ORDER BY i.id`,
        )
        .all(id) as any[];
      data = {
        no: h.return_no,
        partnerName: h.customer_name ?? '',
        docDate: h.return_date,
        refNo: h.order_no ?? '',
        remark: h.remark ?? '',
        operatorName: operatorName(h.operator_id),
        items: hide(items),
      };
      break;
    }
    default:
      throw Err.badRequest(`未知单据类型：${docType}`);
  }

  const items = (data.items ?? []) as any[];
  const totalQty = round2(items.reduce((s, r) => s + Number(r.qty ?? 0), 0));
  const totalAmount = withPrice
    ? round2(items.reduce((s, r) => s + Number(r.amount ?? 0), 0))
    : 0;

  return {
    ...base,
    ...data,
    totalQty,
    totalAmount,
    amountCn: withPrice ? rmbUpper(totalAmount) : '',
  };
}

function operatorName(userId: number | null | undefined): string {
  if (!userId) return '';
  const r = db.prepare(`SELECT display_name FROM users WHERE id = ?`).get(userId) as
    | { display_name: string }
    | undefined;
  return r?.display_name ?? '';
}

// ---------------------------------------------------------------- 模板持久化

interface StoredTemplate {
  docType: string;
  name: string;
  paper: string;
  orientation: string;
  content: string;
  isCustom: number;
  updatedByName: string | null;
  updatedAt: string | null;
}

function getTemplate(docType: string): StoredTemplate {
  const def = docTypeDef(docType);
  const row = db.prepare(`SELECT * FROM print_templates WHERE doc_type = ?`).get(docType) as any;
  if (row) {
    return {
      docType,
      name: row.name,
      paper: row.paper,
      orientation: row.orientation,
      content: row.content,
      isCustom: Number(row.is_custom ?? 0),
      updatedByName: operatorName(row.updated_by),
      updatedAt: row.updated_at,
    };
  }
  return {
    docType,
    name: def.name,
    paper: def.paper,
    orientation: def.orientation,
    content: defaultContent(def),
    isCustom: 0,
    updatedByName: null,
    updatedAt: null,
  };
}

// ---------------------------------------------------------------- 路由

printRouter.get('/templates', requirePerm('system.print.manage'), (_req, res) => {
  ok(
    res,
    DOC_TYPES.map((d) => {
      const t = getTemplate(d.docType);
      return { ...t, fields: d.meta.map((m) => m.key).concat(d.itemColumns.map((c) => c.key)) };
    }),
  );
});

printRouter.get('/templates/:docType', requirePerm('system.print.manage'), (req, res) => {
  ok(res, getTemplate(String(req.params.docType)));
});

const saveSchema = z.object({
  paper: z.string().trim().min(1),
  orientation: z.enum(['portrait', 'landscape']),
  content: z.string().min(1, '模板内容不能为空'),
});

printRouter.put('/templates/:docType', requirePerm('system.print.manage'), (req, res) => {
  const docType = String(req.params.docType);
  const def = docTypeDef(docType);
  const parsed = saveSchema.safeParse(req.body);
  if (!parsed.success) throw Err.badRequest(parsed.error.issues[0].message);
  const ctx = req.ctx!;

  db.prepare(
    `INSERT INTO print_templates (doc_type, name, paper, orientation, content, is_custom, updated_by, updated_at)
     VALUES (?,?,?,?,?,1,?,?)
     ON CONFLICT(doc_type) DO UPDATE SET
       paper = excluded.paper, orientation = excluded.orientation,
       content = excluded.content, is_custom = 1,
       updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
  ).run(docType, def.name, parsed.data.paper, parsed.data.orientation, parsed.data.content, ctx.userId, nowIso());

  writeLog({
    operatorId: ctx.userId,
    action: '修改打印模板',
    targetType: 'print_template',
    detail: { docType },
  });
  ok(res, getTemplate(docType));
});

printRouter.post('/templates/:docType/reset', requirePerm('system.print.manage'), (req, res) => {
  const docType = String(req.params.docType);
  const def = docTypeDef(docType);
  db.prepare(`DELETE FROM print_templates WHERE doc_type = ?`).run(docType);
  writeLog({
    operatorId: req.ctx!.userId,
    action: '恢复默认打印模板',
    targetType: 'print_template',
    detail: { docType },
  });
  ok(res, getTemplate(docType));
});

/** 渲染完整打印页（新窗口 / iframe 直接加载） */
printRouter.get('/render/:docType/:id', (_req, res) => {
  const docType = String(_req.params.docType);
  const id = Number(_req.params.id);
  const t = getTemplate(docType);
  const data = buildPrintData(docType, id, canViewPrice(_req.ctx!));
  const body = renderTemplate(t.content, data);
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>${t.name}</title><style>${PRINT_CSS}</style></head>
<body><div class="page ${t.paper} ${t.orientation}">${body}</div></body></html>`;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

/** 编辑期实时预览：前端把正在编辑的 content 回传，服务端渲染后返回 HTML */
const previewSchema = z.object({
  docType: z.string().min(1),
  content: z.string().min(1),
  id: z.number().int().positive(),
  paper: z.string().optional(),
  orientation: z.enum(['portrait', 'landscape']).optional(),
});

printRouter.post('/preview', requirePerm('system.print.manage'), (req, res) => {
  const parsed = previewSchema.safeParse(req.body);
  if (!parsed.success) throw Err.badRequest(parsed.error.issues[0].message);
  const d = parsed.data;
  const def = docTypeDef(d.docType);
  const data = buildPrintData(d.docType, d.id, canViewPrice(req.ctx!));
  const body = renderTemplate(d.content, data);
  const paper = d.paper ?? def.paper;
  const orientation = d.orientation ?? def.orientation;
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>${def.name} 预览</title><style>${PRINT_CSS}</style></head>
<body><div class="page ${paper} ${orientation}">${body}</div></body></html>`;
  ok(res, { html });
});

/** 打印可用字段说明，编辑页侧边栏展示 */
printRouter.get('/fields/:docType', requirePerm('system.print.manage'), (req, res) => {
  const def = docTypeDef(String(req.params.docType));
  ok(res, {
    docType: def.docType,
    name: def.name,
    head: def.meta.map((m) => ({ key: m.key, label: m.label })),
    item: def.itemColumns.map((c) => ({ key: c.key, label: c.title })),
    common: [
      { key: 'companyName', label: '公司名称' },
      { key: 'printDate', label: '打印日期' },
      { key: 'totalQty', label: '合计数量' },
      { key: 'totalAmount', label: '合计金额' },
      { key: 'amountCn', label: '金额大写' },
      { key: 'operatorName', label: '制单人' },
      { key: 'items', label: '明细循环（{{#items}}）' },
    ],
  });
});

export { defaultContent, getTemplate };
