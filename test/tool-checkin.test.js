/**
 * L2 模板执行器 + productImpl 回落 + dayKey 注册表翻日（本地假 HTTP 服务，零真实上游）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

process.env.CREDITDADDY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-toolchk-'));

const { runConfiguredCheckin, runConfiguredQuota, buildFallbackImpl } = await import('../src/toolCheckin.js');
const reg = await import('../src/toolRegistry.js');
const { productImpl } = await import('../src/providers.js');
const { dayKey } = await import('../src/checkin.js');

/** 假上游：记录请求（method/headers/body），按 path 返回不同响应 */
function fakeServer(handler) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ method: req.method, headers: req.headers, body });
      handler(req, res, seen);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, seen, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

const jsonRes = (res, obj, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

const checkinTpl = (url, outcome) => ({
  id: 'demotool', provider: 'demotool', name: 'Demo', file: 'f',
  checkin: {
    executor: 'http-json',
    request: { url, method: 'POST', headers: { Authorization: 'Bearer {{token}}', 'Content-Type': 'application/json' }, body: { source: 'creditdaddy', uid: '{{uid}}' } },
    outcome,
  },
});

test('L2 签到：okWhen 命中 → checked-in 且取 amountPath；{{token}}/{{uid}} 注入请求', async () => {
  const { server, seen, base } = await fakeServer((req, res) => jsonRes(res, { code: 0, message: '领取成功', data: { amount: 150 } }));
  try {
    const r = await runConfiguredCheckin({ token: 'tok-abc', uid: 'u1' }, checkinTpl(`${base}/checkin`, { okWhen: { path: '$.code', equals: 0 }, messagePath: '$.message', amountPath: '$.data.amount' }));
    assert.equal(r.status, 'checked-in');
    assert.equal(r.claimedAmount, 150);
    assert.equal(seen[0].headers.authorization, 'Bearer tok-abc');
    assert.deepEqual(JSON.parse(seen[0].body), { source: 'creditdaddy', uid: 'u1' });
  } finally { server.close(); }
});

test('L2 签到：alreadyWhen 命中 → already；都不命中 → failed 带 failedMessagePath', async () => {
  const { server, base } = await fakeServer((req, res) => jsonRes(res, req.url === '/already' ? { code: 1, msg: '今日已领' } : { code: 99, msg: '活动未开始' }));
  try {
    const already = await runConfiguredCheckin({ token: 't' }, checkinTpl(`${base}/already`, { okWhen: { path: '$.code', equals: 0 }, alreadyWhen: { path: '$.code', equals: 1 }, failedMessagePath: '$.msg' }));
    assert.equal(already.status, 'already');
    const failed = await runConfiguredCheckin({ token: 't' }, checkinTpl(`${base}/other`, { okWhen: { path: '$.code', equals: 0 }, alreadyWhen: { path: '$.code', equals: 1 }, failedMessagePath: '$.msg' }));
    assert.equal(failed.status, 'failed');
    assert.equal(failed.error, '活动未开始');
  } finally { server.close(); }
});

test('L2 签到：未配置模板 → no-activity（不打网络）；HTTP 500 → failed', async () => {
  const none = await runConfiguredCheckin({ token: 't' }, { id: 'x', provider: 'x', checkin: null });
  assert.equal(none.status, 'no-activity');
  const { server, base } = await fakeServer((req, res) => jsonRes(res, { message: 'boom' }, 500));
  try {
    const r = await runConfiguredCheckin({ token: 't' }, checkinTpl(`${base}/e`, { okWhen: { path: '$.code', equals: 0 }, failedMessagePath: '$.message' }));
    assert.equal(r.status, 'failed');
    assert.equal(r.error, 'boom');
  } finally { server.close(); }
});

test('L2 额度：total/used/remaining 路径映射；无映射抛错', async () => {
  const { server, base } = await fakeServer((req, res) => jsonRes(res, req.url === '/q' ? { d: { total: 1000, used: 250, remaining: 750 } } : {}));
  try {
    const def = { quota: { executor: 'http-json', request: { url: `${base}/q`, method: 'GET' }, outcome: { totalPath: '$.d.total', usedPath: '$.d.used', remainingPath: '$.d.remaining' } } };
    const q = await runConfiguredQuota({ token: 't' }, def);
    assert.deepEqual([q.total, q.used, q.remaining], [1000, 250, 750]);
    await assert.rejects(runConfiguredQuota({ token: 't' }, { quota: { executor: 'http-json', request: { url: `${base}/none`, method: 'GET' }, outcome: {} } }), /无法解析/);
  } finally { server.close(); }
});

test('回落 impl：有 checkin 才挂 checkin；verify 走 reader 重读本机登录态', async () => {
  const { server, base } = await fakeServer((req, res) => jsonRes(res, { token: 'srv-token-1', user: { id: '42', name: '阿抖' } }));
  try {
    const def = {
      id: 'demotool', provider: 'demotool', name: 'Demo',
      credential: { reader: 'http-token', url: `${base}/get_token`, tokenPath: '$.token', identity: { uidPath: '$.user.id', namePath: '$.user.name' } },
      checkin: { executor: 'http-json', request: { url: `${base}/checkin` }, outcome: { okWhen: { path: '$.code', equals: 0 } } },
    };
    const impl = buildFallbackImpl(def);
    assert.equal(typeof impl.checkin, 'function');
    assert.equal(typeof impl.verify, 'function');
    const info = await impl.verify({ token: 'srv-token-1' });
    assert.equal(info.uid, '42');
    // 无 checkin 配置的工具（如 AutoClaw 试点）不参与签到：productImpl 过滤天然兼容
    const bare = buildFallbackImpl({ id: 'b', provider: 'b', name: 'B', checkin: null });
    assert.equal(bare.checkin, undefined);
  } finally { server.close(); }
});

test('productImpl 回落注册表（加载用户 tools.d 后）；dayKey 读注册表翻日时点', async () => {
  const home = process.env.CREDITDADDY_HOME;
  const userDir = path.join(home, 'tools.d');
  fs.mkdirSync(userDir, { recursive: true });
  fs.writeFileSync(path.join(userDir, 'demotool.json'), JSON.stringify({
    id: 'demotool', provider: 'demotool', name: 'Demo', vendor: 'V',
    capabilities: { discover: true, checkin: true, quota: false },
    credential: { reader: 'http-token', url: 'http://127.0.0.1:1/get_token', tokenPath: '$.token' },
    checkin: { executor: 'http-json', request: { url: 'http://127.0.0.1:1/checkin' }, outcome: { okWhen: { path: '$.code', equals: 0 } } },
    dayRefreshHourUtc8: 10,
  }));
  try {
    await reg.reloadToolDefs();
    assert.equal(typeof productImpl('demotool').checkin, 'function', 'PRODUCTS miss → 注册表回落');
    assert.equal(productImpl('qoder').label, 'Qoder', '内置产品不受影响');
    // 翻日时点：注册表 10 点 = 与 Qoder 同口径；0 点 = 与默认同口径
    const t = Date.parse('2026-10-18T02:00:00Z');   // UTC 02:00 = 北京 10:00，正好压在 10 点界上（两侧同天）
    assert.equal(dayKey(t, 'demotool'), dayKey(t, 'qoder'));
    const t2 = Date.parse('2026-10-18T09:00:00Z');  // 北京 17:00，两者同一天
    assert.equal(dayKey(t2, 'demotool'), dayKey(t2, 'qoder'));
    const t3 = Date.parse('2026-10-18T01:30:00Z');  // 北京 09:30：10 点界算昨日、0 点界算当日
    assert.notEqual(dayKey(t3, 'demotool'), dayKey(t3, 'trae'));
  } finally {
    fs.rmSync(userDir, { recursive: true, force: true });
    await reg.reloadToolDefs();
  }
});
