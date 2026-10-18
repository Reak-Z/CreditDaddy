# tools.d — 工具注册表（配置驱动接入）

本目录的每个 `*.json` 描述一个 AI 工具：**装在哪、登录态在哪读、怎么签到、怎么查额度**。
加一个 JSON 即接入一个新工具，不需要改代码（配置驱动范式与 `src/cookieSites.js` 一致）。

## 存放位置与覆盖语义（决策 D5）

| 位置 | 作用 |
|------|------|
| 仓库 `CreditDaddy/tools.d/*.json` | 内置默认，随发行（上游 PR 带配置） |
| 用户 `~/.creditdaddy/tools.d/*.json` | 用户覆盖，**同名 id 时用户优先**（改端口/路径等本地微调不丢） |

热重载：面板「工具」页「重载」或 daemon `POST /api/tools/reload`；CLI `creditdaddy tools`。

## 三层接入策略（先配 L1 → 端点简单配 L2 → 否则写 L3 代码）

| 层 | 内容 | 配置化程度 | 适用工具 |
|----|------|-----------|---------|
| L1 | 凭据发现（读本机登录态） | 完全配置（reader 描述） | AutoClaw、未来的简单客户端 |
| L2 | 签到/额度请求（简单 Bearer JSON API） | 半配置（HTTP 模板） | 端点简单的新工具 |
| L3 | 复杂产品（COSY 签名头、验证码、设备指纹、多文件快照切换） | 代码（`{tool}Client.js` 挂 `PROVIDERS`） | Qoder/ZCode/Trae/MiniMax 等现有 7 件 |

## Schema

```json
{
  "id": "autoclaw",
  "name": "AutoClaw",
  "vendor": "智谱 AI",
  "provider": "autoclaw",
  "product": "autoclaw",
  "enabled": true,
  "platforms": ["win32"],
  "capabilities": { "discover": true, "checkin": false, "quota": false },
  "detect": {
    "installed": [
      { "type": "file", "path": "%LOCALAPPDATA%\\Programs\\AutoClaw\\AutoClaw.exe" },
      { "type": "process", "exe": ["AutoClaw.exe"] }
    ],
    "running": [{ "type": "process", "exe": ["AutoClaw.exe"] }]
  },
  "credential": {
    "reader": "http-token",
    "url": "http://127.0.0.1:18432/get_token",
    "timeoutMs": 3000,
    "tokenPath": "$.token"
  },
  "dayRefreshHourUtc8": 0,
  "checkin": null,
  "quota": null
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `id` | string | ✅ | 唯一 id（小写连字符）；同时是 custom reader 的模块名 |
| `provider` | string | ✅ | 账号 provider 名（进 accounts.json）；**不得与内置 14 个冲突**（冲突即拒） |
| `name` / `vendor` | string | ✅ | 展示名 / 厂商 |
| `enabled` | boolean | | 默认 true；false = 扫描与调度都跳过 |
| `platforms` | string[] | | `["win32"]` 等；缺省全平台 |
| `capabilities` | object | ✅ | `discover/checkin/quota` 三个布尔，控制该工具参与哪些环节 |
| `detect.installed` | Probe[] | | 安装探测：`{type:"file", path}`（支持 `%APPDATA%` 等环境变量占位符）或 `{type:"process", exe:[]}`；任一命中即已安装 |
| `detect.running` | Probe[] | | 运行中探测（切换账号/写回前用） |
| `credential.reader` | enum | ✅ | `plain-json` / `regex-scan` / `http-token` / `dpapi-json` / `custom` |
| `credential.*` | object | | reader 私有参数（见下） |
| `dayRefreshHourUtc8` | number | | 业务日翻日时点（UTC+8），默认 0；Qoder 型为 10 |
| `checkin` | object\|null | | L2 HTTP 模板（见下）；null = 不参与签到 |
| `quota` | object\|null | | L2 HTTP 模板；null = 无额度查询 |

> JSON 无注释语法：状态说明用 `_comment` 字段书写（校验器忽略未知字段）。

## reader 类型

| reader | 参数 | 说明 |
|--------|------|------|
| `plain-json` | `files:[{path,platform?}]`, `tokenPath`, `identity{}`, `history?` | 明文 JSON 会话文件（WorkBuddy 型：单对象或数组，`history:true` 时同目录其它 `*.json` 都扫） |
| `regex-scan` | `dirs:[{path,platform?}]`, `pattern`, `kind`, `maxFiles?`, `maxBytes?`, `maxMs?` | 目录树正则扫 token（旧版 Qoder IDE 型；命中 provider 为空，归属由用户导入时选） |
| `http-token` | `url`, `timeoutMs?`, `tokenPath`, `identity{}` | 请求本地 HTTP 服务取 token（AutoClaw 型；**URL 只允许 `127.0.0.1`/`localhost`，加载时强制**） |
| `dpapi-json` | `files:[{path,platform?}]`, `tokenPath`, `identity{}`, `snapshot?:boolean` | Windows DPAPI 解密的 JSON（Qoder `auth.v1.dat` 型；`snapshot:true` 时整份原文存 `meta` 供切换写回） |
| `custom` | `module`（可选，默认 `src/toolReaders/impl/{id}.js`） | 逃逸舱口：动态 import 指定模块，其导出 `read(def)` 返回记录；用于「每家一套加密算法」的渐进迁移 |

## L2 签到/额度 HTTP 模板（半配置，⚠️ 有条件）

```json
"checkin": {
  "executor": "http-json",
  "request": {
    "url": "https://api.example.com/v1/checkin",
    "method": "POST",
    "headers": { "Authorization": "Bearer {{token}}", "Content-Type": "application/json" },
    "body": { "source": "creditdaddy" }
  },
  "outcome": {
    "okWhen": { "path": "$.code", "equals": 0 },
    "alreadyWhen": { "path": "$.code", "equals": 1 },
    "messagePath": "$.message",
    "amountPath": "$.data.amount",
    "failedMessagePath": "$.message"
  }
}
```

`{{token}}` / `{{refreshToken}}` / `{{uid}}` 占位符由 `toolCheckin.js` 注入。

**⚠️ L2 适用边界**：仅覆盖「Bearer/固定头 + JSON 响应」的简单端点。需要签名头（Qoder COSY）、
验证码（ZCode 阿里云）、设备指纹、多文件快照切换的工具**必须走 L3 代码**——逆向工程的本质
复杂度用模板语言表达会比代码更难维护。

## 安全约定（红线）

1. reader 只读本机文件与 `127.0.0.1` 本地端口；所有出网请求只连各工具**官方端点**。
2. `http-token` 的 URL 在加载时校验 host 必须是 `127.0.0.1`/`localhost`，否则该工具标记 invalid 并跳过。
3. 扫描预算：`MAX_FILES=4000 / MAX_FILE_BYTES=1.5MB / MAX_MS=6000`，多工具总预算叠加上限 15s，超时工具返回「扫描超时」错误项而不阻塞其他工具。
4. token 不打日志：日志与 API 一律 `maskToken`；reader 错误信息只含路径与错误码。
5. 幂等：复用签到调度（`skipIfCheckedToday` + 串行队列），单账号 try/catch，失败不卡死整体。

## 当前试点与预留

- **AutoClaw（已接入 L1）**：`http-token` reader 读 `127.0.0.1:18432/get_token`。远端签到端点 `autoglm-api.zhipuai.cn` **未验证**——`autoclaw.json` 的 `checkin` 保持 null，抓包实测后按 L2 模板填参即活。**严禁凭猜测编造接口参数。**
- **华为码道 CodeArts（预留）**：内核 RPC `127.0.0.1:43740` 未验证（抓包未确认 URL/方法），本期不接入；`http-rpc` reader 类型为 P2 预留。
- **IMA（预留）**：无任何接口信息，本期不接入。
