/**
 * 开机自启（schtasks）：fake exec 注入验证命令形状与幂等；非 Windows no-op。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const auto = await import('../src/autostart.js');

test('setAutostart(true)：/Create ONLOGON LIMITED /F，命令含 node 与 CLI 入口（无凭据）', { skip: process.platform !== 'win32' }, () => {
  const calls = [];
  auto._setExecForTests((cmd, args) => { calls.push({ cmd, args }); return ''; });
  try {
    const r = auto.setAutostart(true);
    assert.equal(r.ok, true);
    assert.equal(calls[0].cmd, 'schtasks');
    assert.deepEqual(calls[0].args.slice(0, 6), ['/Create', '/TN', 'CreditDaddy', '/SC', 'ONLOGON', '/RL']);
    assert.ok(calls[0].args.includes('/F'), '幂等：覆盖创建');
    const tr = calls[0].args[calls[0].args.indexOf('/TR') + 1];
    assert.ok(tr.includes(process.execPath) && tr.includes('creditdaddy.js') && tr.includes('start'), '指向 creditdaddy start');
    assert.ok(!/token|password|key/i.test(tr), '任务命令不含凭据字样');
  } finally { auto._setExecForTests(null); }
});

test('setAutostart(false)：/Delete /F；status 按退出码判定在不在', { skip: process.platform !== 'win32' }, () => {
  let mode = 'ok';
  const exec = () => { if (mode === 'query-fail') throw new Error('找不到'); return 'CreditDaddy,...'; };
  auto._setExecForTests(exec);
  try {
    assert.equal(auto.setAutostart(false).ok, true);
    mode = 'query-fail';
    auto._setExecForTests(exec);   // 重装 fake = 清状态缓存（生产由 30s TTL 自然过期）
    assert.equal(auto.autostartStatus().enabled, false, '查询非零退出 = 未开启');
    mode = 'ok';
    auto._setExecForTests(exec);
    assert.equal(auto.autostartStatus().enabled, true, '查询成功 = 已开启');
  } finally { auto._setExecForTests(null); }
});

test('setAutostart 失败（杀软拦截等）返回 error 不抛', { skip: process.platform !== 'win32' }, () => {
  auto._setExecForTests(() => { throw new Error('访问被拒绝'); });
  try {
    const r = auto.setAutostart(true);
    assert.equal(r.ok, false);
    assert.match(r.error, /访问被拒绝/);
  } finally { auto._setExecForTests(null); }
});

test('非 Windows：supported=false，setAutostart no-op 返回 ok', { skip: process.platform === 'win32' }, () => {
  assert.deepEqual(auto.autostartStatus(), { supported: false, enabled: false });
  assert.deepEqual(auto.setAutostart(true), { ok: true, supported: false });
});
