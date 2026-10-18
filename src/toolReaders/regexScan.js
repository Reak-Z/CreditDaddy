/**
 * reader regex-scan — 目录树正则扫 token（旧版 VS Code 系 IDE 型，Qoder dt-/pt- 的泛化）。
 *
 * 配置（def.credential）：
 *   dirs:   [{ path, platform? }]   扫描目录（支持 %APPDATA% 占位符）
 *   pattern: "\\b(?:dt|pt)-[A-Za-z0-9_-]{16,}\\b"   正则（字符串，加载时已校验可编译）
 *   kind:   "device"                命中分类标签（device / PAT / …，回给面板展示）
 *   maxFiles?/maxBytes?/maxMs?      扫描预算（缺省沿用 localDetect 口径）
 *
 * 与 localDetect.scanLocalTokens 的关系：**独立实现**（不复用其函数）——那边只服务 Qoder
 * legacy 链路且硬编码 dt-/pt- 正则；本 reader 的策略（预算数值、SKIP_DIRS 名单）与其逐项
 * 对齐，改一边时同步核对另一边（QA 实测一致）。
 * 命中只产出记录（provider 为空），候选入内存表与「provider 归属由用户导入时选」由 daemon
 * 层完成（与旧版 Qoder IDE 扫描同链路）。
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

/** 与 localDetect.js 一致的跳过目录（缓存/噪音） */
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'Cache', 'CachedData', 'CacheStorage', 'Code Cache',
  'GPUCache', 'logs', 'Crashes', 'crashpad', 'blob_storage', 'Service Worker',
  'History', 'DawnGraphiteCache', 'DawnWebGPUCache', 'SharedDictionary',
  'index', 'tmp', 'temp', 'workspaceStorage',
]);
const DEFAULT_MAX_FILES = 4000;
const DEFAULT_MAX_BYTES = 1.5 * 1024 * 1024;
const DEFAULT_MAX_MS = 6000;

function expandEnvPath(p) {
  return String(p).replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (m, name) => {
    const v = process.env[name];
    return v === undefined ? m : v;
  });
}

/** 目录树扫描（带预算）：token → { file, count } */
async function walk(dir, re, opts, found, state, depth = 0) {
  if (depth > 5 || state.scanned >= opts.maxFiles || Date.now() > state.deadline) return;
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (state.scanned >= opts.maxFiles || Date.now() > state.deadline) return;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) await walk(p, re, opts, found, state, depth + 1);
      continue;
    }
    let st;
    try { st = await fsp.stat(p); } catch { continue; }
    if (!st.isFile() || st.size === 0 || st.size > opts.maxBytes) continue;
    state.scanned++;
    let text;
    try { text = await fsp.readFile(p, 'utf8'); } catch { continue; }
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      const token = m[0];
      const prev = found.get(token);
      if (prev) prev.count++;
      else found.set(token, { file: p, count: 1 });
    }
  }
}

/** 读取（统一 reader 入口）：产出 provider 为空的记录，provider 由用户导入时选择 */
export async function read(def) {
  const cred = def.credential;
  const records = [];
  const errors = [];
  const found = new Map();
  const state = { scanned: 0, deadline: Date.now() + (Number(cred.maxMs) || DEFAULT_MAX_MS) };
  const opts = {
    maxFiles: Number(cred.maxFiles) || DEFAULT_MAX_FILES,
    maxBytes: Number(cred.maxBytes) || DEFAULT_MAX_BYTES,
  };
  let re;
  try { re = new RegExp(cred.pattern, 'g'); } catch (e) { return { records: [], errors: [{ file: def.file, error: `正则不可用:${e.message}` }] }; }

  let anyDir = false;
  for (const d of cred.dirs || []) {
    if (d.platform && d.platform !== process.platform) continue;
    const dir = expandEnvPath(d.path);
    try {
      if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) { anyDir = true; await walk(dir, re, opts, found, state); }
    } catch { /* 单个目录不可读不影响其他目录 */ }
  }
  if (!anyDir) errors.push({ file: def.file, error: '没有可扫描的目录（客户端未安装）' });

  for (const [token, meta] of found) {
    records.push({
      provider: null,   // 归属由用户导入时选（与旧版 Qoder IDE 扫描同语义）
      token,
      source: 'local-scan',
      meta: { file: meta.file, kind: cred.kind || 'device', hits: meta.count },
    });
  }
  records.sort((a, b) => (b.meta.hits || 0) - (a.meta.hits || 0));
  return { records: records.slice(0, 50), errors, scanned: state.scanned };
}
