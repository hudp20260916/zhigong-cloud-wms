/**
 * 采购订单「几十万条记录不乱」性能压测脚本。
 *
 * 三个子命令：
 *   node server/scripts/perf-purchase-order.mjs seed  [N]   # 复制现有库并灌入 N 条订单（默认 300000）
 *   node server/scripts/perf-purchase-order.mjs bench       # 对已启动的服务打列表接口，输出耗时
 *   node server/scripts/perf-purchase-order.mjs clean       # 删除压测库
 *
 * seed 用 VACUUM INTO 复制一份干净副本到 server/data/perf.db，
 * 绝不动 app.db；perf 服务用 DB_FILE 指向副本启动，测完直接删掉。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '../..');
const dataDir = path.join(rootDir, 'server/data');
const liveDb = path.join(dataDir, 'app.db');
const perfDb = path.join(dataDir, 'perf.db');

const BASE = process.env.API_BASE ?? 'http://127.0.0.1:3099/api';
const cmd = process.argv[2] ?? 'bench';
const N = Number(process.argv[3] ?? 300000);

const pad = (n, w) => String(n).padStart(w, '0');
const ms = (n) => `${n.toFixed(1)}ms`;

/* ------------------------------------------------------------------ seed */

function seed() {
  if (fs.existsSync(perfDb)) fs.rmSync(perfDb, { force: true });
  for (const suffix of ['-wal', '-shm']) {
    if (fs.existsSync(perfDb + suffix)) fs.rmSync(perfDb + suffix, { force: true });
  }

  // 用 VACUUM INTO 复制：绕过 WAL 三文件同步问题，产出一个自包含单文件
  const live = new Database(liveDb, { readonly: true });
  live.exec(`VACUUM INTO '${perfDb.replace(/\\/g, '/')}'`);
  live.close();

  const db = new Database(perfDb);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = OFF'); // 仅压测灌数据阶段用，压完即弃

  const mats = db.prepare(`SELECT id, name FROM materials ORDER BY id LIMIT 12`).all();
  const sup = db.prepare(`SELECT id FROM suppliers ORDER BY id LIMIT 8`).all();
  const usr = db.prepare(`SELECT id FROM users ORDER BY id LIMIT 1`).all();
  const prod = db.prepare(`SELECT id FROM products ORDER BY id LIMIT 5`).all();

  if (!mats.length || !sup.length || !usr.length) {
    throw new Error('基础档案为空，请先运行 npm run db:reset 灌入种子数据');
  }

  const insOrder = db.prepare(`
    INSERT INTO purchase_orders
      (order_no, parent_order_no, supplier_id, order_date, expected_date, created_by,
       status, mode, product_id, plan_qty, bom_version, summary, remark, created_at, updated_at)
    VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insItem = db.prepare(`
    INSERT INTO purchase_order_items (order_id, material_id, qty, price, received_qty, remark)
    VALUES (?, ?, ?, ?, 0, NULL)
  `);

  const statuses = ['进行中', '部分到货', '已完成', '已取消'];
  const t0 = Date.now();
  let written = 0;

  const CHUNK = 20000;
  for (let start = 0; start < N; start += CHUNK) {
    const end = Math.min(start + CHUNK, N);
    db.exec('BEGIN');
    for (let i = start; i < end; i++) {
      // 日期铺开到 3 年，让「按日期倒序 + 深翻页」是真实场景而不是全部同值
      const dayOffset = i % 1095;
      const d = new Date(Date.UTC(2023, 0, 1) + dayOffset * 86400000)
        .toISOString()
        .slice(0, 10);
      const isBom = i % 3 === 0;
      const summary =
        i % 7 === 0
          ? '电源线、螺丝包'
          : i % 7 === 1
            ? '塑料外壳、说明书'
            : i % 7 === 2
              ? '发热盘、温控器'
              : i % 7 === 3
                ? '刀头组件、电机'
                : i % 7 === 4
                  ? '控制面板、线束'
                  : i % 7 === 5
                    ? '滤网、水箱'
                    : '底座、脚垫';

      const info = insOrder.run(
        `PB2026-${pad(i, 8)}`,
        sup[i % sup.length].id,
        d,
        d,
        usr[0].id,
        statuses[i % statuses.length],
        isBom ? 'bom' : 'direct',
        isBom ? prod[i % prod.length].id : null,
        isBom ? 100 + (i % 50) : null,
        isBom ? 'V1.0' : null,
        summary,
        i % 11 === 0 ? `压测备注 ${i}` : null,
        `${d}T08:00:00.000Z`,
        `${d}T08:00:00.000Z`,
      );
      const oid = info.lastInsertRowid;
      for (let k = 0; k < 3; k++) {
        insItem.run(oid, mats[(i + k) % mats.length].id, 10 + ((i + k) % 40), 1.5 + ((i + k) % 30));
      }
      written++;
    }
    db.exec('COMMIT');
    process.stdout.write(`\r  已灌入 ${written} / ${N} 条…`);
  }
  console.log('\r  已灌入 ' + written + ' 条订单            ');

  db.pragma('synchronous = FULL');
  db.exec('ANALYZE');
  const counts = db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM purchase_orders) o,
              (SELECT COUNT(*) FROM purchase_order_items) i`,
    )
    .get();
  const size = (fs.statSync(perfDb).size / 1024 / 1024).toFixed(1);
  console.log(
    `  灌数据耗时 ${(Date.now() - t0) / 1000}s；订单 ${counts.o} 条 / 明细 ${counts.i} 条；数据库 ${size}MB`,
  );
  const idx = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_po%'`)
    .all();
  console.log(`  生效的采购索引：${idx.map((r) => r.name).join(', ') || '（无）'}`);
  db.close();

  console.log('\n下一步：用下面的命令启动指向压测库的服务，再跑 bench');
  console.log(
    `  DB_FILE=server/data/perf.db PORT=3099 npm --prefix server run start`,
  );
}

/* ----------------------------------------------------------------- bench */

async function api(pathname, token) {
  const t = Date.now();
  const res = await fetch(BASE + pathname, {
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  });
  const json = await res.json();
  return { status: res.status, ms: Date.now() - t, json };
}

async function bench() {
  const login = await fetch(BASE + '/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin12345' }),
  }).then((r) => r.json());
  const token = login.data.token;

  const total0 = (await api('/purchase/orders?page=1&pageSize=1', token)).json.data.total;
  console.log(`\n压测库当前采购订单总数：${total0} 条\n`);

  const cases = [
    ['① 首页列表（无关键词、无筛选）', '/purchase/orders?page=1&pageSize=20'],
    ['② 翻到中间页（offset 约 15 万）', `/purchase/orders?page=${Math.floor(total0 / 2 / 20)}&pageSize=20`],
    ['③ 深翻页：最后一页（最坏情况）', `/purchase/orders?page=${Math.floor(total0 / 20)}&pageSize=20`],
    ['④ 状态筛选 = 进行中', '/purchase/orders?page=1&pageSize=20&status=进行中'],
    ['⑤ 关键词：分散度高的片段（订单号）', '/purchase/orders?page=1&pageSize=20&keyword=PB2026-000123'],
    ['⑥ 关键词：摘要片段', '/purchase/orders?page=1&pageSize=20&keyword=电源线'],
    ['⑦ 关键词：超高频词（几乎命中全部）', '/purchase/orders?page=1&pageSize=20&keyword=2026'],
    ['⑧ 关键词 + 状态叠加', '/purchase/orders?page=1&pageSize=20&keyword=螺丝包&status=进行中'],
  ];

  console.log('  场景                                      服务端耗时   返回行数   total');
  console.log('  ' + '-'.repeat(72));
  let worst = 0;
  for (const [name, url] of cases) {
    const r = await api(url, token);
    const rows = r.json.data?.list?.length ?? 0;
    const total = r.json.data?.total ?? '-';
    console.log(
      `  ${name.padEnd(40, ' ')} ${ms(r.ms).padStart(9)}   ${String(rows).padStart(6)}   ${total}`,
    );
    if (r.status !== 200) console.log(`      ⚠ HTTP ${r.status}：${JSON.stringify(r.json).slice(0, 120)}`);
    worst = Math.max(worst, r.ms);
  }
  console.log(`\n  最慢一次：${ms(worst)}（判定阈值：单场景 < 1000ms 视为可用，< 300ms 视为流畅）`);
  console.log(worst < 1000 ? '  结论：通过 ✓' : '  结论：偏慢，需要进一步优化 ✗');
}

/* ----------------------------------------------------------------- clean */

function clean() {
  for (const f of [perfDb, perfDb + '-wal', perfDb + '-shm']) {
    if (fs.existsSync(f)) fs.rmSync(f, { force: true });
  }
  console.log('已删除压测库 server/data/perf.db');
}

if (cmd === 'seed') seed();
else if (cmd === 'bench') await bench();
else if (cmd === 'clean') clean();
else console.log('未知子命令：可用 seed / bench / clean');
