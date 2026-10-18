/**
 * CreditDaddy 常量 — 支持的产品线与 Qoder 官方 OpenAPI 端点（WorkBuddy 端点见 workbuddyClient.js）。
 *
 * 端点与请求头结构来自社区逆向成果（10router 项目实测可用）：
 *   openapi.qoder.sh      国际版：活动/签到、userinfo、配额、PAT 兑换
 *   openapi.qoder.com.cn  国内版：同上
 *
 * ⚠️ 非官方接口，Qoder 调整服务端时可能失效。
 */

import { readFileSync } from 'node:fs';
// 工具注册表（tools.d 配置驱动）：动态 provider 与 productOf 回落。
// 依赖方向为 constants → toolRegistry →（store / constants），全部在函数体内使用，
// 模块加载期无跨模块执行，不存在循环初始化问题。
import { registryProviders, toolForProvider } from './toolRegistry.js';

export const OPENAPI_BASE = 'https://openapi.qoder.sh';
export const CN_OPENAPI_BASE = 'https://openapi.qoder.com.cn';

// 网页端（账号设置 → 用量明细）同源 API：逐资源包明细只在这里提供，且只认浏览器登录后的会话 Cookie。
export const WEB_BASE = 'https://qoder.com';
export const CN_WEB_BASE = 'https://qoder.cn';

export const LOGIN_URL = 'https://qoder.com/device/selectAccounts';
export const CN_LOGIN_URL = 'https://qoder.cn/device/selectAccounts';

// 活动（签到）列表与领取
export const CAMPAIGNS_PATH = '/sash/api/v1/me/campaigns?clientType=10';
export const CAMPAIGN_CLAIM_PATH = (id) => `/sash/api/v1/me/campaigns/${encodeURIComponent(id)}/claim`;

// 账号信息与配额
export const USERINFO_PATH = '/api/v1/userinfo';
export const QUOTA_USAGE_PATH = '/api/v2/quota/usage';
// 网页端逐资源包用量明细（plan / 个人资源包 / 组织资源包，含每包到期时间）。
// 仅接受浏览器登录的会话 Cookie（dt- / jt- token 一律 401），见 qoderClient.fetchUsageDetail。
export const WEB_USAGE_PATH = '/api/v2/me/usages/big_model_credits';

// PAT (pt-...) → 短期 job token (jt-...) 兑换（普通 JSON POST，无需 COSY 签名）
export const JOB_TOKEN_EXCHANGE_PATH = '/api/v1/jobToken/exchange';

// 账号的 provider = 产品 + 区域。新增产品时在此登记，并在 providers.js 挂上对应实现。
export const PROVIDERS = ['qoder', 'qoder-cn', 'workbuddy', 'workbuddy-intl', 'zcode', 'mirasim', 'catpaw', 'trae', 'minimax', 'tokenharbor', 'xiaomi-mimo', 'river', 'modelscope', 'longcat'];
/**
 * 全部合法 provider：内置 14 个 + 工具注册表动态项（tools.d 配置驱动的新工具）。
 * store.normalizeAccountInput 的校验改用它——注册表未加载时动态项为空（退化为内置清单）。
 */
export function allProviders() {
  return [...PROVIDERS, ...registryProviders()];
}
export const PROVIDER_LABEL = {
  qoder: 'Qoder 国际版',
  'qoder-cn': 'Qoder 国内版',
  workbuddy: 'WorkBuddy 国内版',
  'workbuddy-intl': 'WorkBuddy 国际版',
  zcode: 'ZCode',
  mirasim: 'mirasim',
  catpaw: '妙手',
  trae: 'Trae',
  minimax: 'MiniMax',
  tokenharbor: 'Token Harbor',
  'xiaomi-mimo': '小米 MiMo',
  river: 'River AI',
  modelscope: 'ModelScope 魔搭',
  longcat: 'LongCat',
};
/** provider → 产品线（qoder / workbuddy / zcode / mirasim / catpaw / trae / minimax / tokenharbor / xiaomi-mimo / river）
 *  查表 miss 时回落工具注册表（tools.d）：注册表工具一般 provider 即产品线（autoclaw → autoclaw）；
 *  注册表未加载 / 未登记时保持原有默认（qoder），行为不回归。 */
export const productOf = (provider) => {
  const p = String(provider);
  if (p.startsWith('workbuddy')) return 'workbuddy';
  if (p.startsWith('zcode')) return 'zcode';
  if (p === 'mirasim') return 'mirasim';
  if (p === 'catpaw') return 'catpaw';
  if (p.startsWith('trae')) return 'trae';
  if (p === 'minimax') return 'minimax';
  if (p === 'tokenharbor') return 'tokenharbor';
  if (p === 'xiaomi-mimo') return 'xiaomi-mimo';
  if (p === 'river') return 'river';
  if (p === 'modelscope') return 'modelscope';
  if (p === 'longcat') return 'longcat';
  const def = toolForProvider(p);
  if (def) return def.product || def.provider;
  return 'qoder';
};
/** provider 是否国内版 */
export const isCnProvider = (provider) => provider === 'qoder-cn' || provider === 'workbuddy';

/** Qoder 网页端同源 API 的 host（用量明细逐资源包接口在这里，只认浏览器会话 Cookie） */
export function webBase(provider) {
  return provider === 'qoder-cn' ? CN_WEB_BASE : WEB_BASE;
}

/** 签到请求头（源自 10router qoderCheckin.js，clientType=10 与官方客户端一致） */
export function buildQoderHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    'Cosy-ClientType': '10',
    'Cosy-Version': '0.3.3',
    'Cosy-MachineOS':
      process.platform === 'win32' ? 'windows'
        : process.platform === 'darwin' ? 'macos' : 'linux',
    'User-Agent': 'Qoder',
    Accept: 'application/json',
  };
}

/** PAT 兑换请求头（源自 10router qoderModels.js，模拟官方 qodercli） */
export function buildExchangeHeaders() {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'User-Agent': 'qodercli/1.0.0',
    'Cosy-Version': '1.0.0',
    'Cosy-ClientType': '5',
  };
}

export const FETCH_TIMEOUT_MS = 15000;

// 版本号 / 项目主页以 package.json 为唯一来源（桌面版 / fpk 打包时都会一并拷入 package.json）
const PKG = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
export const APP_VERSION = PKG.version;
export const PROJECT_URL = PKG.homepage || 'https://github.com/techysy/CreditDaddy';
