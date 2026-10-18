/**
 * 积分聚合器（F3 看板数据层）：L0 快照三态 / live 刷新回填 / daemon /quota 语义（默认快照 + ?live=1）。
 * 本地假上游 + 注册表 L2 quota 模板，不依赖任何真实 AI 服务。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

process.env.CREDITDADDY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-quota-agg-'));

const { aggregateQuotas, refreshOne, snapshotOf, isStale } = await import('../src/quotaAggregator.js');
const reg = await import('../src/toolRegistry.js');
const { addAccount } = await import('../src/accounts.js');
const { loadAccounts } = await import('../src/store.js');
const { closeArchiveStream } = await import('../src/logger.js');

// 共享假上游：L2 quota 模板打这里；用户 tools.d 放 demotool（quota 模板指向它）
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ total: 500, used: 100, remaining: 400 }));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;
fs.mkdirSync(path.join(process.env.CREDITDADDY_HOME, 'tools.d'), { recursive: true });
fs.writeFileSync(path.join(process.env.CREDITDADDY_HOME, 'tools.d', 'demotool.json'), JSON.stringify({
  id: 'demotool', provider: 'demotool', name: 'Demo', vendor: 'V',
  capabilities: { discover: true, checkin: false, quota: true },
  credential: { reader: 'http-token', url: 'http://127.0.0.1:1/get_token', tokenPath: '$.token' },
  quota: { executor: 'http-json', request: { url: `${BASE}/quota`, method: 'GET' }, outcome: { totalPath: '$.total', usedPath: '$.used', remainingPath: '$.remaining' } },
}));
await reg.reloadToolDefs();
test.after(() => { server.close(); return closeArchiveStream(); });

const NOW = Date.now();
const snap = (agoMin, extra = {}) => ({ meta: { quotaSnapshot: { total: 500, used: 100, remaining: 400, at: new Date(NOW - agoMin * 60000).toISOString(), ...extra } } });

test('L0 快照三态：新鲜 / >25h 陈旧 / 缺失（纯函数）', () => {
  assert.equal(isStale(snap(60), NOW), false);
  assert.equal(isStale(snap(26 * 60), NOW), true);
  assert.equal(isStale({ meta: {} }, NOW), true);
  assert.equal(snapshotOf({ meta: {} }), null);
  assert.equal(snapshotOf(snap(5)).remaining, 400);
});

test('aggregateQuotas L0：零网络逐账号隔离（新鲜回数 / 陈旧标 stale / 缺失给 error）', async () => {
  const a = { id: 'a1', ...snap(60) };
  const b = { id: 'b1', ...snap(26 * 60) };
  const c = { id: 'c1', meta: {} };
  const m = await aggregateQuotas([a, b, c], { live: false });
  assert.equal(m.get('a1').quota.remaining, 400);
  assert.equal(m.get('a1').stale, false);
  assert.equal(m.get('b1').stale, true);
  assert.ok(m.get('b1').quota, '陈旧仍有旧数字可显示');
  assert.equal(m.get('c1').quota, undefined);
  assert.ok(m.get('c1').error);
});

test('live 刷新：L2 模板打假上游 → 回填 meta.quotaSnapshot → L0 可读（不打网络）', async () => {
  const { account } = await addAccount({ provider: 'demotool', token: 'tok-live-1', name: '演示' }, { trusted: true });
  const m = await aggregateQuotas([account], { live: true });
  assert.equal(m.get(account.id).quota.total, 500);
  assert.equal(m.get(account.id).stale, false);
  const saved = (await loadAccounts()).find((x) => x.id === account.id);
  assert.equal(saved.meta.quotaSnapshot.total, 500, '快照落盘（withAccounts 串行队列）');
  const m2 = await aggregateQuotas([saved], { live: false });
  assert.equal(m2.get(saved.id).quota.remaining, 400);
});

test('live 失败降级：有旧快照照常回 + error；refreshOne 对无 quota 产品抛错', async () => {
  const userDir = path.join(process.env.CREDITDADDY_HOME, 'tools.d');
  // 死端口工具（127.0.0.1:1 连接立即拒绝）：验证 live 失败走旧快照降级
  fs.writeFileSync(path.join(userDir, 'deadtool.json'), JSON.stringify({
    id: 'deadtool', provider: 'deadtool', name: 'Dead', vendor: 'V',
    capabilities: { discover: false, checkin: false, quota: true },
    credential: { reader: 'http-token', url: 'http://127.0.0.1:1/get_token', tokenPath: '$.token' },
    quota: { executor: 'http-json', request: { url: 'http://127.0.0.1:1/quota', method: 'GET' }, outcome: { totalPath: '$.total' } },
  }));
  await reg.reloadToolDefs();
  const { account } = await addAccount({ provider: 'deadtool', token: 'tok-dead-1' }, { trusted: true });
  account.meta = { quotaSnapshot: { total: 7, at: new Date(Date.now() - 60000).toISOString() } };
  const item = (await aggregateQuotas([account], { live: true })).get(account.id);
  assert.ok(item.error, 'live 失败带 error');
  assert.equal(item.quota.total, 7, '旧快照照常回（面板显示旧数字 + 提示）');
  assert.equal(item.stale, true);
  // 无 quota 能力的产品（注册表 quota:null）→ refreshOne 抛错
  fs.writeFileSync(path.join(userDir, 'noquota.json'), JSON.stringify({
    id: 'noquota', provider: 'noquota', name: 'NoQuota', vendor: 'V',
    capabilities: { discover: true, checkin: false, quota: false },
    credential: { reader: 'http-token', url: 'http://127.0.0.1:1/get_token', tokenPath: '$.token' },
  }));
  await reg.reloadToolDefs();
  await assert.rejects(refreshOne({ id: 'z', provider: 'noquota' }), /不支持额度查询/);
});

test('daemon /quota：默认快照（无快照 502）→ ?live=1 回填 → 默认再读走快照', async () => {
  const { startDaemon } = await import('../src/daemon.js');
  const { account } = await addAccount({ provider: 'demotool', token: 'tok-http-1', name: 'HTTP 演示' }, { trusted: true });
  const { server: daemon, port } = await startDaemon(0, '127.0.0.1');
  try {
    const noSnap = await fetch(`http://127.0.0.1:${port}/api/accounts/${account.id}/quota`);
    assert.equal(noSnap.status, 502, '无快照时 502 提示点刷新');
    const live = await fetch(`http://127.0.0.1:${port}/api/accounts/${account.id}/quota?live=1`);
    assert.equal(live.status, 200);
    const liveBody = await live.json();
    assert.equal(liveBody.quota.total, 500);
    assert.equal(liveBody.stale, false);
    assert.ok(liveBody.staleSince, '回填后带 staleSince');
    const cached = await fetch(`http://127.0.0.1:${port}/api/accounts/${account.id}/quota`);
    assert.equal(cached.status, 200);
    const cachedBody = await cached.json();
    assert.equal(cachedBody.quota.remaining, 400, '默认读快照（行为兼容性变更 D6）');
    assert.equal(cachedBody.stale, false);
  } finally {
    daemon.close();
  }
});
