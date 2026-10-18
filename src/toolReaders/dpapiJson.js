/**
 * reader dpapi-json — Windows DPAPI（Electron safeStorage）解密的 JSON（Qoder auth.v1.dat 型）。
 *
 * 封装现有 qoderApp.safeStorageCodec 的解密能力（Qoder 自身保持 L3 硬编码不动，本 reader
 * 面向「同形态的未來工具」）：Windows = DPAPI 解 Local State 密钥 + AES-256-GCM；
 * mac/linux = 钥匙串 / 固定盐 basic 形态（与 Electron safeStorage 一致）。
 *
 * 配置（def.credential）：
 *   files:    [{ path, platform? }]   加密 JSON 文件（如 %APPDATA%\Qoder\auth.v1.dat）
 *   tokenPath: "$.token"
 *   identity: { uidPath?, namePath?, emailPath? }
 *   refreshPath? / expiresPath?
 *   appNames: ["Qoder App"]           mac 钥匙串服务名（win32 不使用；缺省用工具名）
 *   snapshot: true                    整份解密原文存 meta（切换账号写回用）
 *
 * 只读：本 reader 只解密读取，不写回客户端任何文件（切换是独立显式操作）。
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { safeStorageCodec } from '../qoderApp.js';
import { expandEnvPath } from '../toolRegistry.js';
import { pickPath } from './plainJson.js';

const asText = (v) => (typeof v === 'string' && v.trim() ? v.trim() : (typeof v === 'number' ? String(v) : null));

export async function read(def) {
  const cred = def.credential;
  const records = [];
  const errors = [];
  for (const entry of cred.files || []) {
    if (entry.platform && entry.platform !== process.platform) continue;
    const file = expandEnvPath(entry.path);
    let buf;
    try { buf = await fsp.readFile(file); }
    catch (e) {
      errors.push({ file, error: e.code === 'ENOENT' ? '文件不存在（客户端未安装或未登录）' : `读取失败:${e.message}` });
      continue;
    }
    try {
      const { decrypt } = await safeStorageCodec(path.dirname(file), cred.appNames || [def.name]);
      const obj = JSON.parse(decrypt(buf));
      const token = asText(pickPath(obj, cred.tokenPath));
      if (!token) throw new Error('解密成功但 tokenPath 未取到 token');
      const id = cred.identity || {};
      records.push({
        provider: def.provider,
        token,
        refreshToken: asText(pickPath(obj, cred.refreshPath)) || null,
        expiresAt: asText(pickPath(obj, cred.expiresPath)) || null,
        uid: asText(pickPath(obj, id.uidPath)) || null,
        name: asText(pickPath(obj, id.namePath)) || null,
        email: asText(pickPath(obj, id.emailPath)) || null,
        source: 'local-app',
        meta: {
          file,
          // snapshot:true 时整份原文进 meta（键名 {id}Auth）——切换账号写回用；
          // 与 Qoder 既有 meta.qoderAuth 并存不冲突（Qoder 自身不走本 reader）。
          ...(cred.snapshot === true ? { [`${def.id}Auth`]: obj } : {}),
        },
      });
    } catch (e) {
      // 错误信息只含文件路径与原因，不含解密内容（脱敏红线）
      errors.push({ file, error: e.message });
    }
  }
  return { records, errors };
}
