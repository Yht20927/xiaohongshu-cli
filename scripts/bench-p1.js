#!/usr/bin/env node
// scripts/bench-p1.js — P1 性能基线
//
// 目标：验证在 5 万行 events 下：
//   - findLastFetchTime          < 5 ms
//   - cmdLog --tail 20           < 100 ms
//   - cmdProfile                 < 100 ms
//   - cmdEvents --tail 100       < 100 ms
//
// 用法：
//   node scripts/bench-p1.js              # 默认 5 万行
//   node scripts/bench-p1.js 100000       # 自定义规模

const fs = require('fs');
const path = require('path');

// 独立 storage 防污染主库
const realStorage = path.join(__dirname, '..', 'storage');
fs.rmSync(realStorage, { recursive: true, force: true });

// 设置环境变量指向项目根 storage
process.env.XHS_STORAGE_DIR = realStorage;

const events = require('../lib/memory/events');
const { getDb } = require('../lib/memory/db');

const N = parseInt(process.argv[2] || '50000', 10);
console.log(`Bench: 写入 ${N} 行 events ...`);

// ── 写入 ──
const tWrite0 = Date.now();
const db = getDb();
const insert = db.prepare(`
  INSERT INTO events (ts, session_id, command, status, duration_ms, note_id, uid, cid, args_json, summary_json)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const COMMANDS = ['get', 'post', 'like', 'search', 'replies', 'analyze'];
const STATUSES = ['success', 'success', 'success', 'error']; // 75% success
const NOTES = Array.from({ length: 200 }, (_, i) => 'n' + i);
const UIDS = Array.from({ length: 1000 }, (_, i) => 'u' + i);

const tx = db.transaction(() => {
  const now = Date.now();
  for (let i = 0; i < N; i++) {
    const cmd = COMMANDS[i % COMMANDS.length];
    const status = STATUSES[i % STATUSES.length];
    insert.run(
      now - (N - i) * 1000,
      'sess-' + Math.floor(i / 100),
      cmd,
      status,
      100 + (i % 1000),
      NOTES[i % NOTES.length],
      cmd === 'post' || cmd === 'like' ? UIDS[i % UIDS.length] : null,
      null,
      JSON.stringify({ idx: i }),
      JSON.stringify({ count: i % 50 })
    );
  }
});
tx();
console.log(`  写入耗时: ${Date.now() - tWrite0} ms`);
console.log(`  总行数: ${db.prepare('SELECT count(*) AS n FROM events').get().n}`);

// ── 基准测试 ──
function bench(name, target, fn) {
  fn(); // warmup
  const runs = 10;
  const t0 = Date.now();
  for (let i = 0; i < runs; i++) fn();
  const avg = (Date.now() - t0) / runs;
  const ok = avg < target;
  origLog(`  ${ok ? '✓' : '✗'} ${name.padEnd(40)} avg=${avg.toFixed(2)}ms  (target < ${target}ms)`);
  return ok;
}

const origLog = console.log;
function silenced(fn) {
  return (...a) => { console.log = () => {}; try { return fn(...a); } finally { console.log = origLog; } };
}

origLog('\nBench 结果（10 次平均）:');

const cmdLog = require('../lib/commands/log');
const cmdProfile = require('../lib/commands/profile');
const cmdEvents = require('../lib/commands/events');

let passed = 0, total = 0;

total++;
if (bench('events.findLastFetchTime', 5, () => {
  events.findLastFetchTime(NOTES[Math.floor(Math.random() * NOTES.length)]);
})) passed++;

total++;
if (bench('cmdLog --tail 20', 100, silenced(() =>
  cmdLog({ audit: { load: () => ({ sessions: [] }) } }, ['--tail', '20'])
))) passed++;

total++;
if (bench('cmdLog --note n0 --failed', 100, silenced(() =>
  cmdLog({ audit: { load: () => ({ sessions: [] }) } }, ['--note', 'n0', '--failed'])
))) passed++;

total++;
if (bench('cmdProfile <uid>', 100, silenced(() =>
  cmdProfile({ audit: { load: () => ({ sessions: [] }) } }, [UIDS[10]])
))) passed++;

total++;
if (bench('cmdEvents --tail 100', 100, silenced(() =>
  cmdEvents({}, ['--tail', '100'])
))) passed++;

origLog(`\nResult: ${passed}/${total} passed`);

// 清理
db.close();
fs.rmSync(realStorage, { recursive: true, force: true });

process.exit(passed === total ? 0 : 1);
