/**
 * L2 模板执行器 — 工具注册表的「简单 Bearer JSON API」签到/额度半配置执行 + productImpl 回落 impl。
 *
 * 分层策略（设计文档 2.1）：L1 凭据发现（toolReaders）→ L2 签到/额度（本模块，HTTP 模板）
 * → L3 复杂产品（{tool}Client.js 挂 PRODUCTS）。⚠️ L2 仅覆盖「Bearer/固定头 + JSON 响应」的
 * 简单端点：签名头（Qoder COSY）/ 验证码（ZCode 阿里云）/ 设备指纹 / 多文件快照切换必须走 L3。
 *
 * 模板占位符：{{token}} / {{refreshToken}} / {{uid}} 由本模块注入（账号字段，绝不进日志）。
 * 响应取值：$. 路径（~10 行纯函数，无依赖）。
 *
 * 端点实测纪律：工具配置里的 URL/参数必须来自真实抓包；未验证的端点不要填（见 tools.d/README.md）。
 */

import { FETCH_TIMEOUT_MS } from './constants.js';
import { pickPath } from './toolReaders/plainJson.js';

/** 模板占位符注入（深遍历字符串值；只替换整值中的 {{name}} 标记） */
function resolveTemplate(value, account) {
  if (typeof value === 'string') {
    return value
      .replace(/\{\{\s*token\s*\}\}/g, account?.token || '')
      .replace(/\{\{\s*refreshToken\s*\}\}/g, account?.refreshToken || '')
      .replace(/\{\{\s*uid\s*\}\}/g, account?.uid || '');
  }
  if (Array.isArray(value)) return value.map((v) => resolveTemplate(v, account));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = resolveTemplate(v, account);
    return out;
  }
  return value;
}

/** HTTP 模板请求（url/method/headers/body 均支持占位符）→ { status, text } */
async function requestTemplate(tpl, account) {
  const url = resolveTemplate(tpl.url, account);
  const method = String(tpl.method || 'POST').toUpperCase();
  const headers = resolveTemplate(tpl.headers || {}, account);
  const body = tpl.body === undefined ? undefined : resolveTemplate(tpl.body, account);
  const res = await fetch(url, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const text = await res.text();
  return { status: res.status, text };
}

/** 响应体 → JSON（非 JSON 时抛错，消息不含响应原文以外的结构信息） */
function parseJson(text) {
  try { return JSON.parse(text); }
  catch { throw new Error('响应不是 JSON'); }
}

/** okWhen / alreadyWhen 判定（equals 比较；缺省 path 时用布尔真值） */
function matches(json, rule) {
  if (!rule) return false;
  const v = pickPath(json, rule.path);
  if (rule.equals !== undefined) return v === rule.equals;
  return Boolean(v);
}

/**
 * L2 签到执行（providers 回落 impl 的 checkin）。
 * @param {object} account 账号记录（token / refreshToken / uid）
 * @param {object} def 工具定义（def.checkin 为 L2 模板；null = 不参与签到）
 * @param {object} ctx { log }（token 不打日志）
 * @returns {Promise<{status: string, claimedAmount?: number, message?: string, error?: string}>}
 */
export async function runConfiguredCheckin(account, def, ctx = {}) {
  const tpl = def?.checkin;
  if (!tpl || tpl.executor !== 'http-json' || !tpl.request?.url) {
    return { status: 'no-activity', message: '该工具未配置签到端点（待实测后激活）' };
  }
  const out = tpl.outcome || {};
  try {
    const { status: httpStatus, text } = await requestTemplate(tpl.request, account);
    const json = parseJson(text);
    if (httpStatus >= 400 && !matches(json, out.okWhen)) {
      return { status: 'failed', error: pickPath(json, out.failedMessagePath) || pickPath(json, out.messagePath) || `HTTP ${httpStatus}` };
    }
    if (matches(json, out.okWhen)) {
      const amount = Number(pickPath(json, out.amountPath));
      return {
        status: 'checked-in',
        claimedAmount: Number.isFinite(amount) ? amount : 0,
        message: pickPath(json, out.messagePath) || null,
      };
    }
    if (matches(json, out.alreadyWhen)) {
      return { status: 'already', message: pickPath(json, out.messagePath) || '今日已领' };
    }
    return {
      status: 'failed',
      error: pickPath(json, out.failedMessagePath) || pickPath(json, out.messagePath) || '响应未命中任何预期结局',
    };
  } catch (e) {
    return { status: 'failed', error: e?.message || String(e) };
  }
}

/**
 * L2 额度执行（模板的 request + outcome 映射 total/used/remaining）。
 * parts 留空：L2 不表达逐资源包明细（那是 L3 / 网页端的能力）；到期时间因此不适用于 L2 工具。
 */
export async function runConfiguredQuota(account, def, ctx = {}) {
  const tpl = def?.quota;
  if (!tpl || tpl.executor !== 'http-json' || !tpl.request?.url) {
    throw new Error('该工具未配置额度查询端点');
  }
  const out = tpl.outcome || {};
  const { text } = await requestTemplate(tpl.request, account);
  const json = parseJson(text);
  const num = (p) => { const v = Number(pickPath(json, p)); return Number.isFinite(v) ? v : null; };
  const total = num(out.totalPath);
  const used = num(out.usedPath);
  const remaining = num(out.remainingPath);
  if (total === null && used === null && remaining === null) {
    throw new Error(pickPath(json, out.failedMessagePath) || pickPath(json, out.messagePath) || '额度响应无法解析');
  }
  return {
    total: total ?? (used !== null && remaining !== null ? used + remaining : 0),
    used: used ?? 0,
    remaining: remaining ?? Math.max(0, (total ?? 0) - (used ?? 0)),
    exceeded: false,
    parts: [],
  };
}

/**
 * 回落 impl 验证：重读本机登录态（reader 重读）确认工具仍已登录，并补全身份。
 * 「userinfo 模板」为可选项：本期不配（端点未验证不编造），reader 重读已覆盖本地工具场景。
 */
async function verifyFromReader(account, def) {
  const { readCredentials } = await import('./toolReaders/index.js');
  const { records, errors } = await readCredentials(def);
  if (errors.length && !records.length) throw new Error(errors[0].error);
  const hit = records.find((r) => r.token === account.token)
    || (account.uid ? records.find((r) => r.uid === account.uid) : null)
    || (records.length === 1 ? records[0] : null);
  if (!hit) throw new Error(`未能在本机找到 ${def.name} 的登录态（请先在客户端登录后重试）`);
  return { name: hit.name || null, uid: hit.uid || null, email: hit.email || null };
}

/**
 * 由工具定义构造 providers.js 兼容的 impl（PRODUCTS miss 时的回落）。
 * checkin/quota 按配置有无提供（缺省 = 该产品不参与对应环节，与 PRODUCTS 惯例一致）。
 */
export function buildFallbackImpl(def) {
  return {
    label: def.name,
    ...(def.checkin ? { checkin: (account, ctx) => runConfiguredCheckin(account, def, ctx) } : {}),
    ...(def.quota ? { quota: (account, ctx) => runConfiguredQuota(account, def, ctx) } : {}),
    verify: (account) => verifyFromReader(account, def),
  };
}
