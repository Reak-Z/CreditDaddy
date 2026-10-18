/**
 * 本机检测 — 安装探测 + 凭据扫描（Qoder 基座 + 工具注册表泛化）。
 *
 * Qoder IDE 是 VS Code 系（Electron），凭据散落在 userData 目录；
 * 另扫 ~/.qoder（CLI）。扫描纯本地进行，候选 token 只保留在内存，
 * 面板按 candidateId 导入，token 不在日志中输出。
 *
 * 注册表泛化（F1）：detectToolInstalls(defs) 按 tools.d 的 probe 描述探测
 * 任意工具的安装/运行状态；scanLocalTokens 的正则参数化后供 regex-scan reader 复用。
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { anyProcRunning } from './winProc.js';
import { expandEnvPath } from './toolRegistry.js';

// 候选内存表：candidateId → { token, file?, provider?, user?, refreshToken?, expiresAt?, at }（10 分钟过期）
const candidates = new Map();
const CAND_TTL_MS = 10 * 60 * 1000;

const TOKEN_RE = /\b(?:dt|pt)-[A-Za-z0-9_-]{16,}\b/g;

/** 纯函数：提取文本中的 token（去重）——供测试；pattern 缺省为 Qoder dt-/pt- 形态 */
export function extractTokens(text, pattern) {
  const re = pattern ? new RegExp(pattern, 'g') : TOKEN_RE;
  const found = new Set();
  let m;
  re.lastIndex = 0;
  while ((m = re.exec(String(text))) !== null) found.add(m[0]);
  return [...found];
}

function mask(token) {
  return token.slice(0, 5) + '...' + token.slice(-4);
}

function isWindows() { return process.platform === 'win32'; }
function isMac() { return process.platform === 'darwin'; }

/** 安装探测：IDE 可执行文件 + CLI */
export function detectInstalls() {
  const home = os.homedir();
  const appdata = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files';

  const idePaths = isMac()
    ? ['/Applications/Qoder.app']
    : isWindows()
      ? [
          path.join(localAppData, 'Programs', 'Qoder', 'Qoder.exe'),
          path.join(programFiles, 'Qoder', 'Qoder.exe'),
        ]
      : ['/usr/bin/qoder', '/opt/Qoder/qoder', '/usr/share/qoder/qoder'];

  const ideDataDirs = isMac()
    ? [path.join(home, 'Library', 'Application Support', 'Qoder')]
    : isWindows()
      ? [path.join(appdata, 'Qoder')]
      : [path.join(home, '.config', 'Qoder')];

  const exists = (p) => { try { return fs.existsSync(p); } catch { return false; } };

  return {
    platform: process.platform,
    ide: idePaths.map((p) => ({ path: p, exists: exists(p) })),
    ideDataDirs: ideDataDirs.map((p) => ({ path: p, exists: exists(p) })),
    cliDir: { path: path.join(home, '.qoder'), exists: exists(path.join(home, '.qoder')) },
    installed: idePaths.some((p) => exists(p)),
  };
}

/** 注册表工具的安装/运行探测（tools.d 的 probe 描述泛化；file 支持 %APPDATA% 占位符）。
 *  返回 [{ id, provider, name, vendor, installed, running, probes:[{group,type,target,hit}] }]；
 *  installed/running 各自「任一命中即真」，probes 供面板展示检查过哪些位置（R1 自查）。 */
export function detectToolInstalls(defs) {
  const pathExists = (p) => { try { return fs.existsSync(p); } catch { return false; } };
  const evalProbe = (pr, group) => {
    if (!pr || typeof pr !== 'object') return null;
    if (pr.type === 'file') {
      const target = expandEnvPath(pr.path);
      return { group, type: 'file', target, hit: pathExists(target) };
    }
    if (pr.type === 'process') {
      const exes = (Array.isArray(pr.exe) ? pr.exe : [pr.exe]).filter((e) => typeof e === 'string' && e.trim());
      return { group, type: 'process', target: exes.join(' / '), hit: exes.length ? anyProcRunning(exes) : false };
    }
    return null;
  };
  return (defs || []).map((def) => {
    const probes = [];
    let installed = false;
    let running = false;
    for (const pr of def.detect?.installed || []) {
      const r = evalProbe(pr, 'installed');
      if (!r) continue;
      probes.push(r);
      if (r.hit) installed = true;
    }
    for (const pr of def.detect?.running || []) {
      const r = evalProbe(pr, 'running');
      if (!r) continue;
      probes.push(r);
      if (r.hit) running = true;
    }
    return { id: def.id, provider: def.provider, name: def.name, vendor: def.vendor, installed, running, probes };
  });
}

// 扫描时跳过的目录（缓存/噪音）
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'Cache', 'CachedData', 'CacheStorage', 'Code Cache',
  'GPUCache', 'logs', 'Crashes', 'crashpad', 'blob_storage', 'Service Worker',
  'History', 'DawnGraphiteCache', 'DawnWebGPUCache', 'SharedDictionary',
  'index', 'tmp', 'temp', 'workspaceStorage',
]);

const MAX_FILE_BYTES = 1.5 * 1024 * 1024;
const MAX_FILES = 4000;
const MAX_MS = 6000;

/** 扫描目录集合，产出候选 token（含少量上下文以辅助辨认）。
 *  opts.pattern：自定义正则（regex-scan reader 用）；缺省为 Qoder dt-/pt- 形态（行为不变）。
 *  opts.kind：自定义命中分类标签（缺省按 pt- 前缀判 PAT，否则 device）。 */
export async function scanLocalTokens(dirs, { pattern, kind } = {}) {
  const deadline = Date.now() + MAX_MS;
  const found = new Map(); // token → { file, count }
  let scanned = 0;

  async function walk(dir, depth) {
    if (depth > 5 || scanned >= MAX_FILES || Date.now() > deadline) return;
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (scanned >= MAX_FILES || Date.now() > deadline) return;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) await walk(p, depth + 1);
        continue;
      }
      let st;
      try { st = await fsp.stat(p); } catch { continue; }
      if (!st.isFile() || st.size === 0 || st.size > MAX_FILE_BYTES) continue;
      scanned++;
      let text;
      try { text = await fsp.readFile(p, 'utf8'); } catch { continue; }
      for (const token of extractTokens(text, pattern)) {
        const prev = found.get(token);
        if (prev) prev.count++;
        else found.set(token, { file: p, count: 1 });
      }
    }
  }

  for (const d of dirs) {
    try { if (fs.existsSync(d) && fs.statSync(d).isDirectory()) await walk(d, 0); } catch {}
  }

  const list = [];
  for (const [token, meta] of found) {
    const id = putCandidate({ token, file: meta.file });
    list.push({
      id,
      tokenMasked: mask(token),
      kind: token.startsWith('pt-') ? 'PAT' : (kind || 'device'),
      file: meta.file,
      hits: meta.count,
    });
  }
  list.sort((a, b) => b.hits - a.hits);
  return { scanned, candidates: list.slice(0, 50) };
}

/** 放入候选表（带 TTL），返回 candidateId。c 至少含 token，可带 provider / user / refreshToken / expiresAt */
export function putCandidate(c) {
  const now = Date.now();
  for (const [k, v] of candidates) if (v.at < now - CAND_TTL_MS) candidates.delete(k);
  const id = crypto.createHash('sha256').update(c.token).digest('hex').slice(0, 16);
  candidates.set(id, { ...c, at: now });
  return id;
}

/** 按 candidateId 读取候选（不会消费掉，导入前可反复查询）；过期返回 null */
export function peekCandidate(id) {
  const c = candidates.get(id);
  if (!c) return null;
  if (c.at < Date.now() - CAND_TTL_MS) { candidates.delete(id); return null; }
  return c;
}
