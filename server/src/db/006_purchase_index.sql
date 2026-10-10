-- 采购订单列表的查询索引（面向几十万条量级）
--
-- 说明：关键词是「包含匹配」(LIKE '%kw%')，这类匹配本身用不上 B-Tree 索引，
-- 所以这里的思路不是给关键词建索引，而是：
--   1. 让「有选择性」的筛选条件（状态、日期、供应商）走索引，先把候选集缩小；
--   2. 明细表建 (order_id) 索引，让 EXISTS 子查询按 order_id 直达，不做明细全表扫；
--   3. 主查询 ORDER BY id DESC + LIMIT，SQLite 可以沿主键倒序扫并在凑满一页后提前停下，
--      所以翻页成本只跟「扫到第 N 条命中」有关，而不是全表。

CREATE INDEX IF NOT EXISTS idx_po_status      ON purchase_orders (status);
CREATE INDEX IF NOT EXISTS idx_po_order_date  ON purchase_orders (order_date);
CREATE INDEX IF NOT EXISTS idx_po_supplier    ON purchase_orders (supplier_id);
CREATE INDEX IF NOT EXISTS idx_po_status_date ON purchase_orders (status, order_date);

-- 明细：按订单取行（列表 item_count / EXISTS 子查都走它）
CREATE INDEX IF NOT EXISTS idx_poi_order      ON purchase_order_items (order_id);
CREATE INDEX IF NOT EXISTS idx_poi_material   ON purchase_order_items (material_id);
