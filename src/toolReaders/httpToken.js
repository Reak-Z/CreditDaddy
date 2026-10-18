/**
 * reader http-token — 请求本地 HTTP 服务取 token（AutoClaw 试点：智谱桌面端 18432 端口）。
 *
 * 已核实的本地事实（源自 ai-checkin/autoclaw_checkin.py 的逆向成果）：
 *   - AutoClaw 桌面端运行暴露 http://127.0.0.1:18432/get_token（GET）
 *   - 响应可能是纯文本 "Bearer xxx" / "xxx"，或 JSON {"token":…} / {"data":{"token":…}}
 *   - 配置文件里的 token 是 enc: 前缀加密串，离线不可解 —— 唯一可靠来源是运行中的桌面端
 *   - host 白名单（127.0.0.1 / localhost）在 toolRegistry 加载时强制，本 reader 不再重复信任配置
 *
 * 代理说明：Python 版曾需显式绕过 Clash（urllib 尊重 HTTP_PROXY 环境变量）；Node 原生 fetch
 * （undici）默认不读环境代理，此处直连即绕开本机代理软件，与 Python 版行为一致。
 */

import { pickPath } from './plainJson.js';

/** 常见 token 键（tokenPath 未命中时的兜底，与 autoclaw_checkin.py extract_token 同口径） */
const TOKEN_FALLBACKS = ['$.data.token', '$.data.access_token', '$.access_token'];

const asText = (v) => (typeof v === 'string' && v.trim() ? v.trim() : (typeof v === 'number' ? String(v) : null));

/**
 * 从本地 HTTP 服务读取 token（设计文档 3.1 签名）。
 * @param {object} cfg { url, timeoutMs?, tokenPath, identity?, refreshPath?, expiresPath?, provider? }
 * @returns {Promise<object|null>} CredentialRecord；取不到 token 返回 null
 * @throws 网络 / 非 2xx / 响应不可解析时抛出（消息面向用户，不含 token 本体）
 */
export async function readHttpToken(cfg) {
  const url = String(cfg.url || '');
  const timeoutMs = Number(cfg.timeoutMs) || 3000;
  let res;
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json, text/plain' },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const why = e?.name === 'TimeoutError' ? '超时' : (e?.cause?.code || e?.code || e?.message || '网络错误');
    throw new Error(`本地服务未响应（${why}）——请确认客户端已运行并登录`);
  }
  if (!res.ok) throw new Error(`本地服务返回 HTTP ${res.status}`);
  const text = (await res.text()).trim();
  if (!text) return null;

  let token = null;
  let json = null;
  const bare = text.startsWith('Bearer ') ? text.slice(7).trim() : text;
  try {
    json = JSON.parse(bare);
    if (typeof json === 'string') token = json.trim() || null;
    else if (json && typeof json === 'object') {
      token = asText(pickPath(json, cfg.tokenPath));
      if (!token) {
        for (const fb of TOKEN_FALLBACKS) {
          token = asText(pickPath(json, fb));
          if (token) break;
        }
      }
    }
  } catch {
    token = bare || null;   // 纯文本响应整体即 token
  }
  if (!token) return null;

  const id = cfg.identity || {};
  return {
    provider: cfg.provider || null,
    token,
    refreshToken: json && typeof json === 'object' ? asText(pickPath(json, cfg.refreshPath)) : null,
    expiresAt: json && typeof json === 'object' ? asText(pickPath(json, cfg.expiresPath)) : null,
    uid: json && typeof json === 'object' ? asText(pickPath(json, id.uidPath)) : null,
    name: json && typeof json === 'object' ? asText(pickPath(json, id.namePath)) : null,
    email: json && typeof json === 'object' ? asText(pickPath(json, id.emailPath)) : null,
    source: 'http-token',
    meta: {},
  };
}

/** 读取（统一 reader 入口）：失败记 errors（只含文件/URL 与错误码，不含响应内容） */
export async function read(def) {
  try {
    const rec = await readHttpToken({ ...def.credential, provider: def.provider });
    return { records: rec ? [rec] : [], errors: [] };
  } catch (e) {
    return { records: [], errors: [{ file: def.credential?.url || def.file, error: e?.message || String(e) }] };
  }
}
