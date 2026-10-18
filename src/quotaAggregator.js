/**
 * 积分聚合器（F3 看板的数据层）— 快照缓存 + 并发聚合 + 陈旧降级。
 *
 * 三级刷新模型（设计文档 5.3）：
 *   L0 快照   面板轮询/切页      读 meta.quotaSnapshot（签到轮刚写的），零网络
 *   L1 手动 live 用户点刷新积分  真打上游，回填快照（daemon /quota?live=1）
 *   L2 后台保活 跟随签到轮 120min 每轮给有 quota 能力的账号顺带刷一次（checkin.js 轮末调）
 *
 * 为什么默认快照（决策 D6）：多工具后面板 30s 轮询 × N 账号会打爆上游；cookie 站点
 * 已验证「默认快照 + ?live=1 手动 + 后台推送」治理有效，推广到全部工具（行为兼容性
 * 变更：旧调用方默认从 live 变快照，?live=1 逃生门保留）。
 *
 * 快照形状：meta.quotaSnapshot = { ...UnifiedQuota, at }（与 cookie 站点的 total/used/at
 * 兼容，同键并存）；>25h 视为陈旧（面板标注），只含标量无凭据（C7：可回显）。
 */

import { withAccounts } from './store.js';
import { productImpl } from './providers.js';
import { refreshContext } from './accounts.js';

const STALE_MS = 25 * 3600 * 1000;
const DEFAULT_CONCURRENCY = 3;

/** 账号的积分快照（meta.quotaSnapshot；无则 null） */
export function snapshotOf(account) {
  const snap = account?.meta?.quotaSnapshot;
  return snap && snap.at ? snap : null;
}

/** 快照是否陈旧（无快照 = 真）；nowMs 可注入（测试） */
export function isStale(account, nowMs = Date.now()) {
  const snap = snapshotOf(account);
  if (!snap) return true;
  const at = Date.parse(snap.at);
  return !Number.isFinite(at) || nowMs - at > STALE_MS;
}

/** 写回快照（只碰 meta.quotaSnapshot 一个键；原子写走 withAccounts 串行队列） */
async function writeSnapshot(accountId, quota) {
  await withAccounts((list) => {
    const cur = list.find((a) => a.id === accountId);
    if (!cur) return;
    cur.meta = { ...(cur.meta || {}), quotaSnapshot: { ...quota, at: new Date().toISOString() } };
    cur.updatedAt = new Date().toISOString();
  });
}

/** 去掉快照里的 at 字段，还原统一 quota 结构给消费方 */
function stripAt(snap) {
  const { at: _at, ...quota } = snap;
  return quota;
}

/**
 * 单账号 live 刷新（L1 手动 / L2 后台保活共用）：真打上游 → 回填快照 → 返回统一结构。
 * 失败上抛（由调用方决定降级方式）。
 */
export async function refreshOne(account, { log } = {}) {
  const impl = productImpl(account.provider);
  if (!impl?.quota) throw new Error('该产品不支持额度查询');
  const ctx = { log: log || (() => {}), ...refreshContext(account, log || (() => {})) };
  const quota = await impl.quota(account, ctx);
  await writeSnapshot(account.id, quota);
  return quota;
}

/**
 * 批量聚合（信号量并发，默认 3；不引 p-limit）。
 * @param {Array} accounts 账号记录
 * @param {{live?: boolean, maxConcurrent?: number}} opts
 * @returns {Promise<Map<string, {quota?, staleSince?: string|null, stale?: boolean, error?: string}>>}
 *   单账号失败 → 该项带 error（+ 旧快照若有），其余照常（失败隔离）
 */
export async function aggregateQuotas(accounts, { live = false, maxConcurrent = DEFAULT_CONCURRENCY } = {}) {
  const out = new Map();
  const queue = [...(accounts || [])];
  const worker = async () => {
    while (queue.length) {
      const account = queue.shift();
      try {
        if (live) {
          const quota = await refreshOne(account);
          out.set(account.id, { quota, staleSince: new Date().toISOString(), stale: false });
        } else {
          const snap = snapshotOf(account);
          if (!snap) {
            out.set(account.id, { staleSince: null, stale: true, error: '暂无积分快照，点「刷新积分」获取' });
          } else {
            out.set(account.id, { quota: stripAt(snap), staleSince: snap.at, stale: isStale(account) });
          }
        }
      } catch (e) {
        // 失败降级：有旧快照照常回（面板显示旧数字 + 错误提示），无快照只回错误
        const snap = snapshotOf(account);
        out.set(account.id, {
          ...(snap ? { quota: stripAt(snap), staleSince: snap.at } : { staleSince: null }),
          stale: true,
          error: e?.message || String(e),
        });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Number(maxConcurrent) || DEFAULT_CONCURRENCY) }, worker));
  return out;
}
