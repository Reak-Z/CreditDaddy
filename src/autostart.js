/**
 * 开机自启（CLI 模式）— Windows 计划任务 schtasks（当前用户级，免管理员）。
 *
 * 覆盖面（决策 D4）：桌面壳已有 app.setLoginItemSettings（托盘可设），本模块覆盖
 * 「无桌面壳的 CLI / 后台守护」场景。两套并存不冲突：任务指向 `creditdaddy start`，
 * 而 start 本身幂等（bgdaemon 已处理「已在运行」），开机重复触发无副作用。
 *
 * 选型（设计文档 4.2）：schtasks /SC ONLOGON /RL LIMITED —— 免管理员、隐藏窗口
 * （spawn windowsHide）、可查询/关闭、杀软友好；启动目录弹控制台、Windows 服务需管理员，均不选。
 *
 * 安全：任务命令只含 node 可执行文件与 CLI 入口路径，不含任何凭据。
 */

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TASK_NAME = 'CreditDaddy';
const CLI_ENTRY = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'creditdaddy.js');

// 测试后门：注入 fake exec（签名同 execFileSync，抛错 = 非零退出）。生产永远走真实 schtasks。
// 换 exec 同时清状态缓存：测试里翻转 fake 行为不必等 TTL。
let execImpl = null;
export function _setExecForTests(fn) { execImpl = fn || null; statusCache = { at: 0, value: null }; }

// 状态缓存：面板 /api/status 每 30s 轮询，不必每次 spawn schtasks；设置操作即时失效。
const STATUS_TTL_MS = 30 * 1000;
let statusCache = { at: 0, value: null };

function run(args) {
  const exec = execImpl || execFileSync;
  return exec('schtasks', args, { windowsHide: true, timeout: 10_000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

/**
 * 开机自启状态（30s 缓存；setAutostart 后立即失效）。
 * @returns {{supported: boolean, enabled: boolean, task?: string}} supported=false = 非 Windows（桌面壳走 setLoginItemSettings）
 */
export function autostartStatus() {
  if (process.platform !== 'win32') return { supported: false, enabled: false };
  if (statusCache.value && Date.now() - statusCache.at < STATUS_TTL_MS) return statusCache.value;
  let value;
  try {
    run(['/Query', '/TN', TASK_NAME, '/FO', 'CSV', '/NH']);
    value = { supported: true, enabled: true, task: TASK_NAME };
  } catch {
    value = { supported: true, enabled: false, task: TASK_NAME };
  }
  statusCache = { at: Date.now(), value };
  return value;
}

/**
 * 开 / 关开机自启（幂等：/F 覆盖创建；/Delete /F 移除）。
 * @returns {{ok: boolean, supported?: boolean, error?: string}}
 */
export function setAutostart(enabled) {
  if (process.platform !== 'win32') return { ok: true, supported: false };   // 其他平台 no-op（桌面壳自管）
  try {
    if (enabled) {
      run(['/Create', '/TN', TASK_NAME, '/SC', 'ONLOGON', '/RL', 'LIMITED', '/F',
        '/TR', `"${process.execPath}" "${CLI_ENTRY}" start`]);
    } else {
      run(['/Delete', '/TN', TASK_NAME, '/F']);
    }
    statusCache = { at: 0, value: null };   // 设置后状态缓存立即失效（面板下一帧即见新态）
    return { ok: true, supported: true };
  } catch (e) {
    // 被杀毒软件拦截等：返回错误由面板提示手动方式，不阻断其他功能（R5）
    return { ok: false, supported: true, error: e?.message || 'schtasks 执行失败' };
  }
}

export { TASK_NAME, CLI_ENTRY };
