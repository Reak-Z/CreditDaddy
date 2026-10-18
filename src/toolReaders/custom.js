/**
 * reader custom — 逃逸舱口：动态 import 配置指定的 reader 实现模块。
 *
 * 适用面：「每家一套加密算法」的工具（ZCode / mirasim / 妙手 / Trae / MiniMax 型）——
 * 注册表先建机制，实现模块按工具渐进迁移（本期不强制迁移，现有 {tool}Local.js 保持 L3）。
 *
 * 配置（def.credential）：
 *   module: "zcode"   可选；缺省用 def.id → 解析 src/toolReaders/impl/{module}.js
 *
 * 实现模块契约：导出 `async function read(def)`，返回 { records, errors }（与内置 reader 同形状）。
 * 安全：模块名只允许字母/数字/连字符/下划线（拒绝路径穿越）；解析失败给出明确错误而非崩溃。
 */

const MODULE_RE = /^[A-Za-z0-9_-]+$/;

/** 从已导入的模块读取（read 的委托核心，抽出来供测试无文件系统直测） */
export async function readFromModule(mod, def) {
  if (typeof mod?.read !== 'function') throw new Error('自定义 reader 模块必须导出 read(def)');
  const r = await mod.read(def);
  return {
    records: Array.isArray(r?.records) ? r.records : [],
    errors: Array.isArray(r?.errors) ? r.errors : [],
  };
}

export async function read(def) {
  const name = def.credential?.module || def.id;
  if (!MODULE_RE.test(String(name))) {
    return { records: [], errors: [{ file: def.file, error: `自定义 reader 模块名不合法:${name}（只允许字母/数字/连字符/下划线）` }] };
  }
  try {
    const mod = await import(`./impl/${name}.js`);
    return await readFromModule(mod, def);
  } catch (e) {
    if (e?.code === 'ERR_MODULE_NOT_FOUND') {
      return { records: [], errors: [{ file: def.file, error: `自定义 reader 模块不存在:src/toolReaders/impl/${name}.js` }] };
    }
    return { records: [], errors: [{ file: def.file, error: e?.message || String(e) }] };
  }
}
