/**
 * 积分到期监视（F4）— 到期记录、规则判定、每日汇总、免打扰。
 *
 * 数据来源：各产品 quota() 的统一结构 parts[].expiresAt（ISO；Qoder 逐资源包明细最全）。
 * 缺失处理：parts 为空或无 expiresAt 的工具 = 不提醒，不看 total 猜到期（没有数据比错误提醒
 * 更符合「失败不卡死、不误导」）。哨兵值过滤（R9）：9999 年之类的占位到期时间不算真实到期。
 *
 * 持久化（C6 键空间隔离，只经 withState 串行队列）：
 *   state.expiryWatch = { [accountId]: { expiresAt, remaining, name, provider, at } }
 *   state.dismissedReminders = [{ accountId, expiresAt }]（「知道了」按 账号+到期时间 免打扰）
 *   state.expiryDigest = { day, at, count }（每日 09:00 汇总一次的幂等标记）
 *
 * 提醒规则（6.3）：提前 daysBefore 天（默认 3，可配 1-14）内 warn；≤24h urgent；
 * 每日 09:00（本地时区）汇总一次（由签到轮顺带触发，不新增第二套定时器）+ 当天到期立即一次
 * （桌面壳对 /api/status.expiring 的变化检测天然覆盖）。总开关 settings.reminder.enabled。
 *
 * 通道（D3）：面板徽标 + 提醒卡、Windows 桌面通知（壳轮询 /api/status）、本地日志 warn——
 * 全部本地，不做邮件（违反「凭据/数据不外传」红线）。
 */

import { loadState, withState, loadSettings, normalizeExpiry } from './store.js';
import { logger } from './logger.js';

const DEFAULT_DAYS_BEFORE = 3;
const DIGEST_HOUR_LOCAL = 9;
const MAX_DISMISSED = 200;
// 哨兵值上限：超过 2100 年的「到期时间」是占位符（如 Qoder fmtExpiry 过滤的 9999 年），不当真
const SANE_MAX_MS = Date.parse('2100-01-01T00:00:00Z');

const localDateStr = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** 归一 + 哨兵过滤：返回可用 ISO 或 null */
function saneExpiry(v) {
  const iso = normalizeExpiry(v);
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) && t < SANE_MAX_MS ? iso : null;
}

/**
 * 记录账号的到期快照（quota.parts 中 remaining>0 且非周期重置的最早 expiresAt）。
 * 无到期数据 → 删除该账号旧记录（工具不再提供 expiresAt 时停止提醒，避免残留误报）。
 * @param {string} accountId
 * @param {object} quota 统一额度结构
 * @param {{name?: string, provider?: string}} [who] 展示用身份（可选）
 */
export async function recordExpiry(accountId, quota, who = {}) {
  const parts = Array.isArray(quota?.parts) ? quota.parts : [];
  const soon = parts
    .filter((p) => p && Number(p.remaining) > 0 && p.expiresAt && p.recurring !== true)
    .map((p) => ({ expiresAt: saneExpiry(p.expiresAt), remaining: Number(p.remaining) || 0 }))
    .filter((p) => p.expiresAt)
    .sort((a, b) => a.expiresAt.localeCompare(b.expiresAt))[0];
  await withState((state) => {
    const watch = (state.expiryWatch = state.expiryWatch || {});
    if (soon) {
      watch[accountId] = { ...soon, name: who.name || watch[accountId]?.name || null, provider: who.provider || watch[accountId]?.provider || null, at: new Date().toISOString() };
    } else {
      delete watch[accountId];
    }
  });
}

/** 生效的提醒配置（settings.reminder：enabled 总开关 + daysBefore 提前量 1-14） */
async function reminderConfig() {
  const cfg = (await loadSettings()).reminder || {};
  return {
    enabled: cfg.enabled !== false,
    daysBefore: Math.min(14, Math.max(1, Number(cfg.daysBefore) || DEFAULT_DAYS_BEFORE)),
  };
}

/**
 * 当前到期的提醒列表（脱敏标量；面板徽标 / 桌面通知 / 提醒卡共用）。
 * @returns {Promise<Array<{accountId, name, provider, expiresAt, remaining, daysLeft, level}>>}
 */
export async function dueReminders(nowMs = Date.now()) {
  const [state, cfg] = await Promise.all([loadState(), reminderConfig()]);
  if (!cfg.enabled) return [];
  const dismissed = new Set(
    (Array.isArray(state.dismissedReminders) ? state.dismissedReminders : [])
      .map((d) => `${d.accountId}|${d.expiresAt}`),
  );
  const out = [];
  for (const [accountId, rec] of Object.entries(state.expiryWatch || {})) {
    if (!rec?.expiresAt || dismissed.has(`${accountId}|${rec.expiresAt}`)) continue;
    const ms = Date.parse(rec.expiresAt) - nowMs;
    if (!Number.isFinite(ms)) continue;
    const daysLeft = ms / 86400000;
    if (daysLeft > cfg.daysBefore) continue;
    out.push({
      accountId,
      name: rec.name || null,
      provider: rec.provider || null,
      expiresAt: rec.expiresAt,
      remaining: rec.remaining ?? null,
      daysLeft: Math.round(daysLeft * 10) / 10,
      level: daysLeft <= 1 ? 'urgent' : 'warn',   // ≤24h（含已过期）urgent，其余 warn
    });
  }
  return out.sort((a, b) => a.expiresAt.localeCompare(b.expiresAt));
}

/** 「知道了」：按 accountId+expiresAt 免打扰（同一到期时间不再提醒；保留最近 200 条） */
export async function dismissReminder(accountId, expiresAt) {
  await withState((state) => {
    const list = Array.isArray(state.dismissedReminders) ? state.dismissedReminders : [];
    const dup = list.some((d) => String(d.accountId) === String(accountId) && String(d.expiresAt) === String(expiresAt));
    if (!dup) {
      list.push({ accountId: String(accountId), expiresAt: String(expiresAt) });
      state.dismissedReminders = list.slice(-MAX_DISMISSED);
    }
  });
}

/**
 * 每日 09:00（本地时区）汇总一次：到点且今日未汇总过才跑；无提醒不标记（当天稍后出现仍可汇总）。
 * 由签到轮顺带调用（启动 15s 引导轮 + 每 120min 轮），不新增定时器（幂等简单性）。
 * @returns {Promise<Array>} 本次汇总的提醒列表（空 = 未到点 / 已汇总 / 无可提醒）
 */
export async function runDailyDigest(nowMs = Date.now()) {
  const now = new Date(nowMs);
  if (now.getHours() < DIGEST_HOUR_LOCAL) return [];
  const state = await loadState();
  const today = localDateStr(now);
  if (state.expiryDigest?.day === today) return [];
  const reminders = await dueReminders(nowMs);
  if (!reminders.length) return [];
  await withState((fresh) => {
    fresh.expiryDigest = { day: today, at: new Date(nowMs).toISOString(), count: reminders.length };
  });
  // 本地日志通道（P0 留痕）：汇总一条行列全部，不逐账号轰炸
  for (const r of reminders) {
    logger.warn('EXPIRY', '{name}（{provider}）积分 {date} 到期（剩 {days} 天，余 {left}）', {
      name: r.name || r.accountId, provider: r.provider || '—', date: r.expiresAt.slice(0, 10),
      days: r.daysLeft, left: r.remaining ?? '—',
    });
  }
  return reminders;
}
