/**
 * 012 多仓库迁移校验（直接开库跑，不依赖 HTTP）
 *
 * 重点断言：
 *   1. 预置仓（物料库 / 成品库）存在且为各自品类的默认仓；
 *   2. 回填前后 materials.current_stock / products.current_stock 数值不变；
 *   3. 每个对象「各仓数量之和」== 它的总库存（恒等）；
 *   4. 老流水 / 老单据的 warehouse_id 全部按品类回填，无 NULL；
 *   5. 按仓校验负库存（同名物料在两个仓各自独立扣减）；
 *   6. 迁移幂等（_migrations 去重，不重复应用）。
 *
 * 用法：npx tsx --tsconfig server/tsconfig.json server/scripts/verify-wh-migration.mts
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(here, '..');
process.env.DB_FILE = process.env.DB_FILE ?? path.resolve(serverRoot, 'data/wh-test.db');

const dbFile = process.env.DB_FILE;
for (const suffix of ['', '-wal', '-shm']) {
  const f = `${dbFile}${suffix}`;
  if (fs.existsSync(f)) fs.rmSync(f);
}

const { db, migrate } = await import('../src/db/index.js');
const { seedIfEmpty } = await import('../src/db/seed.js');
const { applyStock, reverseStock } = await import('../src/core/ledger.js');
const { stockOfWarehouse, stockConsistencyIssues, defaultWarehouseOf } = await import(
  '../src/core/warehouse.js'
);

let pass = 0;
const fails: string[] = [];
function ok(cond: boolean, label: string, extra = '') {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${label}`);
  } else {
    fails.push(`${label}${extra ? ' — ' + extra : ''}`);
    console.log(`  ✗ ${label}${extra ? ' — ' + extra : ''}`);
  }
}
function section(t: string) {
  console.log(`\n== ${t} ==`);
}
const snapshot = () => ({
  matTotal: Number((db.prepare(`SELECT COALESCE(SUM(current_stock),0) s FROM materials`).get() as any).s),
  proTotal: Number((db.prepare(`SELECT COALESCE(SUM(current_stock),0) s FROM products`).get() as any).s),
});

console.log(`库文件：${dbFile}`);

migrate();
seedIfEmpty();

// ---------- 1. 仓库档案 ----------
section('仓库档案与表结构');
const whs = db
  .prepare(`SELECT id, code, name, kind, is_default, status FROM warehouses ORDER BY id`)
  .all() as any[];
ok(whs.length >= 2, `预置仓至少 2 个（实际 ${whs.length}）`);
const wl = whs.find((w) => w.code === 'WL');
const cp = whs.find((w) => w.code === 'CP');
ok(!!wl && wl.kind === 'material' && wl.is_default === 1, '物料库：品类=material 且为默认仓');
ok(!!cp && cp.kind === 'product' && cp.is_default === 1, '成品库：品类=product 且为默认仓');
ok(whs.every((w) => w.status === '启用'), '预置仓全部启用');
ok(defaultWarehouseOf('material') === wl?.id, 'defaultWarehouseOf(material) = 物料库');
ok(defaultWarehouseOf('product') === cp?.id, 'defaultWarehouseOf(product) = 成品库');

const tables = db
  .prepare(`SELECT name FROM sqlite_master WHERE type='table'`)
  .all()
  .map((r: any) => r.name as string);
for (const t of ['warehouses', 'stock_warehouse', 'warehouse_transfers', 'warehouse_transfer_items']) {
  ok(tables.includes(t), `表 ${t} 已建立`);
}

const DOC_TABLES = [
  'stock_ledger', 'purchase_receipts', 'purchase_returns', 'sale_deliveries',
  'sale_returns', 'material_issues', 'material_returns', 'product_receipts',
  'material_sales', 'defective_outs', 'stock_checks',
];
for (const t of DOC_TABLES) {
  const cols = db.prepare(`PRAGMA table_info(${t})`).all() as any[];
  ok(cols.some((c) => c.name === 'warehouse_id'), `${t} 有 warehouse_id 列`);
}

// ---------- 2. 种子数据已通过新引擎落分仓库存 ----------
section('种子数据走新引擎');
const seedIssues = stockConsistencyIssues();
ok(seedIssues.length === 0, '演示数据：各仓之和 == 总库存', seedIssues.length ? JSON.stringify(seedIssues.slice(0, 2)) : '');
const seedLedgerNull = db.prepare(`SELECT COUNT(*) c FROM stock_ledger WHERE warehouse_id IS NULL`).get() as any;
ok(Number(seedLedgerNull.c) === 0, `演示流水全部带 warehouse_id（NULL ${seedLedgerNull.c} 条）`);

// ---------- 3. 老库回填 ----------
section('历史数据回填（模拟老库）');
const nowIso = new Date().toISOString();
const matId = Number(
  db.prepare(
    `INSERT INTO materials (code, name, spec, unit, category, current_stock, safety_stock, avg_cost, created_at, updated_at)
     VALUES ('WHT-M1','迁移校验物料A','spec','个','原料',120,10,5,?,?)`,
  ).run(nowIso, nowIso).lastInsertRowid,
);
const proId = Number(
  db.prepare(
    `INSERT INTO products (code, name, spec, unit, current_stock, safety_stock, bom_version, created_at, updated_at)
     VALUES ('WHT-P1','迁移校验成品A','spec','台',30,5,'V1.0',?,?)`,
  ).run(nowIso, nowIso).lastInsertRowid,
);

// 老流水：warehouse_id 留空
db.prepare(
  `INSERT INTO stock_ledger (item_type,item_id,direction,qty,biz_type,biz_id,biz_no,unit_price,amount,balance_after,status,is_reversal,operator_id,created_at)
   VALUES ('material',?,'in',120,'期初库存',NULL,NULL,5,600,120,'有效',0,NULL,?)`,
).run(matId, nowIso);
db.prepare(
  `INSERT INTO stock_ledger (item_type,item_id,direction,qty,biz_type,biz_id,biz_no,unit_price,amount,balance_after,status,is_reversal,operator_id,created_at)
   VALUES ('product',?,'in',30,'期初库存',NULL,NULL,0,0,30,'有效',0,NULL,?)`,
).run(proId, nowIso);
// 老单据
db.prepare(
  `INSERT INTO purchase_receipts (receipt_no,receipt_date,operator_id,status,total_amount,created_at)
   VALUES ('WHT-R1','2026-01-01',NULL,'有效',100,?)`,
).run(nowIso);
db.prepare(
  `INSERT INTO product_receipts (receipt_no,wo_id,receipt_date,receipt_type,status,created_at)
   VALUES ('WHT-PR1',NULL,'2026-01-01','成品入库（直接扣料）','有效',?)`,
).run(nowIso);
// 老盘点单：一张混合（物料+成品）、一张纯物料、一张纯成品
function mkCheck(no: string, items: Array<[string, number]>): number {
  const cid = Number(
    db
      .prepare(
        `INSERT INTO stock_checks (check_no,check_date,status,remark,created_at)
         VALUES (?,?,'已审核','老盘点单',?)`,
      )
      .run(no, '2026-01-01', nowIso).lastInsertRowid,
  );
  for (const [t, iid] of items) {
    db.prepare(
      `INSERT INTO stock_check_items (check_id,item_type,item_id,book_qty,actual_qty,diff_qty)
       VALUES (?,?,?,0,0,0)`,
    ).run(cid, t, iid);
  }
  return cid;
}
const checkMixed = mkCheck('WHT-C1', [
  ['material', matId],
  ['product', proId],
]);
const checkMat = mkCheck('WHT-C2', [['material', matId]]);
const checkPro = mkCheck('WHT-C3', [['product', proId]]);

const before = snapshot();
// 只对新增的旧数据补跑 012 的回填段（DDL 会因 duplicate column 失败，故只取回填部分）
const dbDir = path.join(serverRoot, 'src/db');
const target = fs.readdirSync(dbDir).filter((f) => /^012_.*\.sql$/.test(f)).sort()[0];
if (!target) throw new Error('找不到 012_*.sql');
// 只取「一次性回填历史数据」这一整段（含它的注释行），DDL 段会因 duplicate column 失败
const full012 = fs.readFileSync(path.join(dbDir, target), 'utf8');
const mark = full012.indexOf('-- ---------- 一次性回填历史数据');
const backfill = mark >= 0 ? full012.slice(mark) : '';
if (!backfill) throw new Error('012 里找不到回填段');
db.exec(backfill);
const after = snapshot();

ok(before.matTotal === after.matTotal && before.proTotal === after.proTotal,
  '回填前后总库存完全不变',
  `物料 ${before.matTotal}→${after.matTotal}，成品 ${before.proTotal}→${after.proTotal}`);

const ledgerNull = db.prepare(`SELECT COUNT(*) c FROM stock_ledger WHERE warehouse_id IS NULL`).get() as any;
ok(Number(ledgerNull.c) === 0, `老流水 warehouse_id 全部回填（NULL ${ledgerNull.c} 条）`);
const badMat = db.prepare(
  `SELECT COUNT(*) c FROM stock_ledger l JOIN warehouses w ON w.id=l.warehouse_id
    WHERE l.item_type='material' AND w.kind NOT IN ('material','main')`).get() as any;
ok(Number(badMat.c) === 0, '物料流水只落在物料库/主仓');
const badPro = db.prepare(
  `SELECT COUNT(*) c FROM stock_ledger l JOIN warehouses w ON w.id=l.warehouse_id
    WHERE l.item_type='product' AND w.kind NOT IN ('product','main')`).get() as any;
ok(Number(badPro.c) === 0, '成品流水只落在成品库/主仓');
for (const t of ['purchase_receipts', 'product_receipts']) {
  const r = db.prepare(`SELECT COUNT(*) c FROM ${t} WHERE warehouse_id IS NULL`).get() as any;
  ok(Number(r.c) === 0, `老单据 ${t} warehouse_id 全部回填（NULL ${r.c} 条）`);
}
// 盘点单：单品类按品类回填，混合品类留 NULL（= 各明细按自身品类归默认仓，兼容老混合盘点单）
const chkWh = (id: number) => db.prepare(`SELECT warehouse_id w FROM stock_checks WHERE id=?`).get(id) as any;
ok(Number(chkWh(checkMat).w) === wl.id, '纯物料盘点单 → 回填到物料库');
ok(Number(chkWh(checkPro).w) === cp.id, '纯成品盘点单 → 回填到成品库');
ok(chkWh(checkMixed).w === null, '混合品类盘点单 → 留 NULL（各明细按自身品类归默认仓）');

section('分仓恒等');
const issues = stockConsistencyIssues();
ok(issues.length === 0, '每个对象「各仓之和 == 总库存」', issues.length ? JSON.stringify(issues.slice(0, 3)) : '');
ok(stockOfWarehouse('material', matId, wl.id) === 120, '物料A 在物料库 = 120');
ok(stockOfWarehouse('product', proId, cp.id) === 30, '成品A 在成品库 = 30');
ok(stockOfWarehouse('material', matId, cp.id) === 0, '物料A 在成品库 = 0（无记录视为 0）');

// ---------- 4. 按仓扣减与负库存 ----------
section('按仓扣减 / 负库存校验');
db.prepare(`INSERT INTO warehouses (code,name,kind,is_default,status,remark,created_at,updated_at)
            VALUES ('WL2','物料二库','material',0,'启用','校验用',?,?)`).run(nowIso, nowIso);
const wl2 = Number((db.prepare(`SELECT id FROM warehouses WHERE code='WL2'`).get() as any).id);

applyStock([{ itemType: 'material', itemId: matId, direction: 'in', qty: 50, bizType: '采购入库', unitPrice: 6, warehouseId: wl2 }]);
ok(stockOfWarehouse('material', matId, wl.id) === 120, '往二库入 50 后，物料库仍为 120');
ok(stockOfWarehouse('material', matId, wl2) === 50, '物料二库 = 50');
ok(Number((db.prepare(`SELECT current_stock s FROM materials WHERE id=?`).get(matId) as any).s) === 170,
  '总库存 = 120 + 50 = 170');

let shortageMsg = '';
try {
  applyStock([{ itemType: 'material', itemId: matId, direction: 'out', qty: 60, bizType: '生产领料', warehouseId: wl2 }]);
} catch (e: any) {
  shortageMsg = String(e?.message ?? e);
}
ok(shortageMsg.includes('物料二库') && shortageMsg.includes('库存不足'),
  '二库只有 50 却领 60 → 按仓报「物料二库库存不足」', shortageMsg);

applyStock([{ itemType: 'material', itemId: matId, direction: 'out', qty: 100, bizType: '生产领料', warehouseId: wl.id }]);
ok(stockOfWarehouse('material', matId, wl.id) === 20, '从物料库领 100 → 物料库剩 20');
ok(stockOfWarehouse('material', matId, wl2) === 50, '物料二库不受影响，仍 50');
ok(Number((db.prepare(`SELECT current_stock s FROM materials WHERE id=?`).get(matId) as any).s) === 70,
  '总库存 = 20 + 50 = 70');

// 品类不匹配拦截
let kindMsg = '';
try {
  applyStock([{ itemType: 'product', itemId: proId, direction: 'in', qty: 1, bizType: '成品入库', warehouseId: wl.id }]);
} catch (e: any) {
  kindMsg = String(e?.message ?? e);
}
ok(kindMsg.includes('不能存放'), '成品入物料库 → 品类不匹配被拦截', kindMsg);

// ---------- 5. 撤销回到原仓 ----------
section('撤销回原仓');
const lidBefore = stockOfWarehouse('material', matId, wl2);
applyStock([{ itemType: 'material', itemId: matId, direction: 'in', qty: 10, bizType: '采购入库', bizId: 9001, unitPrice: 6, warehouseId: wl2 }]);
ok(stockOfWarehouse('material', matId, wl2) === lidBefore + 10, '入 10 后二库 = 60');
reverseStock('采购入库', 9001);
ok(stockOfWarehouse('material', matId, wl2) === lidBefore, '撤销后二库回到 50（没有挪到默认仓）');
const revWh = db.prepare(
  `SELECT w.code FROM stock_ledger l JOIN warehouses w ON w.id=l.warehouse_id
    WHERE l.biz_type='撤销-采购入库' AND l.item_id=?`).all(matId) as any[];
ok(revWh.length > 0 && revWh.every((r) => r.code === 'WL2'), '撤销流水也记在 WL2');

// ---------- 6. 幂等 ----------
section('迁移幂等');
let idempotent = true;
try {
  migrate();
} catch {
  idempotent = false;
}
ok(idempotent, '重复执行 migrate() 不报错');
const applied = db.prepare(`SELECT COUNT(*) c FROM _migrations WHERE name = ?`).get(target) as any;
ok(Number(applied.c) === 1, `012 只被应用一次（${applied.c} 次）`);

console.log(`\n通过 ${pass} 项，失败 ${fails.length} 项`);
if (fails.length) {
  for (const f of fails) console.log(`  ✗ ${f}`);
  process.exit(1);
}
