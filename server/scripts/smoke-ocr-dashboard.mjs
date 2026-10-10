/**
 * P6 工作台大屏 & OCR 建单 冒烟测试
 *   node server/scripts/smoke-ocr-dashboard.mjs
 */
// 兼容两种写法：API_BASE 带 /api 后缀，BASE 不带
const API_BASE = process.env.API_BASE;
const BASE = API_BASE ? API_BASE.replace(/\/api$/, '') : (process.env.BASE ?? 'http://localhost:3001');

let token = '';
let failures = 0;

async function call(method, path, body, useToken = true) {
  const headers = { 'Content-Type': 'application/json' };
  if (useToken && token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(json)}`);
    e.status = res.status;
    e.body = json;
    throw e;
  }
  return json.data;
}

function check(name, cond, extra = '') {
  if (cond) console.log(`  ✓ ${name}${extra ? ` — ${extra}` : ''}`);
  else {
    failures++;
    console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`);
  }
}

async function login(username, password) {
  const d = await call('POST', '/api/auth/login', { username, password }, false);
  token = d.token;
  return d.user;
}

/** 生成一张极小的合法 PNG，作为 OCR 上传内容 */
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/wFPn0S4AAAAAElFTkSuQmCC';

async function main() {
  await login('admin', 'admin12345');

  console.log('== P6 冒烟：工作台大屏 ==');
  const s = await call('GET', '/api/dashboard/summary');
  check('指标卡返回', !!s.metrics && typeof s.metrics.materialKinds === 'number', `物料 ${s.metrics.materialKinds} 种`);
  check(
    '待办项全部有真实取值',
    ['pendingPurchase', 'pendingReceipt', 'pendingSale', 'pendingCheck', 'pendingSettle'].every(
      (k) => typeof s.todo[k] === 'number',
    ),
    JSON.stringify(s.todo),
  );
  check('今日流水返回', Array.isArray(s.todayFlow));
  check(
    '今日流水不含 receipt_no',
    s.todayFlow.every((r) => !('receipt_no' in r)),
  );
  check('趋势补齐 7 天', Array.isArray(s.trend) && s.trend.length === 7);
  check(
    '趋势含日期标签与三类数值',
    s.trend.every(
      (t) => t.label && typeof t.purchaseIn === 'number' && typeof t.produceIn === 'number' && typeof t.saleOut === 'number',
    ),
  );
  check('告警 Top5 返回', Array.isArray(s.alarmTop) && s.alarmTop.length <= 5, `${s.alarmTop.length} 条`);
  check('月度采购/销售额存在', typeof s.metrics.monthPurchaseAmount === 'number' && typeof s.metrics.monthSaleAmount === 'number');

  // 无价格权限的角色不应拿到金额类指标
  const viewer = await (async () => {
    const d = await call('POST', '/api/auth/login', { username: 'viewer', password: 'admin12345' }, false);
    return d.token;
  })();
  const old = token;
  token = viewer;
  const s2 = await call('GET', '/api/dashboard/summary');
  check('普通查询人员拿到脱敏指标', s2.canViewPrice === false);
  token = old;

  console.log('\n== P6 冒烟：OCR 识别建单 ==');
  const before = await call('GET', '/api/purchase/ocr/stats');
  const r1 = await call('POST', '/api/purchase/ocr/recognize', {
    fileName: '送货单-001.png',
    mimeType: 'image/png',
    contentBase64: TINY_PNG_BASE64,
  });
  check('识别返回请求号', !!r1.requestId);
  check('识别返回明细行', Array.isArray(r1.result.lines) && r1.result.lines.length >= 2, `${r1.result.lines.length} 行`);
  check(
    '识别行已匹配到物料档案',
    r1.result.lines.every((l) => typeof l.materialId === 'number'),
  );
  check('返回结果含置信度', r1.result.lines.every((l) => typeof l.confidence === 'number'));
  check('低置信度行给出复核提示', (r1.result.warnings ?? []).length > 0, r1.result.warnings?.[0] ?? '');

  // 同一张图两次识别结果应一致（确定性 mock，便于演示与回归）
  const r2 = await call('POST', '/api/purchase/ocr/recognize', {
    fileName: '送货单-001.png',
    mimeType: 'image/png',
    contentBase64: TINY_PNG_BASE64,
  });
  check(
    '识别结果可复现',
    JSON.stringify(r1.result.lines) === JSON.stringify(r2.result.lines),
  );

  // 非法类型 / 超大文件拦截
  let bad = false;
  try {
    await call('POST', '/api/purchase/ocr/recognize', {
      fileName: 'a.exe',
      mimeType: 'application/x-msdownload',
      contentBase64: TINY_PNG_BASE64,
    });
  } catch (e) {
    bad = e.status === 400;
  }
  check('非法文件类型被拦截', bad);

  let tooBig = false;
  try {
    await call('POST', '/api/purchase/ocr/recognize', {
      fileName: 'big.png',
      mimeType: 'image/png',
      contentBase64: 'A'.repeat(6 * 1024 * 1024),
    });
  } catch (e) {
    tooBig = e.status === 400;
  }
  check('超过 4MB 被拦截', tooBig);

  // 用识别结果建单（source='ocr'），并检查库存真的增加
  const stockBefore = (
    await call('GET', `/api/inventory/materials?keyword=${encodeURIComponent(r1.result.lines[0].materialName)}`)
  ).list[0];

  const created = await call('POST', '/api/purchase/receipts', {
    supplierId: r1.result.supplierId ?? null,
    receiptDate: new Date().toISOString().slice(0, 10),
    source: 'ocr',
    ocrRequestId: r1.requestId,
    items: r1.result.lines.map((l) => ({
      materialId: l.materialId,
      qty: l.qty,
      price: l.price,
      isGift: false,
    })),
    remark: '冒烟：OCR 建单',
  });
  check('OCR 结果可生成入库单', !!created.id);

  const stockAfter = (
    await call('GET', `/api/inventory/materials?keyword=${encodeURIComponent(r1.result.lines[0].materialName)}`)
  ).list[0];
  const delta = Number(stockAfter.current_stock) - Number(stockBefore.current_stock);
  const expect = r1.result.lines
    .filter((l) => l.materialId === r1.result.lines[0].materialId)
    .reduce((a, l) => a + Number(l.qty), 0);
  check('OCR 建单确实增加了库存', Math.abs(delta - expect) < 0.001, `+${delta}（应 +${expect}）`);

  const logs = await call('GET', '/api/purchase/ocr/logs');
  const mine = logs.find((l) => l.request_id === r1.requestId);
  check('识别日志已落库', !!mine);
  check('采纳后状态回写为已建单', mine?.status === '已建单' && Number(mine.receipt_id) === created.id, `status=${mine?.status}`);

  const stats = await call('GET', '/api/purchase/ocr/stats');
  check('统计接口返回采纳数', stats.adopted >= 1, `本次采纳 ${stats.adopted - (before.adopted ?? 0)}`);

  // 撤销，避免影响其他用例
  await call('POST', `/api/purchase/receipts/${created.id}/undo`);
  const stockUndo = (
    await call('GET', `/api/inventory/materials?keyword=${encodeURIComponent(r1.result.lines[0].materialName)}`)
  ).list[0];
  check('撤销后库存回滚', Math.abs(Number(stockUndo.current_stock) - Number(stockBefore.current_stock)) < 0.001);

  console.log(`\n${failures === 0 ? '✅ P6 全部通过' : `❌ ${failures} 项失败`}`);
  if (failures > 0) process.exit(1);
}

main().catch((e) => {
  console.error('冒烟失败：', e.message);
  process.exit(1);
});
