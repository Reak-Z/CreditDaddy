/**
 * 积分到期监视（F4）：记录 / 判定 / dismiss / 每日汇总 + daemon 路由。
 * 时间点选取对时区不敏感（23:00Z 在任何时区都是当地 ≥9 点，12:00Z 都 <9 点）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CREDITDADDY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-expiry-'));

const { recordExpiry, dueReminders, dismissReminder, runDailyDigest } = await import('../src/expiryWatch.js');
const { loadState, withState, saveSettings } = await import('../src/store.js');
const { closeArchiveStream } = await import('../src/logger.js');

const DAY = 86400000;
const iso = (ms) => new Date(ms).toISOString();

test('recordExpiry：取最早到期（remaining>0、非周期）；哨兵值与空 parts 不记录', async () => {
  const now = Date.now();
  await recordExpiry('acc1', { parts: [
    { name: 'A', total: 100, used: 10, remaining: 90, expiresAt: iso(now + 2 * DAY) },
    { name: 'B', total: 50, used: 0, remaining: 50, expiresAt: iso(now + DAY), recurring: true },   // 周期重置不算到期
    { name: 'C', total: 9, used: 9, remaining: 0, expiresAt: iso(now + DAY) },                     // 已用尽不提醒
  ] }, { name: '账号一', provider: 'qoder' });
  await recordExpiry('acc2', { parts: [{ name: 'X', total: 1, used: 0, remaining: 1, expiresAt: 253400000000000 }] });   // 9999 年哨兵
  await recordExpiry('acc3', { parts: [] });
  const state = await loadState();
  assert.equal(state.expiryWatch.acc1.expiresAt, iso(now + 2 * DAY));
  assert.equal(state.expiryWatch.acc1.remaining, 90);
  assert.equal(state.expiryWatch.acc1.name, '账号一');
  assert.equal(state.expiryWatch.acc2, undefined, '哨兵值过滤');
  assert.equal(state.expiryWatch.acc3, undefined, '无到期数据不记录');
  // 工具不再提供 expiresAt → 删除旧记录（停止提醒，不残留误报）
  await recordExpiry('acc1', { parts: [] });
  assert.equal((await loadState()).expiryWatch.acc1, undefined);
});

test('dueReminders：提前量内 warn / ≤24h urgent / 超期除外 / dismiss 过滤 / 总开关', async () => {
  const now = Date.now();
  await withState((s) => {
    s.expiryWatch = {
      soon: { expiresAt: iso(now + 2 * DAY), remaining: 10, name: '两天后', provider: 'trae' },
      urgent: { expiresAt: iso(now + 20 * 3600e3), remaining: 5, name: '一天内', provider: 'qoder' },
      far: { expiresAt: iso(now + 10 * DAY), remaining: 5, name: '十天后', provider: 'qoder' },
      gone: { expiresAt: iso(now - DAY), remaining: 5, name: '已过期', provider: 'qoder' },
    };
    s.dismissedReminders = [{ accountId: 'gone', expiresAt: iso(now - DAY) }];
  });
  let list = await dueReminders(now);
  assert.deepEqual(list.map((r) => r.accountId), ['urgent', 'soon'], 'dismiss 的 gone 过滤，其余按到期时间排序');
  assert.equal(list.find((r) => r.accountId === 'urgent').level, 'urgent', '≤24h 紧急');
  assert.equal(list.find((r) => r.accountId === 'soon').level, 'warn');
  assert.ok(!list.some((r) => r.accountId === 'far'), '超出提前量不提醒');
  // dismiss 生效
  await dismissReminder('soon', iso(now + 2 * DAY));
  list = await dueReminders(now);
  assert.ok(!list.some((r) => r.accountId === 'soon'), '知道了不再提醒');
  await dismissReminder('soon', iso(now + 2 * DAY));   // 幂等
  assert.equal((await loadState()).dismissedReminders.filter((d) => d.accountId === 'soon').length, 1);
  // 总开关
  await saveSettings({ reminder: { enabled: false } });
  assert.deepEqual(await dueReminders(now), []);
  await saveSettings({ reminder: { enabled: true, daysBefore: 1 } });
  list = await dueReminders(now);
  assert.deepEqual(list.map((r) => r.accountId), ['urgent'], '提前量收紧到 1 天');
});

test('runDailyDigest：9 点前不跑；到点当日一次（幂等）；无提醒不占位', async () => {
  await saveSettings({ reminder: { enabled: true, daysBefore: 3 } });   // 复位（上一用例收紧了提前量）
  const now = Date.now();
  await withState((s) => { s.expiryWatch = { d1: { expiresAt: iso(now + 2 * DAY), remaining: 3, name: '待汇总', provider: 'qoder' } }; delete s.expiryDigest; });
  // 按本机本地时区构造 08:00 / 10:00（digest 门槛就是本地小时，注入后与时区无关）
  const localAt = (h) => { const d = new Date(); d.setHours(h, 0, 0, 0); return d.getTime(); };
  assert.deepEqual(await runDailyDigest(localAt(8)), [], '9 点前不汇总');
  const first = await runDailyDigest(localAt(10));
  assert.equal(first.length, 1, '到点汇总一次');
  assert.ok((await loadState()).expiryDigest?.day, '当日幂等标记落盘');
  assert.deepEqual(await runDailyDigest(localAt(10)), [], '同日再来不重复');
  // 无提醒时不占位：当天稍后出现仍可汇总一次
  await withState((s) => { delete s.expiryDigest; s.expiryWatch = {}; });
  assert.deepEqual(await runDailyDigest(localAt(10)), [], '无可提醒不汇总');
  assert.equal((await loadState()).expiryDigest, undefined, '无提醒不占位');
});

test('daemon：/api/status.expiring + /api/reminders + dismiss + settings reminder 开关', async () => {
  await saveSettings({ reminder: { enabled: true, daysBefore: 3 } });   // 复位
  const now = Date.now();
  await withState((s) => { s.expiryWatch = { h1: { expiresAt: iso(now + 2 * DAY), remaining: 8, name: 'HTTP 账号', provider: 'trae' } }; delete s.expiryDigest; delete s.dismissedReminders; });
  const { startDaemon } = await import('../src/daemon.js');
  const { server, port } = await startDaemon(0, '127.0.0.1');
  try {
    const st = await (await fetch(`http://127.0.0.1:${port}/api/status`)).json();
    assert.equal(st.expiring.length, 1);
    assert.equal(st.expiring[0].name, 'HTTP 账号');
    const rem = await (await fetch(`http://127.0.0.1:${port}/api/reminders`)).json();
    assert.equal(rem.reminders.length, 1);
    const dis = await fetch(`http://127.0.0.1:${port}/api/reminders/dismiss`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId: 'h1', expiresAt: rem.reminders[0].expiresAt }),
    });
    assert.equal(dis.status, 200);
    assert.deepEqual((await dis.json()).reminders, [], 'dismiss 后不再提醒');
    // 设置：总开关与提前天数
    const put = await fetch(`http://127.0.0.1:${port}/api/settings`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reminder: { enabled: false, daysBefore: 7 } }),
    });
    assert.equal(put.status, 200);
    assert.deepEqual((await put.json()).reminder, { enabled: false, daysBefore: 7 });
    // 同体处理：autostart + reminder 一个请求体都生效（不互斥早退；fake exec 免真调 schtasks）
    const auto = await import('../src/autostart.js');
    auto._setExecForTests(() => '');
    try {
      const both = await fetch(`http://127.0.0.1:${port}/api/settings`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ autostart: false, reminder: { enabled: true, daysBefore: 5 } }),
      });
      assert.equal(both.status, 200);
      const bb = await both.json();
      assert.ok('autostart' in bb && 'reminder' in bb, '同体两者都处理');
      assert.deepEqual(bb.reminder, { enabled: true, daysBefore: 5 });
    } finally { auto._setExecForTests(null); }
    await saveSettings({ reminder: { enabled: true, daysBefore: 3 } });
  } finally {
    server.close();
    await closeArchiveStream();
  }
});
