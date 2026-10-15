import crypto from 'node:crypto';
import os from 'node:os';
import { db, nowIso } from '../db/index.js';

/**
 * 授权内核（P0：离线激活码 + 机器码绑定 + 梯度降级）。
 *
 * 三条铁律：
 *  1. **只防扩散，不锁数据** —— 最严重也只是「禁止写入」，查询与导出永远放行；
 *  2. **离线可用** —— 校验全部在本地完成，不依赖外网；在线心跳是 P2 的加分项；
 *  3. **非对称签名** —— 服务端只内置公钥，私钥永远在 deploy/keys（已 gitignore）。
 *
 * 机器指纹采用「三分量至少命中 2 个」的宽松策略：
 *   客户换块网卡 / 改个机器名不至于当场瘫痪，整盘搬走则必然失配。
 */

// 测试环境可用环境变量替换（verify 脚本会注入自签密钥对）
const PUBLIC_KEY_PEM =
  process.env.LICENSE_PUBLIC_KEY_PEM ??
  `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAs/1q1gsVyRaFC8AKuhOL
mIYGWPbGi9zubbLrbnc9zYznOtwkyAnp1jnWM5FVS7nTodT9K0IccEAAH3oCzTSe
83ZiAHZ60OQ4YkFhka467Kl986WW0MPANq8Dt9LAyvYx2Pz6nmUYKo3wPMizACee
UkuUdEmErRCEogRhFUM8Sq2qQdrJQqaGP4KRd8D2oyNnU+Z8h1lTtuHLx9Qz797M
axeK590kCpLqvVbarhZIogpuVpLnHKcRzs5Vy2hy/zBnJBwBd15XQfOVKnvtJizA
vQPMJbiwN922K1Zu+exiSTwN02ZF1LfMZn53N0gXKwXrY+EcJ13LHXYpNPWre6aR
MQIDAQAB
-----END PUBLIC KEY-----`;

export const TRIAL_DAYS = 30;
export const LICENSE_PLANS = ['basic', 'standard', 'full'] as const;
export type LicensePlan = (typeof LICENSE_PLANS)[number];

export type LicenseStatus = 'trial' | 'active' | 'grace' | 'expired' | 'machine_mismatch' | 'invalid';

export interface LicenseState {
  status: LicenseStatus;
  plan: LicensePlan | null;
  licensee: string | null;
  seats: number | null;
  expireAt: string | null;
  /** 距到期 / 距试用结束的剩余天数（负数 = 已超） */
  daysLeft: number | null;
  graceDays: number;
  message: string;
  /** 当前机器的指纹三分量（公开信息，供签发工具回填） */
  fingerprint: string[];
  trialStart: string | null;
}

// ---------------------------------------------------------------- 机器指纹

function shortHash(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex').slice(0, 32);
}

function primaryMac(): string {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni && !ni.internal && ni.mac && ni.mac !== '00:00:00:00:00:00') return ni.mac;
    }
  }
  return 'no-mac';
}

/** 三分量：机器名 / 主网卡 MAC / 平台+CPU。每项单独哈希，签发与校验都只用这三分量 */
export function fingerprintComponents(): string[] {
  return [
    shortHash(`hostname|${os.hostname()}`),
    shortHash(`mac|${primaryMac()}`),
    shortHash(`platform|${os.platform()}-${os.arch()}-${os.cpus()[0]?.model ?? 'cpu'}`),
  ];
}

/** 至少命中 2 个分量才算同一台机器（换网卡或换机器名都能容忍，整盘拷贝必挂） */
export function machineMatches(licensed: string[] | null): boolean {
  if (!licensed || licensed.length === 0) return false;
  const cur = new Set(fingerprintComponents());
  return licensed.filter((h) => cur.has(h)).length >= 2;
}

// ---------------------------------------------------------------- 激活码解析

export interface LicensePayload {
  no: string;
  licensee: string;
  plan: LicensePlan;
  seats: number | null;
  /** 到期日 YYYY-MM-DD */
  expire: string;
  /** 机器指纹三分量 */
  fp: string[];
}

function b64urlToJson(s: string): any {
  return JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
}

/** 校验激活码签名与结构。返回 payload；不合法抛错（错误文案直接给管理员看） */
export function parseLicenseKey(key: string): LicensePayload {
  const parts = String(key ?? '').trim().split('.');
  if (parts.length !== 2) throw new Error('激活码格式不正确');
  let payload: LicensePayload;
  try {
    payload = b64urlToJson(parts[0]);
  } catch {
    throw new Error('激活码负载无法解析');
  }
  const ok = crypto.verify(
    'sha256',
    Buffer.from(parts[0]),
    crypto.createPublicKey(PUBLIC_KEY_PEM),
    Buffer.from(parts[1], 'base64url'),
  );
  if (!ok) throw new Error('激活码签名校验失败，请确认来源');
  if (!payload.no || !payload.licensee || !LICENSE_PLANS.includes(payload.plan)) {
    throw new Error('激活码内容不完整');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(payload.expire ?? ''))) {
    throw new Error('激活码到期日格式不正确');
  }
  return payload;
}

// ---------------------------------------------------------------- 状态机

interface LicenseRow {
  license_no: string | null;
  licensee: string | null;
  plan: string | null;
  seats: number | null;
  expire_at: string | null;
  grace_days: number;
  license_key: string | null;
  fingerprint: string | null;
  trial_start: string | null;
}

function row(): LicenseRow | null {
  return (db.prepare(`SELECT * FROM license WHERE id = 1`).get() as LicenseRow) ?? null;
}

function today(): string {
  return nowIso().slice(0, 10);
}

function daysBetween(fromIso: string, toDate: string): number {
  const from = new Date(`${fromIso.slice(0, 10)}T00:00:00Z`).getTime();
  const to = new Date(`${toDate}T00:00:00Z`).getTime();
  return Math.round((to - from) / 86_400_000);
}

/** 首次启动写入试用期起点；已有行则不动 */
export function ensureLicenseRow(): void {
  db.prepare(
    `INSERT INTO license (id, trial_start, grace_days, last_check_at)
     SELECT 1, ?, 7, ?
     WHERE NOT EXISTS (SELECT 1 FROM license WHERE id = 1)`,
  ).run(nowIso(), nowIso());
}

/**
 * 当前授权状态。
 * 优先级：有效激活码 > 机器不匹配 > 宽限期 > 试用期 > 过期。
 */
export function licenseState(): LicenseState {
  const r = row();
  const fp = fingerprintComponents();
  const base: LicenseState = {
    status: 'expired',
    plan: null,
    licensee: null,
    seats: null,
    expireAt: null,
    daysLeft: null,
    graceDays: r?.grace_days ?? 7,
    message: '',
    fingerprint: fp,
    trialStart: r?.trial_start ?? null,
  };

  // 无表/无行（迁移前的极端情况）按未授权过期处理，绝不崩溃
  if (!r) return { ...base, message: '授权信息缺失，请重新初始化' };

  // ---- 有激活码：签名已在激活时校验过，这里再验一次防止有人直接改库 ----
  if (r.license_key) {
    try {
      const payload = parseLicenseKey(r.license_key);
      if (!machineMatches(payload.fp)) {
        return { ...base, status: 'machine_mismatch', message: '授权码与当前机器不匹配，请重新激活' };
      }
      const left = daysBetween(today(), payload.expire);
      const state: LicenseState = {
        ...base,
        plan: payload.plan,
        licensee: payload.licensee,
        seats: payload.seats ?? null,
        expireAt: payload.expire,
        daysLeft: left,
      };
      if (left >= 0) {
        return { ...state, status: 'active', message: `授权有效，${payload.expire} 到期` };
      }
      if (-left <= r.grace_days) {
        return {
          ...state,
          status: 'grace',
          message: `授权已于 ${payload.expire} 到期，宽限期剩余 ${r.grace_days + left} 天，请尽快续期`,
        };
      }
      return { ...state, status: 'expired', message: '授权已过期，系统进入只读模式' };
    } catch {
      return { ...base, status: 'invalid', message: '激活码校验失败（可能被篡改），请重新激活' };
    }
  }

  // ---- 无激活码：试用期 ----
  if (r.trial_start) {
    const used = -daysBetween(r.trial_start, today());
    const left = TRIAL_DAYS - used;
    if (left > 0) {
      return {
        ...base,
        status: 'trial',
        daysLeft: left,
        message: `试用期剩余 ${left} 天（${TRIAL_DAYS} 天试用，从 ${r.trial_start.slice(0, 10)} 起算）`,
      };
    }
    return { ...base, status: 'expired', daysLeft: 0, message: '试用期已结束，请激活授权' };
  }

  return { ...base, message: '授权信息缺失，请重新初始化' };
}

/** 是否允许写操作：只有「彻底过期」才进入只读模式，其余状态全放行 */
export function writeAllowed(): boolean {
  return licenseState().status !== 'expired';
}

/** 账号数上限（seats）只拦新增，不踢存量。试用与未配置 seats 时不限 */
export function seatsAvailable(): { ok: boolean; message?: string } {
  const st = licenseState();
  if (st.status === 'trial' || st.seats === null || st.seats === undefined) return { ok: true };
  const activeCount = Number(
    (db.prepare(`SELECT COUNT(*) AS c FROM users WHERE status = 'active'`).get() as { c: number }).c,
  );
  if (activeCount >= st.seats) {
    return { ok: false, message: `授权允许 ${st.seats} 个启用账号，当前已有 ${activeCount} 个；请扩容授权或停用其它账号` };
  }
  return { ok: true };
}

/** 用激活码激活（先验签名、再验机器，两关都过才落库） */
export function activate(key: string): LicenseState {
  const payload = parseLicenseKey(key);
  if (!machineMatches(payload.fp)) {
    throw new Error('激活码与当前机器不匹配，请提供本机的机器指纹重新签发');
  }
  db.prepare(
    `UPDATE license SET
       license_no = ?, licensee = ?, plan = ?, seats = ?, expire_at = ?,
       license_key = ?, fingerprint = ?, activated_at = ?, last_check_at = ?
     WHERE id = 1`,
  ).run(
    payload.no,
    payload.licensee,
    payload.plan,
    payload.seats ?? null,
    payload.expire,
    String(key).trim(),
    JSON.stringify(payload.fp),
    nowIso(),
    nowIso(),
  );
  return licenseState();
}
