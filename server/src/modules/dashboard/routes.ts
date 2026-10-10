import { Router } from 'express';
import { db, todayStr } from '../../db/index.js';
import { alertConfig } from '../system/settings.js';
import { maskList } from '../../core/serializer.js';
import { requireAuth } from '../../middleware/auth.js';
import { canViewPrice } from '../../middleware/context.js';
import { ok } from '../../shared/http.js';

export const dashboardRouter = Router();

/** 工作台大屏：指标卡 + 待办聚合 + 今日流水 + 近 7 日趋势 + 告警 Top */
dashboardRouter.get('/summary', requireAuth, (req, res) => {
  const today = todayStr();
  const one = (sql: string, ...p: any[]) => db.prepare(sql).get(...p) as any;
  const can = canViewPrice(req.ctx!);

  const metrics = {
    materialKinds: one(`SELECT COUNT(*) AS c FROM materials`).c,
    productStock: one(`SELECT COALESCE(SUM(current_stock),0) AS s FROM products`).s,
    materialStock: one(`SELECT COALESCE(SUM(current_stock),0) AS s FROM materials`).s,
    alarmMaterials: one(
      `SELECT COUNT(*) AS c FROM materials WHERE current_stock < safety_stock AND safety_stock > 0`,
    ).c,
    // 库存金额只有物料有移动加权成本，成品成本需要分摊，V1 只统计物料
    materialStockAmount: Math.round(
      Number(
        one(`SELECT COALESCE(SUM(current_stock * avg_cost),0) AS s FROM materials WHERE is_virtual = 0`).s,
      ) * 100,
    ) / 100,
    todayIn: one(
      `SELECT COUNT(*) AS c FROM stock_ledger WHERE direction='in' AND status='有效' AND is_reversal=0 AND substr(created_at,1,10)=?`,
      today,
    ).c,
    todayOut: one(
      `SELECT COUNT(*) AS c FROM stock_ledger WHERE direction='out' AND status='有效' AND is_reversal=0 AND substr(created_at,1,10)=?`,
      today,
    ).c,
    monthPurchaseAmount: Math.round(
      Number(
        one(
          `SELECT COALESCE(SUM(total_amount),0) AS s FROM purchase_receipts
            WHERE status='有效' AND substr(receipt_date,1,7) = ?`,
          today.slice(0, 7),
        ).s,
      ) * 100,
    ) / 100,
    monthSaleAmount: Math.round(
      Number(
        one(
          `SELECT COALESCE(SUM(total_amount),0) AS s FROM sale_deliveries
            WHERE status='有效' AND substr(delivery_date,1,7) = ?`,
          today.slice(0, 7),
        ).s,
      ) * 100,
    ) / 100,
  };

  const todo = {
    pendingPurchase: one(`SELECT COUNT(*) AS c FROM purchase_orders WHERE status = '进行中'`).c,
    pendingReceipt: one(
      `SELECT COUNT(*) AS c FROM purchase_orders o
        WHERE o.status = '进行中'
          AND EXISTS (SELECT 1 FROM purchase_order_items i
                       WHERE i.order_id = o.id AND i.received_qty < i.qty)`,
    ).c,
    pendingSale: one(`SELECT COUNT(*) AS c FROM sale_orders WHERE status = '待出库'`).c,
    pendingCheck: one(`SELECT COUNT(*) AS c FROM stock_checks WHERE status = '待审核'`).c,
    // 待结算：仍有未核销金额的入库单张数
    pendingSettle: one(
      `SELECT COUNT(*) AS c FROM purchase_receipts
        WHERE status = '有效' AND total_amount - settled_amount > 0.005`,
    ).c,
  };

  const todayFlow = db
    .prepare(
      `SELECT l.*, CASE WHEN l.item_type = 'material'
                        THEN (SELECT name FROM materials m WHERE m.id = l.item_id)
                        ELSE (SELECT name FROM products p WHERE p.id = l.item_id) END AS item_name
         FROM stock_ledger l
        WHERE l.created_at >= ? AND l.created_at <= ?
        ORDER BY l.created_at DESC LIMIT 20`,
    )
    .all(`${today}T00:00:00.000Z`, `${today}T23:59:59.999Z`) as any[];

  // 趋势：补齐 7 天，缺失日期补 0，避免前端折线/柱状图出现断档
  const rows = db
    .prepare(
      `SELECT substr(created_at, 1, 10) AS day,
              SUM(CASE WHEN biz_type = '采购入库' THEN qty ELSE 0 END) AS purchaseIn,
              SUM(CASE WHEN biz_type = '成品入库' THEN qty ELSE 0 END) AS produceIn,
              SUM(CASE WHEN biz_type = '销售出库' THEN qty ELSE 0 END) AS saleOut
         FROM stock_ledger
        WHERE created_at >= date('now', '-6 days')
          AND status = '有效' AND is_reversal = 0
        GROUP BY day ORDER BY day`,
    )
    .all() as any[];

  const byDay = new Map(rows.map((r) => [r.day, r]));
  const trend: any[] = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const hit = byDay.get(key);
    trend.push({
      day: key,
      label: `${Number(key.slice(5, 7))}/${Number(key.slice(8, 10))}`,
      purchaseIn: Number(hit?.purchaseIn ?? 0),
      produceIn: Number(hit?.produceIn ?? 0),
      saleOut: Number(hit?.saleOut ?? 0),
    });
  }

  // 告警 Top5：阈值取自系统参数，与预警看板口径一致
  const cfg = alertConfig();
  const alarmTop = db
    .prepare(
      `SELECT id, code, name, unit, current_stock, safety_stock
         FROM materials
        WHERE safety_stock > 0 AND current_stock < safety_stock * ?
        ORDER BY (CAST(current_stock AS REAL) / safety_stock) ASC
        LIMIT 5`,
    )
    .all(cfg.safetyRatio) as any[];

  ok(res, {
    metrics,
    todo,
    todayFlow: maskList(todayFlow, { canViewPrice: can }),
    trend,
    alarmTop,
    canViewPrice: can,
  });
});
