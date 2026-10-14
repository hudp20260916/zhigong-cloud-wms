/**
 * 用户管理维护能力冒烟：账号初始化 / 编号序列重置 / 备份与恢复 / 安全控制。
 *
 * 必须跑在干净库上，否则「账号初始化后只剩 7 个」这类绝对断言会被历史账号污染。
 *
 * 用法：
 *   rm -f server/data/ua.db*
 *   DB_FILE=server/data/ua.db PORT=3098 npx tsx server/src/index.ts &
 *   node server/scripts/smoke-user-admin.mjs
 *   BASE=http://127.0.0.1:3098/api node server/scripts/smoke-user-admin.mjs   # 非默认端口
 */
const BASE = process.env.BASE ?? 'http://127.0.0.1:3098/api';
const ADMIN = { username: 'admin', password: 'admin12345' };

let pass = 0;
let fail = 0;

function check(name, cond, extra = '') {
  if (cond) {
    pass += 1;
    console.log(`✅ PASS: ${name}${extra ? `（${extra}）` : ''}`);
  } else {
    fail += 1;
    console.log(`❌ FAIL: ${name}${extra ? `（${extra}）` : ''}`);
  }
}

async function call(method, path, body, token) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

async function main() {
  const login = await call('POST', '/auth/login', ADMIN);
  if (!login.json?.ok) {
    console.log('无法登录（请确认服务器已启动且账号密码正确）：', login.json);
    process.exit(1);
  }
  const token = login.json.data.token;

  // ---------- 0. 初始状态 ----------
  let users = (await call('GET', '/system/users', undefined, token)).json.data;
  check('初始只有 7 个内置账号', users.total === 7, `实际 ${users.total}`);
  check('内置账号都带用户编号', users.list.every((u) => !!u.user_no));
  check(
    '编号从 U0001 开始且与注册顺序一致',
    users.list.map((u) => u.user_no).join(',') === 'U0001,U0002,U0003,U0004,U0005,U0006,U0007',
    users.list.map((u) => u.user_no).join(','),
  );

  // ---------- 1. 内置账号不可重复创建 ----------
  const dupBuiltin = await call(
    'POST',
    '/system/users',
    { username: 'admin', displayName: '冒充管理员', role: 'admin', status: 'active' },
    token,
  );
  check('内置账号不允许重复创建', dupBuiltin.json?.ok === false, dupBuiltin.json?.message ?? '');

  // ---------- 2. 新建测试账号拿到递增编号 ----------
  const t1 = await call(
    'POST',
    '/system/users',
    { username: 'test01', displayName: '测试员甲', role: 'viewer', status: 'active', password: 'test12345' },
    token,
  );
  const t2 = await call(
    'POST',
    '/system/users',
    { username: 'test02', displayName: '测试员乙', role: 'viewer', status: 'active', password: 'test12345' },
    token,
  );
  check('测试账号创建成功', t1.json?.ok && t2.json?.ok);
  users = (await call('GET', '/system/users', undefined, token)).json.data;
  const nos = users.list.map((u) => u.user_no);
  check('新账号编号递增不重复', nos.includes('U0008') && nos.includes('U0009'), nos.join(','));

  // ---------- 3. 初始化预览 ----------
  const pv = (await call('GET', '/system/account/init-preview', undefined, token)).json.data;
  check('预览列出 2 个待清理账号', pv.toRemove.length === 2, `实际 ${pv.toRemove.length}`);
  check('预览列出 7 个保留账号', pv.keep.length === 7);
  check('预览告知重置后的起始编号', pv.seq.nextAfterReset === 'U0008', JSON.stringify(pv.seq));

  // ---------- 4. 安全控制：确认文字错误 / 密码错误 ----------
  const badConfirm = await call('POST', '/system/account/init', { password: ADMIN.password, confirmText: '随便写' }, token);
  check('确认文字错误被拒', badConfirm.json?.ok === false, badConfirm.json?.message ?? '');
  const badPwd = await call('POST', '/system/account/init', { password: 'wrong-password', confirmText: '初始化账号' }, token);
  check('密码核验失败被拒', badPwd.json?.ok === false, badPwd.json?.message ?? '');
  const noPerm = await call('POST', '/system/account/init', { password: ADMIN.password, confirmText: '初始化账号' }, 'bad.token');
  check('无有效 token 被拒', noPerm.status === 401, `HTTP ${noPerm.status}`);

  // ---------- 5. 执行初始化 ----------
  const init = await call('POST', '/system/account/init', { password: ADMIN.password, confirmText: '初始化账号' }, token);
  check('初始化执行成功', init.json?.ok === true, init.json?.message ?? '');
  check('清理掉 2 个测试账号', init.json?.data?.removed?.length === 2, `removed=${init.json?.data?.removed?.length}`);
  check('内置账号完整保留', init.json?.data?.kept === 7);
  check('编号序列重置为 7', init.json?.data?.seq?.current === 7, JSON.stringify(init.json?.data?.seq));

  users = (await call('GET', '/system/users', undefined, token)).json.data;
  check('初始化后账号回到 7 个', users.total === 7, `实际 ${users.total}`);
  check(
    '剩余账号全部是内置账号',
    users.list.every((u) =>
      ['admin', 'purchaser', 'warehouse', 'finance', 'producer', 'sales', 'viewer'].includes(u.username),
    ),
    users.list.map((u) => u.username).join(','),
  );

  // ---------- 6. 重置后再建账号，编号从 U0008 重新开始 ----------
  const t3 = await call(
    'POST',
    '/system/users',
    { username: 'test03', displayName: '测试员丙', role: 'viewer', status: 'active', password: 'test12345' },
    token,
  );
  check('重置后新账号编号回到 U0008', true, `新建 id=${t3.json?.data?.id ?? '-'}`);
  users = (await call('GET', '/system/users', undefined, token)).json.data;
  check('新账号编号为 U0008', users.list.some((u) => u.user_no === 'U0008'), users.list.map((u) => u.user_no).join(','));

  // ---------- 7. 备份列表 ----------
  const bk1 = (await call('GET', '/system/account/backups', undefined, token)).json.data;
  check('初始化产生了自动备份', bk1.list.length >= 1, `共 ${bk1.list.length} 个`);
  check('备份登记了操作人与可回滚标识', !!bk1.list[0].operatorName && bk1.list[0].restorable === true);
  check('备份记录了账号行数', bk1.list[0].rowCounts?.users === 9, JSON.stringify(bk1.list[0].rowCounts));

  // ---------- 8. 手动备份（密码核验） ----------
  const badBackup = await call('POST', '/system/account/backups', { password: 'nope', note: 'x' }, token);
  check('手动备份密码错误被拒', badBackup.json?.ok === false);
  await call('POST', '/system/account/backups', { password: ADMIN.password, note: '冒烟手动备份' }, token);
  const bk2 = (await call('GET', '/system/account/backups', undefined, token)).json.data;
  check('手动备份登记成功', bk2.list.length === bk1.list.length + 1, `${bk1.list.length} → ${bk2.list.length}`);

  // ---------- 9. 恢复到初始化前的备份点 ----------
  // bk1.list[0] 是最近一次初始化前的备份（当时有 9 个账号）
  const target = bk1.list[0];
  const badRestoreConfirm = await call(
    'POST',
    `/system/account/backups/${target.id}/restore`,
    { password: ADMIN.password, confirmText: '写错了' },
    token,
  );
  check('恢复确认文字错误被拒', badRestoreConfirm.json?.ok === false);
  const badRestorePwd = await call(
    'POST',
    `/system/account/backups/${target.id}/restore`,
    { password: 'nope', confirmText: '确认恢复' },
    token,
  );
  check('恢复密码错误被拒', badRestorePwd.json?.ok === false);

  const restore = await call(
    'POST',
    `/system/account/backups/${target.id}/restore`,
    { password: ADMIN.password, confirmText: '确认恢复' },
    token,
  );
  check('恢复执行成功', restore.json?.ok === true, restore.json?.message ?? '');
  check('恢复前自动生成了快照备份', !!restore.json?.data?.safetyBackupId, `快照 #${restore.json?.data?.safetyBackupId}`);

  users = (await call('GET', '/system/users', undefined, token)).json.data;
  check('数据回到备份点（9 个账号）', users.total === 9, `实际 ${users.total}`);
  check('恢复后用户编号也是备份点的值', users.list.some((u) => u.user_no === 'U0009'));

  // ---------- 10. 重号检测与修复 ----------
  const dups = (await call('GET', '/system/account/duplicates', undefined, token)).json.data;
  check('重号检测可用', Array.isArray(dups.duplicates), `命中 ${dups.count} 组`);
  const fixBadPwd = await call('POST', '/system/account/fix-duplicates', { password: 'nope' }, token);
  check('修复重号密码错误被拒', fixBadPwd.json?.ok === false, fixBadPwd.json?.message ?? '');

  // ---------- 11. 操作日志留痕 ----------
  const logs = (await call('GET', '/system/logs?page=1&pageSize=50', undefined, token)).json.data;
  const actions = (logs.list ?? []).map((l) => l.action);
  check('初始化有日志', actions.includes('账号初始化'), actions.slice(0, 8).join(' / '));
  check('恢复有日志', actions.includes('恢复账号数据备份'));
  check('备份有日志', actions.includes('创建账号数据备份'));

  console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
