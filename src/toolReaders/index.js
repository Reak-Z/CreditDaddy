/**
 * reader 分发 — 按工具定义的 credential.reader 类型路由到具体读取器。
 *
 * 每个 reader 模块导出统一的 `read(def)` → { records, errors }：
 *   records: CredentialRecord[]（provider/token/uid/name/email/refreshToken/expiresAt/source/meta）
 *   errors:  [{ file, error }]（只含路径与错误码，不含文件内容——脱敏红线）
 *
 * reader 是纯函数（不碰候选内存表、不落盘）：候选入表与账号入库由 daemon 层统一完成
 * （localDetect.putCandidate + store.addAccount），reader 因此可在测试中零全局状态直测。
 *
 * 安全边界：reader 只读本机文件与 127.0.0.1 本地端口（http-token 的 host 白名单在
 * toolRegistry 加载时强制）；所有出网请求只连各工具官方端点。
 */

const READER_MODULES = {
  'plain-json': () => import('./plainJson.js'),
  'regex-scan': () => import('./regexScan.js'),
  'http-token': () => import('./httpToken.js'),
  'dpapi-json': () => import('./dpapiJson.js'),   // T02 交付；未实现时返回明确错误而非崩溃
  custom: () => import('./custom.js'),             // T02 交付
};

/**
 * 读取一个工具定义描述的本机凭据。
 * @param {object} def 工具定义（toolRegistry 加载并校验过）
 * @returns {Promise<{records: object[], errors: Array<{file:string, error:string}>}>}
 */
export async function readCredentials(def) {
  const kind = def?.credential?.reader;
  const load = READER_MODULES[kind];
  if (!load) {
    return { records: [], errors: [{ file: def?.file || def?.id || '?', error: `未知 reader 类型:${kind}` }] };
  }
  try {
    const mod = await load();
    if (typeof mod.read !== 'function') {
      return { records: [], errors: [{ file: def.file, error: `reader ${kind} 缺少 read(def) 导出` }] };
    }
    return await mod.read(def);
  } catch (e) {
    if (e?.code === 'ERR_MODULE_NOT_FOUND') {
      return { records: [], errors: [{ file: def.file, error: `reader ${kind} 尚未实现` }] };
    }
    return { records: [], errors: [{ file: def.file, error: e?.message || String(e) }] };
  }
}

/** 批量读取（多工具扫描用）：单工具 try/catch，失败不卡死其他工具 */
export async function readAllCredentials(defs) {
  const records = [];
  const errors = [];
  for (const def of defs) {
    try {
      const r = await readCredentials(def);
      for (const rec of r.records) records.push({ ...rec, toolId: def.id, toolName: def.name });
      errors.push(...r.errors);
    } catch (e) {
      errors.push({ file: def.file, error: e?.message || String(e) });
    }
  }
  return { records, errors };
}
