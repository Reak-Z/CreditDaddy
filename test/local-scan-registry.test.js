/**
 * T02 注册表扫描：detectToolInstalls 泛化探测 / scanLocalTokens 正则参数化 /
 * dpapi-json 与 custom reader 分发 / daemon /api/tools 与 /api/local/scan 路由。
 * 一律临时目录 + 本地假服务，不依赖开发机装了什么 AI 软件。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

process.env.CREDITDADDY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-scan-reg-'));

const { detectToolInstalls, scanLocalTokens } = await import('../src/localDetect.js');
const readers = await import('../src/toolReaders/index.js');

test('detectToolInstalls：file 探测命中/未命中，process 探测只断言形状', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-probe-'));
  try {
    const exe = path.join(root, 'App.exe');
    fs.writeFileSync(exe, '');
    const r = detectToolInstalls([
      { id: 'a', provider: 'a', name: 'A', vendor: 'V', detect: { installed: [{ type: 'file', path: exe }] } },
      { id: 'b', provider: 'b', name: 'B', vendor: 'V', detect: { installed: [{ type: 'file', path: path.join(root, 'nope.exe') }, { type: 'process', exe: ['NoSuchProc12345.exe'] }], running: [{ type: 'process', exe: ['NoSuchProc12345.exe'] }] } },
      { id: 'c', provider: 'c', name: 'C', vendor: 'V', detect: {} },
    ]);
    assert.equal(r[0].installed, true);
    assert.equal(r[1].installed, false);
    assert.equal(r[1].probes.length, 3);
    assert.equal(typeof r[1].probes[1].hit, 'boolean');
    assert.equal(r[1].running, false);
    assert.equal(r[2].installed, false);
    assert.deepEqual(r[2].probes, []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('scanLocalTokens：正则参数化（自定义 pattern + kind），缺省行为不变', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-scan-'));
  try {
    fs.writeFileSync(path.join(dir, 'a.json'), 'tk_ABCDEFGHIJKLMNOP');
    const r = await scanLocalTokens([dir], { pattern: '\\btk_[A-Za-z0-9]{8,}\\b', kind: 'cli' });
    assert.equal(r.candidates.length, 1);
    assert.equal(r.candidates[0].kind, 'cli');
    assert.ok(r.candidates[0].tokenMasked.includes('...'), '只回脱敏值');
    const legacy = await scanLocalTokens([dir]);   // 缺省 pattern：不命中 tk_ 形态
    assert.equal(legacy.candidates.length, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('dpapi-json reader：缺文件记错误（不抛）', async () => {
  const r = await readers.readCredentials({ id: 'q', provider: 'qp', file: 'f', credential: { reader: 'dpapi-json', files: [{ path: path.join(os.tmpdir(), 'cd-no-such-dir-xyz', 'auth.dat') }], tokenPath: '$.token' } });
  assert.ok(r.errors.length && !r.records.length);
});

test('dpapi-json reader：Linux basic 加密往返可读（Electron safeStorage 同形态）', { skip: process.platform !== 'linux' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-dpapi-'));
  try {
    const file = path.join(dir, 'auth.v1.dat');
    const key = crypto.pbkdf2Sync('peanuts', 'saltysalt', 1, 16, 'sha1');
    const c = crypto.createCipheriv('aes-128-cbc', key, Buffer.alloc(16, ' '));
    const plain = JSON.stringify({ token: 'dpapi-tok-1', user: { id: 'u9' } });
    fs.writeFileSync(file, Buffer.concat([Buffer.from('v10'), c.update(plain, 'utf8'), c.final()]));
    const r = await readers.readCredentials({ id: 'q', provider: 'qp', file, credential: { reader: 'dpapi-json', files: [{ path: file }], tokenPath: '$.token', identity: { uidPath: '$.user.id' }, snapshot: true } });
    assert.equal(r.records.length, 1);
    assert.equal(r.records[0].token, 'dpapi-tok-1');
    assert.equal(r.records[0].uid, 'u9');
    assert.equal(r.records[0].meta.qAuth.token, 'dpapi-tok-1', 'snapshot:true 整份原文进 meta');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('custom reader：模块名不合法被拒、不存在给明确错误、契约委托可直测', async () => {
  const { readFromModule } = await import('../src/toolReaders/custom.js');
  const bad = await readers.readCredentials({ id: '../evil', file: 'f', credential: { reader: 'custom' } });
  assert.ok(bad.errors[0].error.includes('不合法'), '拒绝路径穿越');
  const miss = await readers.readCredentials({ id: 'nosuchimpl', file: 'f', credential: { reader: 'custom' } });
  assert.ok(miss.errors[0].error.includes('不存在'), '缺实现给明确错误而非崩溃');
  const ok = await readFromModule({ read: async () => ({ records: [{ provider: 'x', token: 't' }], errors: [] }) }, { id: 'x' });
  assert.equal(ok.records[0].token, 't');
  await assert.rejects(readFromModule({}, { id: 'x' }), /read\(def\)/);
});

test('daemon：GET /api/tools 列出注册表（含 autoclaw）；POST /api/tools/reload 可热重载', async () => {
  const { startDaemon } = await import('../src/daemon.js');
  const { closeArchiveStream } = await import('../src/logger.js');
  const { server, port } = await startDaemon(0, '127.0.0.1');
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/tools`);
    assert.equal(res.status, 200);
    const body = await res.json();
    const ac = body.tools.find((t) => t.id === 'autoclaw');
    assert.ok(ac && ac.provider === 'autoclaw' && ac.capabilities.discover === true);
    assert.equal(typeof ac.installed, 'boolean');
    assert.ok(Array.isArray(body.errors) && typeof body.userDir === 'string');
    const r2 = await fetch(`http://127.0.0.1:${port}/api/tools/reload`, { method: 'POST' });
    assert.equal(r2.status, 200);
    assert.equal((await r2.json()).ok, true);
  } finally {
    server.close();
    await closeArchiveStream();
  }
});

test('daemon：POST /api/local/scan 含注册表工具段（tools 状态回显，结构完整）', async () => {
  const { startDaemon } = await import('../src/daemon.js');
  const { closeArchiveStream } = await import('../src/logger.js');
  const { server, port } = await startDaemon(0, '127.0.0.1');
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/local/scan`, { method: 'POST' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.candidates) && Array.isArray(body.errors));
    assert.ok(body.tools.some((t) => t.id === 'autoclaw'), '注册表安装状态随扫描回显');
    for (const c of body.candidates) assert.ok(!('token' in c), '候选只回脱敏字段');
  } finally {
    server.close();
    await closeArchiveStream();
  }
});
