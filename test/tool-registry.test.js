/**
 * 工具注册表框架：schema 校验 / 加载覆盖 / reader 分发（含本地假 HTTP 服务，不依赖开发机装了什么 AI 软件）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const reg = await import('../src/toolRegistry.js');
const readers = await import('../src/toolReaders/index.js');
const { allProviders, productOf } = await import('../src/constants.js');

const VALID = {
  id: 'demotool', provider: 'demotool', name: 'Demo', vendor: 'DemoVendor',
  capabilities: { discover: true, checkin: false, quota: false },
  credential: { reader: 'http-token', url: 'http://127.0.0.1:18432/get_token', tokenPath: '$.token' },
};

test('schema 校验：合法定义通过，缺字段/坏 reader/非回环 URL/provider 冲突被拒', () => {
  assert.deepEqual(reg.validateToolDef(VALID), []);
  assert.ok(reg.validateToolDef({ ...VALID, id: undefined }).some((e) => e.includes('id')));
  assert.ok(reg.validateToolDef({ ...VALID, credential: { reader: 'nope' } }).some((e) => e.includes('reader')));
  assert.ok(reg.validateToolDef({ ...VALID, credential: { reader: 'http-token', url: 'https://evil.example/t', tokenPath: '$.token' } })
    .some((e) => e.includes('本地端口')));
  assert.ok(reg.validateToolDef({ ...VALID, provider: 'qoder' }).some((e) => e.includes('冲突')));
  assert.ok(reg.validateToolDef({ ...VALID, capabilities: {} }).some((e) => e.includes('capabilities')));
});

test('加载：仓库 autoclaw.json + 用户目录同名覆盖；坏配置只跳过自己', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-tools-'));
  process.env.CREDITDADDY_HOME = home;
  try {
    const userDir = path.join(home, 'tools.d');
    fs.mkdirSync(userDir, { recursive: true });
    fs.writeFileSync(path.join(userDir, 'autoclaw.json'), JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(reg.repoToolsDirPath(), 'autoclaw.json'), 'utf8')), name: 'AutoClaw(用户覆盖)' }));
    fs.writeFileSync(path.join(userDir, 'broken.json'), '{ not json');
    fs.writeFileSync(path.join(userDir, 'demotool.json'), JSON.stringify(VALID));
    const defs = await reg.reloadToolDefs();
    assert.ok(defs >= 2);
    assert.equal(reg.toolForProvider('autoclaw').name, 'AutoClaw(用户覆盖)', '用户目录同名覆盖仓库');
    assert.ok(reg.registryLoadErrors().some((e) => e.file.endsWith('broken.json')), '坏配置进 errors 不抛');
    assert.ok(reg.activeToolDefs().every((d) => d.enabled && (!d.platforms.length || d.platforms.includes(process.platform))));
    assert.ok(allProviders().includes('autoclaw') && allProviders().includes('demotool'));
    assert.equal(productOf('autoclaw'), 'autoclaw', 'productOf miss 回落注册表');
  } finally {
    delete process.env.CREDITDADDY_HOME;
    fs.rmSync(home, { recursive: true, force: true });
    await reg.reloadToolDefs();
  }
});

test('reader 分发：plain-json 读临时会话文件；regex-scan 扫临时目录', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-reader-'));
  try {
    const sess = path.join(root, 'session.json');
    fs.writeFileSync(sess, JSON.stringify({ token: 'tok-abcdef123456', uid: 'u1', name: '小明' }));
    const r1 = await readers.readCredentials({ id: 't1', provider: 'p1', file: sess, credential: { reader: 'plain-json', files: [{ path: sess }], tokenPath: '$.token', identity: { uidPath: '$.uid', namePath: '$.name' } } });
    assert.equal(r1.records.length, 1);
    assert.equal(r1.records[0].token, 'tok-abcdef123456');
    assert.equal(r1.records[0].uid, 'u1');

    const scanDir = path.join(root, 'scan');
    fs.mkdirSync(scanDir);
    fs.writeFileSync(path.join(scanDir, 'state.vscdb'), 'x dt-ABCDEFGHIJKLMNOPQRST y');
    const r2 = await readers.readCredentials({ id: 't2', file: scanDir, credential: { reader: 'regex-scan', dirs: [{ path: scanDir }], pattern: '\\bdt-[A-Za-z0-9_-]{16,}\\b', kind: 'device' } });
    assert.equal(r2.records.length, 1);
    assert.equal(r2.records[0].provider, null, 'regex-scan 归属由用户导入时选');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('reader 分发：http-token 打本地假服务（JSON 与纯文本两形态）；端口不通记错误不抛', async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/json') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ token: 'srv-token-123456', user: { id: '42', name: '阿抖' } })); }
    else if (req.url === '/text') { res.writeHead(200); res.end('Bearer srv-token-123456'); }
    else { res.writeHead(404); res.end('{}'); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const def = (url) => ({ id: 'ac', provider: 'autoclaw', file: url, credential: { reader: 'http-token', url, timeoutMs: 2000, tokenPath: '$.token', identity: { uidPath: '$.user.id', namePath: '$.user.name' } } });
  try {
    const r1 = await readers.readCredentials(def(`${base}/json`));
    assert.equal(r1.records[0].token, 'srv-token-123456');
    assert.equal(r1.records[0].uid, '42');
    const r2 = await readers.readCredentials(def(`${base}/text`));
    assert.equal(r2.records[0].token, 'srv-token-123456', '纯文本 Bearer 响应');
    const r3 = await readers.readCredentials(def(`${base}/missing`));
    assert.ok(r3.errors.length && r3.errors[0].error.includes('404'));
    const r4 = await readers.readCredentials(def('http://127.0.0.1:1/get_token'));
    assert.ok(r4.errors.length && !r4.records.length, '端口不通：记错误不抛');
    const r5 = await readers.readCredentials({ id: 'q', provider: 'q', file: 'f', credential: { reader: 'dpapi-json', files: [{ path: 'x' }], tokenPath: '$.token' } });
    assert.ok(r5.errors[0].error.includes('尚未实现'), 'T02 之前的 reader 给出明确错误');
  } finally { server.close(); }
});
