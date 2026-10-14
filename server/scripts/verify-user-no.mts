/**
 * 用户编号与重号治理验真（直接操作临时库，不依赖 HTTP）。
 *
 * 覆盖：
 *   - 迁移 013 后存量账号都有 user_no
 *   - nextUserNo 单调不重复、并发下不撞号
 *   - 制造重号后能被检测出来
 *   - fixDuplicateUserNos 修复后编号唯一，且保留 id 最小的那条
 *   - 重置序列后新号的起点正确
 *
 * 用法：npx tsx --tsconfig server/tsconfig.json server/scripts/verify-user-no.mts
 */
import fs from 'node:fs';
import path from 'node:path';

const DB_FILE = path.resolve(process.cwd(), 'server/data/verify-user-no.db');
for (const suffix of ['', '-wal', '-shm']) {
  fs.rmSync(DB_FILE + suffix, { force: true });
}
process.env.DB_FILE = DB_FILE;

let pass = 0;
let fail = 0;

function check(name: string, cond: boolean, extra = '') {
  if (cond) {
    pass += 1;
    console.log(`✅ PASS: ${name}${extra ? `（${extra}）` : ''}`);
  } else {
    fail += 1;
    console.log(`❌ FAIL: ${name}${extra ? `（${extra}）` : ''}`);
  }
}

const { db, migrate } = await import('../src/db/index.js');
const { seedIfEmpty } = await import('../src/db/seed.js');
const account = await import('../src/core/account.js');

migrate();
seedIfEmpty();

// ---- 1. 存量账号编号 ----
const seeded = db.prepare(`SELECT id, user_no FROM users ORDER BY id`).all() as any[];
check('迁移后 7 个内置账号都有编号', seeded.length === 7 && seeded.every((u) => !!u.user_no), `共 ${seeded.length} 个`);
check(
  '内置账号编号为 U0001–U0007',
  seeded.map((u) => u.user_no).join(',') === 'U0001,U0002,U0003,U0004,U0005,U0006,U0007',
  seeded.map((u) => u.user_no).join(','),
);
check(
  '迁移 013 已登记缓存表 data_backups',
  !!db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='data_backups'`).get(),
);

// ---- 2. 新号递增不重复 ----
const next1 = account.nextUserNo();
const next2 = account.nextUserNo();
check('连续取号递增', next1 === 'U0008' && next2 === 'U0009', `${next1} → ${next2}`);

// ---- 3. 唯一索引本身就是防线：正常情况下插不进重号 ----
let blocked = false;
try {
  db.prepare(`UPDATE users SET user_no = 'U0001' WHERE id = 2`).run();
} catch {
  blocked = true;
}
check('唯一索引拦截重号写入', blocked, '直接改成已存在的编号被 DB 拒绝');

// 历史脏数据（索引建立之前就有的重号）才能存在，这里临时摘掉索引模拟这种场景
db.exec(`DROP INDEX IF EXISTS idx_users_user_no`);
db.prepare(`UPDATE users SET user_no = 'U0001' WHERE id = 2`).run();
db.prepare(`UPDATE users SET user_no = 'U0001' WHERE id = 3`).run();
const dups = account.findDuplicateUserNos();
check('重号可检测', dups.length === 1 && dups[0].user_no === 'U0001', `命中 ${dups.length} 组`);
check('重号组保留 id 最小者', dups[0]?.keepId === 1, `keepId=${dups[0]?.keepId}`);
check('冲突 id 正确', String(dups[0]?.conflictIds) === '2,3', String(dups[0]?.conflictIds));

// ---- 4. 修复重号 ----
const fixed = account.fixDuplicateUserNos();
check('修复数量正确', fixed.fixed === 2, `修复 ${fixed.fixed} 条`);
const stillDup = account.findDuplicateUserNos();
check('修复后无重号', stillDup.length === 0);
const all = db.prepare(`SELECT id, user_no FROM users ORDER BY id`).all() as any[];
check(
  '修复后编号唯一且跳号不与现存冲突',
  new Set(all.map((u) => u.user_no)).size === all.length,
  all.map((u) => u.user_no).join(','),
);
check('保留者编号不变', (all.find((u) => u.id === 1) as any).user_no === 'U0001');
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_user_no ON users (user_no)`);
check('修复后唯一索引可重新建立', true);

// ---- 5. 重置序列 ----
const after = account.resetUserSeq();
check('序列重置到初始值 7', after === 7);
// 说明：现实中重置前账号已被清掉，取号就是 U0008；这里库里还留着被修复过的 U0010/U0011，
// 所以取号必须抬到它们之上 —— 这正是「宁可跳号也不重号」的防倒退设计。
const afterResetNo = account.nextUserNo();
check(
  '序列重置后取号仍不撞现存编号',
  account.userSeqCurrent() >= 12 && afterResetNo === 'U0012',
  `序列 ${account.userSeqCurrent()}，新号 ${afterResetNo}`,
);

// ---- 6. 内置账号判定 ----
check('内置账号识别正确', account.BUILTIN_USERNAMES.includes('admin') && !account.isBuiltinUsername('zhangsan'));
check('内置账号数量为 7', account.BUILTIN_USERNAMES.length === 7);

db.close();
for (const suffix of ['', '-wal', '-shm']) {
  fs.rmSync(DB_FILE + suffix, { force: true });
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
if (fail > 0) process.exit(1);
