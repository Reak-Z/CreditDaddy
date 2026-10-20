/**
 * Windows 进程探测的公共实现。
 *
 * `tasklist.exe` 的输出跟随控制台代码页：中文系统上是 GBK，按 latin1/utf8 解码会得到乱码，
 * 于是「没有运行的任务」那行匹配不上 → 探测函数把「进程不存在」误判成「正在运行」。
 * （曾经真的踩过：qoderApp 用 latin1，中文 Windows 上 qoderRunning() 恒为 true，
 *  导致切换永远报「Qoder 正在运行」，强制切换还会空等 11 秒。）
 * 统一走这里，避免每个产品各写一份、各错一种。
 */

import { execFileSync } from 'node:child_process';

/** tasklist 的 Buffer 输出 → 字符串（GBK 优先，解码器不可用时退回 utf8） */
export function decodeTasklist(buf) {
  try { return new TextDecoder('gbk').decode(buf); } catch { return buf.toString('utf8'); }
}

/** tasklist 在「无匹配」时输出的那行（各语言版本） */
const NO_TASKS = /No Tasks|没有运行的任务|没有找到|没有任务/i;

// 全量进程表快照（短 TTL 内存缓存）：一次 tasklist 拿全部进程名，本地匹配任意 exe 集合。
// 为什么需要它：Trae 探测有 4 个 exe 变体，旧实现逐个 tasklist（4 次同步外部调用串行），
// 叠加 mirasim / 妙手 / MiniMax 各一次，守护进程与 Electron 主进程同事件循环时
// /api/status 单次要同步阻塞数秒（实测沙箱 8.8s）——窗口拖动/点击全被卡住。
// 现在一次全量查询 + 1.5s 缓存：同一轮状态内的所有 Running 探测共享这一次调用。
const PROC_LIST_TTL_MS = 1500;
let procListCache = { at: 0, names: null };

/** 全量进程名快照（小写 Set；命令失败不缓存，下次重试） */
function tasklistNames() {
  if (procListCache.names && Date.now() - procListCache.at < PROC_LIST_TTL_MS) return procListCache.names;
  if (process.platform !== 'win32') return null;
  let names = null;
  try {
    const out = decodeTasklist(execFileSync('tasklist.exe', ['/NH', '/FO', 'CSV'],
      { windowsHide: true, encoding: 'buffer', timeout: 8000 }));
    names = new Set();
    for (const line of out.split(/\r?\n/)) {
      const m = line.match(/^\s*"?([^",]+\.exe)"?\s*,/i);   // CSV 第一列 = 映像名
      if (m) names.add(m[1].toLowerCase());
    }
  } catch { return null; }   // 失败不过缓存（下次重试），按「没在运行」处理
  procListCache = { at: Date.now(), names };
  return names;
}

/**
 * 任一 exe 是否在运行（全量进程表单次查询 + 1.5s 缓存，与 anyProcRunning 同语义）。
 * 查询失败（命令不存在 / 超时）一律按「没在运行」处理，不阻塞调用方。
 * @param {string|string[]} exes
 * @returns {boolean}
 */
export function anyProcRunningFast(exes) {
  const names = tasklistNames();
  if (!names) return false;
  return [].concat(exes).some((e) => names.has(String(e).toLowerCase()));
}

/**
 * 任一 exe 是否在运行（逐名 tasklist 的旧路径：单名探测 / 测试直控）。
 * 新代码优先 anyProcRunningFast（一次查全部）；本函数保留给「只查一个」且要求
 * 立即可见（不享 1.5s 缓存）的场景。
 * @param {string|string[]} exes
 * @returns {boolean} 查不到（命令不存在 / 超时）一律按「没在运行」处理，不阻塞调用方
 */
export function anyProcRunning(exes) {
  if (process.platform !== 'win32') return false;
  for (const exe of [].concat(exes)) {
    try {
      const out = decodeTasklist(execFileSync('tasklist.exe', ['/FI', `IMAGENAME eq ${exe}`, '/NH'],
        { windowsHide: true, encoding: 'buffer', timeout: 8000 }));
      if (!NO_TASKS.test(out)) return true;
    } catch { /* 查不到就换下一名 */ }
  }
  return false;
}
