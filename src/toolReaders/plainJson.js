/**
 * reader plain-json — 明文 JSON 会话文件（WorkBuddy 型）。
 *
 * 配置（def.credential）：
 *   files:    [{ path, platform? }]   会话文件路径（支持 %APPDATA% 等占位符；platform 缺省全平台）
 *   tokenPath: "$.token"              取 token 的 $. 路径
 *   identity: { uidPath?, namePath?, emailPath? }
 *   history:  true                    同目录其它 *.json 也当会话文件读（当前会话 + 历史会话）
 *
 * 会话文件形状：单个 JSON 对象，或 JSON 数组（每个元素一个会话）都支持；
 * history:true 时数组元素逐条产出记录（WorkBuddy 历史会话型）。
 */

import fsp from 'node:fs/promises';
import path from 'node:path';

/** %APPDATA% 等环境变量占位符展开（各 reader 各自持一份，保持模块零耦合） */
function expandEnvPath(p) {
  return String(p).replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (m, name) => {
    const v = process.env[name];
    return v === undefined ? m : v;
  });
}

/** $.a.b 路径取值（纯函数，无依赖）；数组下标用 $.list.0.id 形式 */
export function pickPath(obj, expr) {
  if (!expr) return undefined;
  const parts = String(expr).replace(/^\$\.?/, '').split('.').filter(Boolean);
  let cur = obj;
  for (const k of parts) {
    if (cur === null || cur === undefined) return undefined;
    cur = Array.isArray(cur) ? cur[Number(k)] : cur[k];
  }
  return cur;
}

const asText = (v) => (typeof v === 'string' && v.trim() ? v.trim() : (typeof v === 'number' ? String(v) : null));

/** 从单个会话对象提取凭据记录；token 为空返回 null */
function recordFrom(def, session) {
  const cred = def.credential;
  const token = asText(pickPath(session, cred.tokenPath));
  if (!token) return null;
  const id = cred.identity || {};
  return {
    provider: def.provider,
    token,
    refreshToken: asText(pickPath(session, cred.refreshPath)) || null,
    expiresAt: asText(pickPath(session, cred.expiresPath)) || null,
    uid: asText(pickPath(session, id.uidPath)) || null,
    name: asText(pickPath(session, id.namePath)) || null,
    email: asText(pickPath(session, id.emailPath)) || null,
    source: 'local-app',
    meta: {},
  };
}

async function readJsonFile(file) {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')); }
  catch (e) {
    if (e.code === 'ENOENT') return { __missing: true };
    throw e;
  }
}

/**
 * 读取（统一 reader 入口）。
 * 文件缺失记 errors（「检查过哪些路径」自查用，R1 缓解）；解析失败记 errors 不抛。
 */
export async function read(def) {
  const cred = def.credential;
  const records = [];
  const errors = [];
  const seen = new Set();

  const addSessions = (parsed, file) => {
    const sessions = Array.isArray(parsed) ? parsed : [parsed];
    for (const s of sessions) {
      if (!s || typeof s !== 'object') continue;
      const rec = recordFrom(def, s);
      if (!rec || seen.has(rec.token)) continue;
      seen.add(rec.token);
      records.push({ ...rec, meta: { ...rec.meta, file } });
    }
  };

  for (const entry of cred.files || []) {
    if (entry.platform && entry.platform !== process.platform) continue;
    const file = expandEnvPath(entry.path);
    let parsed;
    try { parsed = await readJsonFile(file); }
    catch (e) { errors.push({ file, error: `读取失败:${e.message}` }); continue; }
    if (parsed?.__missing) { errors.push({ file, error: '文件不存在（客户端未安装或未登录）' }); continue; }
    addSessions(parsed, file);
    // history: 同目录其它 *.json 也当会话文件（当前会话之外的历史登录）
    if (cred.history === true) {
      let names = [];
      try { names = await fsp.readdir(path.dirname(file)); } catch { names = []; }
      for (const n of names.sort()) {
        if (!n.endsWith('.json') || path.join(path.dirname(file), n) === file) continue;
        let extra;
        try { extra = await readJsonFile(path.join(path.dirname(file), n)); } catch { continue; }
        if (extra?.__missing) continue;
        addSessions(extra, path.join(path.dirname(file), n));
      }
    }
  }
  return { records, errors };
}
