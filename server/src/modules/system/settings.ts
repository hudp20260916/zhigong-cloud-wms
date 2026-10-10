import { Router } from 'express';
import { z } from 'zod';
import { db, nowIso } from '../../db/index.js';
import { Err } from '../../core/errors.js';
import { writeLog } from '../../core/log.js';
import { requirePerm, requireAuth } from '../../middleware/auth.js';
import { ok } from '../../shared/http.js';

export const settingsRouter = Router();

/**
 * 系统参数。
 * 用 key-value 表而不是给每种配置建列：预警阈值这类配置会持续加项，
 * 加列要改迁移文件，加行不用。
 */

export interface SettingDef {
  key: string;
  label: string;
  group: string;
  type: 'number' | 'text';
  min?: number;
  max?: number;
  suffix?: string;
  hint: string;
}

export const SETTING_DEFS: SettingDef[] = [
  {
    key: 'alert.safetyRatio',
    label: '安全库存告警系数',
    group: '预警配置',
    type: 'number',
    min: 0.1,
    max: 5,
    hint: '库存低于「安全库存 × 该系数」时触发安全库存告警，默认 1（即低于安全库存即告警）。',
  },
  {
    key: 'alert.severeRatio',
    label: '严重缺货系数',
    group: '预警配置',
    type: 'number',
    min: 0.01,
    max: 1,
    hint: '库存低于「安全库存 × 该系数」时判定为严重缺货，默认 0.5。',
  },
  {
    key: 'alert.overStockRatio',
    label: '超储预警系数',
    group: '预警配置',
    type: 'number',
    min: 1.1,
    max: 20,
    suffix: '倍',
    hint: '库存高于「安全库存 × 该系数」时判定为超储，默认 3 倍；安全库存为 0 的对象不参与。',
  },
  {
    key: 'alert.idleDays',
    label: '呆滞库存天数',
    group: '预警配置',
    type: 'number',
    min: 1,
    max: 3650,
    suffix: '天',
    hint: '超过该天数没有任何出入库记录且仍有库存的，判定为呆滞库存，默认 60 天。',
  },
  {
    key: 'company.name',
    label: '公司名称',
    group: '企业信息',
    type: 'text',
    hint: '用于打印模板抬头。',
  },
  {
    key: 'company.phone',
    label: '联系电话',
    group: '企业信息',
    type: 'text',
    hint: '用于打印模板。',
  },
  {
    key: 'company.address',
    label: '公司地址',
    group: '企业信息',
    type: 'text',
    hint: '用于打印模板。',
  },
];

function defOf(key: string): SettingDef {
  const d = SETTING_DEFS.find((x) => x.key === key);
  if (!d) throw Err.badRequest(`未知配置项：${key}`);
  return d;
}

function valueOf(key: string): string {
  const row = db.prepare(`SELECT value FROM app_settings WHERE key = ?`).get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? '';
}

/** 预警阈值读取：告警看板与报表共用 */
export function alertConfig() {
  return {
    safetyRatio: Number(valueOf('alert.safetyRatio')) || 1,
    severeRatio: Number(valueOf('alert.severeRatio')) || 0.5,
    overStockRatio: Number(valueOf('alert.overStockRatio')) || 3,
    idleDays: Number(valueOf('alert.idleDays')) || 60,
  };
}

settingsRouter.get('/', requireAuth, (_req, res) => {
  ok(
    res,
    SETTING_DEFS.map((d) => ({ ...d, value: valueOf(d.key) })),
  );
});

const saveSchema = z.object({
  items: z.array(z.object({ key: z.string().min(1), value: z.string() })).min(1),
});

settingsRouter.put('/', requirePerm('system.init.execute'), (req, res) => {
  const parsed = saveSchema.safeParse(req.body);
  if (!parsed.success) throw Err.badRequest(parsed.error.issues[0].message);
  const ctx = req.ctx!;

  for (const it of parsed.data.items) {
    const def = defOf(it.key);
    if (def.type === 'number') {
      const n = Number(it.value);
      if (!Number.isFinite(n)) throw Err.badRequest(`「${def.label}」必须是数字`);
      if (def.min !== undefined && n < def.min) throw Err.badRequest(`「${def.label}」不能小于 ${def.min}`);
      if (def.max !== undefined && n > def.max) throw Err.badRequest(`「${def.label}」不能大于 ${def.max}`);
    }
  }

  txWrite(parsed.data.items);
  writeLog({
    operatorId: ctx.userId,
    action: '修改系统参数',
    targetType: 'setting',
    detail: { keys: parsed.data.items.map((i) => i.key) },
  });

  ok(
    res,
    SETTING_DEFS.map((d) => ({ ...d, value: valueOf(d.key) })),
  );
});

function txWrite(items: { key: string; value: string }[]): void {
  db.transaction(() => {
    const stmt = db.prepare(
      `INSERT INTO app_settings (key, value, updated_at) VALUES (?,?,?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    );
    for (const it of items) stmt.run(it.key, it.value, nowIso());
  })();
}
