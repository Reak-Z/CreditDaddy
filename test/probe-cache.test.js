/**
 * 卡顿修复回归（2026-10-20）：
 *  A. winProc.anyProcRunningFast：全量进程表单次查询 + 1.5s 缓存（替代 Trae 四连 tasklist）
 *  B. daemon /api/status 探测族缓存：5min TTL，轮询命中 ms 级；bustProbeStatus 后重回全量
 * 背景：daemon 与 Electron 主进程同事件循环，status 的同步外部探测（注册表 powershell /
 * DPAPI / tasklist×N）单次秒级，面板 30s 轮询反复占住主进程 → 窗口拖动/点击卡顿。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CREDITDADDY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-probe-cache-'));

const { anyProcRunningFast } = await import('../src/winProc.js');

test('anyProcRunningFast：node.exe（本测试进程）在跑 → true；随机名 → false', { skip: process.platform !== 'win32' }, () => {
  assert.equal(anyProcRunningFast('node.exe'), true, '测试进程自己就是 node.exe');
  assert.equal(anyProcRunningFast(['NoSuchProc98765.exe']), false);
  assert.equal(anyProcRunningFast(['NoSuchProc98765.exe', 'node.exe']), true, '数组任一命中即真');
});

test('anyProcRunningFast：连续调用走缓存不破坏结果（值稳定）', { skip: process.platform !== 'win32' }, () => {
  const a = anyProcRunningFast('node.exe');
  const b = anyProcRunningFast('node.exe');   // 第二次命中 1.5s 缓存
  assert.equal(a, b);
});

test('/api/status 探测族缓存：首帧全量 → 轮询命中 ms 级 → bust 后重回全量', async () => {
  const { startDaemon, bustProbeStatus } = await import('../src/daemon.js');
  const { closeArchiveStream } = await import('../src/logger.js');
  const { server, port } = await startDaemon(0, '127.0.0.1');
  const time = async () => { const t0 = Date.now(); const r = await fetch(`http://127.0.0.1:${port}/api/status`); await r.json(); return Date.now() - t0; };
  try {
    bustProbeStatus();                       // 确保首帧是全量
    await time();
    const hit1 = await time();               // 命中缓存
    const hit2 = await time();
    assert.ok(hit1 < 200 && hit2 < 200, `缓存命中应为 ms 级（实得 ${hit1}/${hit2}ms）`);
    bustProbeStatus();                       // 模拟写操作作废
    const busted = await time();             // 重回全量
    assert.ok(busted > Math.max(hit1, hit2) * 3, `bust 后应显著慢于命中（${busted}ms vs ${hit1}ms）`);
    const hitAgain = await time();
    assert.ok(hitAgain < 200, 'bust 后的全量结果重新入缓存');
  } finally {
    server.close();
    await closeArchiveStream();
  }
});

test('/api/status 结构完整：探测族字段与实时字段都在，缓存前后一致', async () => {
  const { startDaemon, bustProbeStatus } = await import('../src/daemon.js');
  const { closeArchiveStream } = await import('../src/logger.js');
  const { server, port } = await startDaemon(0, '127.0.0.1');
  try {
    bustProbeStatus();
    const b1 = await (await fetch(`http://127.0.0.1:${port}/api/status`)).json();
    for (const k of ['qoderClient', 'zcodeClient', 'mirasimClient', 'catpawClient', 'traeClient', 'minimaxClient', 'qoderCurrent', 'traeCurrentUid', 'umid', 'platform']) {
      assert.ok(k in b1, `探测族字段 ${k} 应存在`);
    }
    for (const k of ['accountsCount', 'scheduler', 'expiring', 'todayDone', 'todayByProduct']) {
      assert.ok(k in b1, `实时字段 ${k} 应存在`);
    }
    const b2 = await (await fetch(`http://127.0.0.1:${port}/api/status`)).json();   // 命中缓存
    assert.equal(b2.accountsCount, b1.accountsCount, '账号计数一致');
    assert.deepEqual(b2.traeClient, b1.traeClient, '缓存内容与全量一致');
    assert.ok(b2.scheduler, '调度倒计时不走缓存（实时）');
  } finally {
    server.close();
    await closeArchiveStream();
  }
});
