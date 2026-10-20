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

test('竞态修复：bust 落在在途 collect 窗口内 → 后续请求必须全新计算（不被在途回填覆盖）', async () => {
  const { startDaemon, bustProbeStatus, _probeStats, _setProbeGate } = await import('../src/daemon.js');
  const { closeArchiveStream } = await import('../src/logger.js');
  const { server, port } = await startDaemon(0, '127.0.0.1');
  const time = async () => { const t0 = Date.now(); const r = await fetch(`http://127.0.0.1:${port}/api/status`); await r.json(); return Date.now() - t0; };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // 轮询等待 collect 计数到位（消除「请求到达 daemon」的固定 sleep 时序抖动）
  const waitCollects = async (n, timeoutMs = 5000) => {
    const t0 = Date.now();
    while (_probeStats().collects < n && Date.now() - t0 < timeoutMs) await sleep(20);
  };
  try {
    // 测试目录里 collect 是毫秒级（无真实客户端数据），靠挂起门槛把 bust 精确放进在途窗口
    let release;
    const gate = new Promise((r) => { release = r; });
    const base = _probeStats().collects;   // 增量口径：collects 是进程级累加计数（跨测试）
    _setProbeGate(gate);
    bustProbeStatus();
    const cold = time();               // 启动 collect#1 并挂起在门槛上（在途）
    await waitCollects(base + 1);      // 确保 daemon 已进入 collect#1
    assert.equal(_probeStats().collects, base + 1, 'collect#1 应已启动并挂在门槛上');
    bustProbeStatus();                 // 落在在途窗口内：代 +1、清缓存、断在途
    const before = _probeStats().collects;
    release();                         // 放行 collect#1（旧逻辑此刻会回填覆盖 bust）
    const after = await time();        // 新逻辑：在途已被断 → 开 collect#2；旧逻辑：搭 collect#1 旧结果
    assert.equal(_probeStats().collects, before + 1, 'bust 后必须执行一次全新计算（在途结果按代丢弃）');
    await cold;                        // collect#1 最终完成：回填被代比对丢弃
    assert.equal(_probeStats().collects, before + 1, '旧 collect 完成不得触发额外计算');
    const hit = await time();
    assert.ok(hit < 200, `新 collect 的结果应已入缓存（实得 ${hit}ms）`);
    assert.ok(after >= 0);
  } finally {
    _setProbeGate(null);
    server.close();
    await closeArchiveStream();
  }
});

test('去重语义不破：同代并发请求共享一次 collect（门槛挂起期间 3 并发只跑 1 次）', async () => {
  const { startDaemon, bustProbeStatus, _probeStats, _setProbeGate } = await import('../src/daemon.js');
  const { closeArchiveStream } = await import('../src/logger.js');
  const { server, port } = await startDaemon(0, '127.0.0.1');
  const time = async () => { const t0 = Date.now(); const r = await fetch(`http://127.0.0.1:${port}/api/status`); await r.json(); return Date.now() - t0; };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitCollects = async (n, timeoutMs = 5000) => {
    const t0 = Date.now();
    while (_probeStats().collects < n && Date.now() - t0 < timeoutMs) await sleep(20);
  };
  try {
    let release;
    const gate = new Promise((r) => { release = r; });
    const base = _probeStats().collects;
    _setProbeGate(gate);
    bustProbeStatus();
    const reqs = [time(), time(), time()];   // 同代并发：第一个开 collect 并挂起，后两个应搭它
    await waitCollects(base + 1);
    assert.equal(_probeStats().collects, base + 1, '3 并发只启动一次 collect（其余搭在途）');
    release();
    await Promise.all(reqs);
    assert.equal(_probeStats().collects, base + 1, '放行后仍只算一次');
    const hit = await time();
    assert.ok(hit < 200 && _probeStats().collects === base + 1, '缓存可用且不再触发计算');
  } finally {
    _setProbeGate(null);
    server.close();
    await closeArchiveStream();
  }
});
