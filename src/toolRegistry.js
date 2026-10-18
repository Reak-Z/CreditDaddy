/**
 * 工具注册表（F1 自动扫描的地基）— tools.d/*.json 配置驱动的工具描述加载 / 校验 / 查询。
 *
 * 与 cookieSites.js 同范式的配置驱动：新工具「加一个 JSON 即接入」，不为每个工具写代码。
 * 分层策略（见设计文档 2.1）：
 *   L1 凭据发现（读本机登录态）—— 完全配置（reader 描述），本模块 + toolReaders/* 承担
 *   L2 签到/额度请求          —— 半配置（HTTP 模板），toolCheckin.js 承担（T03）
 *   L3 复杂产品               —— 代码（{tool}Client.js 挂 PRODUCTS），本模块不涉及
 *
 * 存放位置（决策 D5）：
 *   仓库 CreditDaddy/tools.d/*.json   内置默认，随发行
 *   用户 ~/.creditdaddy/tools.d/*.json 用户覆盖，同名 id 时用户优先（本地微调不丢）
 *
 * 安全模型（红线落实）：
 *   - 加载时校验：schema 错误 / provider 与内置 14 个冲突 / http-token URL 非回环地址
 *     → 该工具标记 invalid 并跳过（fail-open per tool：一个坏配置不影响其他工具）
 *   - reader 只读本机文件与 127.0.0.1 本地端口（http-token 的 host 白名单在此强制）
 *   - token 不打日志：本模块只碰配置元数据，从不读取 token 本体
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { PROVIDERS } from './constants.js';
import { toolsDir } from './store.js';

// 仓库内置 tools.d（src/ → 仓库根）
const REPO_TOOLS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'tools.d');

/** 用户 tools.d 目录（~/.creditdaddy/tools.d；CREDITDADDY_HOME 可覆盖）——与 store.dataDir 同源 */
function userToolsDir() {
  return toolsDir();
}

const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const READER_KINDS = new Set(['plain-json', 'regex-scan', 'http-token', 'dpapi-json', 'custom']);
const PROBE_TYPES = new Set(['file', 'process']);   // 'registry'（reg query 卸载键）为 P2 预留，见 tools.d/README.md
const MODULE_RE = /^[A-Za-z0-9_-]+$/;               // custom reader 模块名：拒绝路径穿越

/**
 * 校验单个工具定义（手写校验，不引依赖）。返回错误数组，空 = 通过。
 * 同步纯函数：供测试与加载路径共用；provider 与内置产品冲突也在此判定（R4：冲突即拒）。
 */
export function validateToolDef(def) {
  if (!def || typeof def !== 'object' || Array.isArray(def)) return ['工具定义必须是 JSON 对象'];
  const errs = [];
  const str = (v) => typeof v === 'string' && v.trim();

  // ── 标识 ──
  if (!str(def.id) || !ID_RE.test(def.id)) errs.push('id 必填：小写字母/数字/连字符（最长 64，如 autoclaw）');
  if (!str(def.provider) || !ID_RE.test(def.provider)) errs.push('provider 必填：小写字母/数字/连字符');
  else if (PROVIDERS.includes(def.provider)) errs.push(`provider "${def.provider}" 与内置产品冲突（冲突即拒，不静默覆盖）`);
  if (!str(def.name)) errs.push('name 必填（展示名）');
  if (!str(def.vendor)) errs.push('vendor 必填（厂商）');
  if (def.enabled !== undefined && typeof def.enabled !== 'boolean') errs.push('enabled 必须是布尔值');
  if (def.platforms !== undefined) {
    if (!Array.isArray(def.platforms) || def.platforms.some((p) => typeof p !== 'string')) errs.push('platforms 必须是字符串数组（如 ["win32"]）');
  }

  // ── 能力 ──
  const cap = def.capabilities;
  if (!cap || typeof cap !== 'object' || Array.isArray(cap)) errs.push('capabilities 必填：{ discover, checkin, quota } 三个布尔');
  else for (const k of ['discover', 'checkin', 'quota']) {
    if (typeof cap[k] !== 'boolean') errs.push(`capabilities.${k} 必须是布尔值`);
  }

  // ── 探测（installed / running 各自可缺省）──
  for (const key of ['installed', 'running']) {
    const probes = def.detect?.[key];
    if (probes === undefined) continue;
    if (!Array.isArray(probes)) { errs.push(`detect.${key} 必须是探测数组`); continue; }
    for (const pr of probes) {
      if (!pr || typeof pr !== 'object' || !PROBE_TYPES.has(pr.type)) { errs.push(`detect.${key} 的 type 必须是 file / process`); continue; }
      if (pr.type === 'file' && !str(pr.path)) errs.push(`detect.${key} 的 file 探测需要 path（支持 %APPDATA% 等占位符）`);
      if (pr.type === 'process') {
        const exes = Array.isArray(pr.exe) ? pr.exe : [pr.exe];
        if (!exes.length || exes.some((e) => !str(e))) errs.push(`detect.${key} 的 process 探测需要 exe（字符串或字符串数组）`);
      }
    }
  }

  // ── 凭据 reader ──
  const cred = def.credential;
  if (!cred || typeof cred !== 'object' || Array.isArray(cred)) { errs.push('credential 必填：{ reader, ...reader 私有参数 }'); }
  else if (!READER_KINDS.has(cred.reader)) errs.push(`credential.reader 必须是 ${[...READER_KINDS].join(' / ')}`);
  else errs.push(...validateCredential(cred));

  // ── 翻日时点 / L2 模板 ──
  if (def.dayRefreshHourUtc8 !== undefined) {
    const h = def.dayRefreshHourUtc8;
    if (!Number.isInteger(h) || h < 0 || h > 23) errs.push('dayRefreshHourUtc8 必须是 0-23 的整数');
  }
  for (const key of ['checkin', 'quota']) {
    if (def[key] === undefined || def[key] === null) continue;
    if (typeof def[key] !== 'object' || Array.isArray(def[key])) { errs.push(`${key} 必须是对象或 null`); continue; }
    if (!str(def[key].executor)) errs.push(`${key}.executor 必填（如 http-json）`);
  }
  return errs;
}

/** reader 私有参数校验（按类型） */
function validateCredential(cred) {
  const errs = [];
  const str = (v) => typeof v === 'string' && v.trim();
  switch (cred.reader) {
    case 'plain-json':
    case 'dpapi-json': {
      if (!Array.isArray(cred.files) || !cred.files.length) errs.push(`${cred.reader} 需要 files:[{path, platform?}]`);
      else for (const f of cred.files) {
        if (!f || typeof f !== 'object' || !str(f.path)) errs.push(`${cred.reader} 的 files 每项需要 path`);
        if (f?.platform !== undefined && typeof f.platform !== 'string') errs.push('files[].platform 必须是字符串');
      }
      if (!str(cred.tokenPath)) errs.push(`${cred.reader} 需要 tokenPath（$. 路径）`);
      break;
    }
    case 'regex-scan': {
      if (!Array.isArray(cred.dirs) || !cred.dirs.length) errs.push('regex-scan 需要 dirs:[{path, platform?}]');
      else for (const d of cred.dirs) {
        if (!d || typeof d !== 'object' || !str(d.path)) errs.push('regex-scan 的 dirs 每项需要 path');
      }
      if (!str(cred.pattern)) errs.push('regex-scan 需要 pattern（正则字符串）');
      else { try { new RegExp(cred.pattern); } catch (e) { errs.push(`regex-scan 的 pattern 不是合法正则:${e.message}`); } }
      break;
    }
    case 'http-token': {
      if (!str(cred.url)) { errs.push('http-token 需要 url'); break; }
      let u;
      try { u = new URL(cred.url); } catch { errs.push(`http-token 的 url 无法解析:${cred.url}`); break; }
      // 本地端口白名单（安全设计 #4）：只允许回环地址，防配置把 token 发去远端
      if (u.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(u.hostname)) {
        errs.push(`http-token 的 url 只允许 http://127.0.0.1|localhost 本地端口（当前 ${cred.url}）`);
      }
      if (!str(cred.tokenPath)) errs.push('http-token 需要 tokenPath（$. 路径）');
      break;
    }
    case 'custom': {
      // custom = 逃逸舱口：动态 import src/toolReaders/impl/{id}.js，module 可显式指定
      if (cred.module !== undefined && (!str(cred.module) || !MODULE_RE.test(cred.module))) {
        errs.push('custom 的 module（指定时）只能是字母/数字/连字符/下划线');
      }
      break;
    }
  }
  return errs;
}

/** 归一化：补默认值，供查询方无条件读取 */
function normalizeDef(def, file) {
  const cap = def.capabilities || {};
  const probe = (list) => (Array.isArray(list) ? list : []);
  return {
    id: def.id,
    provider: def.provider,
    product: def.product || def.provider,
    name: def.name,
    vendor: def.vendor,
    enabled: def.enabled !== false,
    platforms: Array.isArray(def.platforms) ? def.platforms.filter((p) => typeof p === 'string') : [],
    capabilities: { discover: cap.discover === true, checkin: cap.checkin === true, quota: cap.quota === true },
    detect: { installed: probe(def.detect?.installed), running: probe(def.detect?.running) },
    credential: def.credential,
    dayRefreshHourUtc8: Number.isInteger(def.dayRefreshHourUtc8) ? def.dayRefreshHourUtc8 : 0,
    checkin: def.checkin || null,
    quota: def.quota || null,
    file,   // 来源文件（错误信息「检查过哪些路径」用）
  };
}

// ─── 加载 / 缓存 / 热重载 ───

let defs = [];            // 已校验加载的工具定义
let lastErrors = [];      // 上次加载的跳过项 { file, error }
let loaded = false;
let loadPromise = null;

async function listJsonFiles(dir) {
  let names;
  try { names = await fsp.readdir(dir); } catch { return []; }   // 目录不存在 = 没有配置
  return names.filter((n) => n.endsWith('.json')).sort().map((n) => path.join(dir, n));
}

async function doLoad() {
  // 仓库先、用户目录后：Map 按 id 覆盖 → 同名 id 用户优先（D5）
  const files = [...await listJsonFiles(REPO_TOOLS_DIR), ...await listJsonFiles(userToolsDir())];
  const byId = new Map();
  const errors = [];
  for (const file of files) {
    let raw;
    try { raw = JSON.parse(await fsp.readFile(file, 'utf8')); }
    catch (e) { errors.push({ file, error: `JSON 解析失败:${e.message}` }); continue; }
    const errs = validateToolDef(raw);
    if (errs.length) { errors.push({ file, error: errs.join('；') }); continue; }
    byId.set(raw.id, normalizeDef(raw, file));   // 用户目录后写 → 覆盖仓库同名（R2：坏配置只跳过该工具）
  }
  defs = [...byId.values()];
  lastErrors = errors;
  loaded = true;
  return defs;
}

/** 加载工具定义（首次读盘，之后走缓存）。daemon 启动 / CLI 扫描前调用。 */
export async function loadToolDefs() {
  if (loaded) return defs;
  if (!loadPromise) {
    loadPromise = doLoad().finally(() => { loadPromise = null; });
  }
  return loadPromise;
}

/** 热重载 tools.d（面板「重载工具」/ CLI），返回加载条数 */
export async function reloadToolDefs() {
  loaded = false;
  defs = await doLoad();
  return defs.length;
}

// ─── 同步查询（读缓存；未加载时返回空，由调用方决定是否先 await loadToolDefs）──

/** 全部已加载定义（含 disabled / 平台不符的，供管理界面展示） */
export function toolDefs() { return defs; }

/** 参与扫描与调度的定义：enabled 且平台匹配（platforms 缺省 = 全平台） */
export function activeToolDefs() {
  return defs.filter((d) => d.enabled && (!d.platforms.length || d.platforms.includes(process.platform)));
}

export function toolById(id) { return defs.find((d) => d.id === id) || null; }
export function toolForProvider(provider) { return defs.find((d) => d.provider === provider) || null; }

/** 注册表动态 provider 清单（constants.allProviders 合并用） */
export function registryProviders() { return defs.map((d) => d.provider); }

/** 注册表工具的翻日时点（checkin.dayKey 回落用；未加载 / 未登记返回 undefined） */
export function registryDayRefreshHour(provider) {
  const d = toolForProvider(provider);
  return d ? d.dayRefreshHourUtc8 : undefined;
}

/** 上次加载被跳过的配置（面板 / CLI 展示「哪个工具配置坏了」） */
export function registryLoadErrors() { return lastErrors; }

/** 用户 tools.d 目录路径（daemon / CLI 提示用） */
export function userToolsDirPath() { return userToolsDir(); }

/** 仓库内置 tools.d 目录路径（文档 / 测试用） */
export function repoToolsDirPath() { return REPO_TOOLS_DIR; }

// 供测试：探测路径的 %APPDATA% 等占位符展开（与 detect 探测、reader 文件路径共用）
export function expandEnvPath(p) {
  return String(p).replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (m, name) => {
    const v = process.env[name];
    return v === undefined ? m : v;
  });
}

/** 文件是否存在（探测 / reader 共用） */
export function pathExists(p) {
  try { return fs.existsSync(p); } catch { return false; }
}

/** 家目录（探测路径兜底展开用） */
export function homeDir() { return os.homedir(); }
