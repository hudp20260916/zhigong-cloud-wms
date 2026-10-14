/**
 * 真实库升级 012 演练（只读副本，绝不改原库）
 *
 * 目的：确认平哥正在用的 app.db 升级到多仓库版本后：
 *   1. 迁移不报错、不丢数据；
 *   2. 每个对象「各仓数量之和」== 它的总库存（恒等）；
 *   3. 老流水 / 老单据的 warehouse_id 全部按品类回填（盘点单混合品类除外，留 NULL）；
 *   4. 物料只在物料库/主仓、成品只在成品库/主仓。
 *
 * 用法：
 *   cp server/data/app.db* server/data/mig-test.db*   # 先复制（含 -wal/-shm，否则数据不全）
 *   DB_FILE=server/data/mig-test.db npx tsx --tsconfig server/tsconfig.json server/scripts/verify-real-db-upgrade.mts
 */
const { db, migrate } = await import('../src/db/index.js');
const { stockConsistencyIssues } = await import('../src/core/warehouse.js');

let pass = 0;
const fails: string[] = [];
function ok(cond: boolean, label: string, extra = '') {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${label}${extra ? ' — ' + extra : ''}`);
  } else {
    fails.push(`${label}${extra ? ' — ' + extra : ''}`);
    console.log(`  ✗ ${label}${extra ? ' — ' + extra : ''}`);
  }
}

const before = {
  mat: db.prepare(`SELECT COALESCE(SUM(current_stock),0) s FROM materials`).get() as any,
  pro: db.prepare(`SELECT COALESCE(SUM(current_stock),0) s FROM products`).get() as any,
  ledger: db.prepare(`SELECT COUNT(*) c FROM stock_ledger`).get() as any,
};

console.log('\n== 升级前 ==');
console.log(`  物料总库存 ${Number(before.mat.s).toFixed(2)}，成品总库存 ${Number(before.pro.s).toFixed(2)}，流水 ${before.ledger.c} 条`);

migrate();

const after = {
  mat: db.prepare(`SELECT COALESCE(SUM(current_stock),0) s FROM materials`).get() as any,
  pro: db.prepare(`SELECT COALESCE(SUM(current_stock),0) s FROM products`).get() as any,
  ledger: db.prepare(`SELECT COUNT(*) c FROM stock_ledger`).get() as any,
};

console.log('\n== 升级后 ==');
console.log(`  物料总库存 ${Number(after.mat.s).toFixed(2)}，成品总库存 ${Number(after.pro.s).toFixed(2)}，流水 ${after.ledger.c} 条`);

ok(
  Math.abs(Number(before.mat.s) - Number(after.mat.s)) < 1e-6,
  '物料总库存不变',
  `${Number(before.mat.s).toFixed(2)} → ${Number(after.mat.s).toFixed(2)}`,
);
ok(
  Math.abs(Number(before.pro.s) - Number(after.pro.s)) < 1e-6,
  '成品总库存不变',
  `${Number(before.pro.s).toFixed(2)} → ${Number(after.pro.s).toFixed(2)}`,
);
ok(Number(before.ledger.c) === Number(after.ledger.c), '流水条数不变');

console.log('\n== 分仓恒等 ==');
const issues = stockConsistencyIssues();
ok(
  issues.length === 0,
  '每个对象「各仓之和 == 总库存」',
  issues.length ? JSON.stringify(issues.slice(0, 3)) : '',
);

console.log('\n== 回填完整性 ==');
for (const t of [
  'stock_ledger',
  'purchase_receipts',
  'purchase_returns',
  'sale_deliveries',
  'sale_returns',
  'material_issues',
  'material_returns',
  'product_receipts',
  'material_sales',
  'defective_outs',
]) {
  const r = db.prepare(`SELECT COUNT(*) c FROM ${t} WHERE warehouse_id IS NULL`).get() as any;
  ok(Number(r.c) === 0, `${t} 无 NULL（${r.c} 条）`);
}
// 盘点单：混合品类刻意留 NULL（各明细按自身品类归默认仓）
const chkNull = db
  .prepare(
    `SELECT COUNT(*) c FROM stock_checks c WHERE c.warehouse_id IS NULL
       AND EXISTS (SELECT 1 FROM stock_check_items i WHERE i.check_id=c.id AND i.item_type='material')
       AND EXISTS (SELECT 1 FROM stock_check_items i WHERE i.check_id=c.id AND i.item_type='product')`,
  )
  .get() as any;
const chkBad = db
  .prepare(
    `SELECT COUNT(*) c FROM stock_checks c WHERE c.warehouse_id IS NULL
       AND NOT (EXISTS (SELECT 1 FROM stock_check_items i WHERE i.check_id=c.id AND i.item_type='material')
                AND EXISTS (SELECT 1 FROM stock_check_items i WHERE i.check_id=c.id AND i.item_type='product'))`,
  )
  .get() as any;
ok(
  Number(chkBad.c) === 0,
  `盘点单 NULL 的只有混合品类（异常 ${chkBad.c} 条，混合 ${chkNull.c} 条）`,
);

console.log('\n== 品类归仓正确性 ==');
const badMat = db
  .prepare(
    `SELECT COUNT(*) c FROM stock_ledger l JOIN warehouses w ON w.id=l.warehouse_id
      WHERE l.item_type='material' AND w.kind NOT IN ('material','main')`,
  )
  .get() as any;
ok(Number(badMat.c) === 0, '物料流水只落在物料库/主仓');
const badPro = db
  .prepare(
    `SELECT COUNT(*) c FROM stock_ledger l JOIN warehouses w ON w.id=l.warehouse_id
      WHERE l.item_type='product' AND w.kind NOT IN ('product','main')`,
  )
  .get() as any;
ok(Number(badPro.c) === 0, '成品流水只落在成品库/主仓');

const whs = db.prepare(`SELECT code, name, kind FROM warehouses ORDER BY id`).all() as any[];
console.log(`\n  仓库清单：${whs.map((w) => `${w.name}(${w.code}/${w.kind})`).join('、')}`);

console.log(`\n通过 ${pass} 项，失败 ${fails.length} 项`);
if (fails.length) {
  for (const f of fails) console.log(`  ✗ ${f}`);
  process.exit(1);
}
