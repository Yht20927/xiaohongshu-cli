// tests/p1-commands.test.js — P1 命令切 SQL 的回归测试
//
// 不变量：
// 1. cmdLog 走 SQL 路径，能正确按 --note / --failed / --command / --uid 过滤
// 2. cmdProfile 走 SQL 路径时按 uid 精确匹配；events 为空时回退 audit.json
// 3. cmdEvents 输出 SQLite 行（含 sessionId / id / args / summary）
// 4. AuditLogger.findLastFetchTime 走 SQL，命中索引

const fs = require('fs');
const path = require('path');
const os = require('os');

function withTempProject(fn) {
  return async () => {
    const id = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xhs-p1-' + id + '-'));
    const origStorageEnv = process.env.XHS_STORAGE_DIR;
    const origLogEnv = process.env.XHS_LOG_DIR;
    const origCwd = process.cwd();
    process.env.XHS_STORAGE_DIR = path.join(tmp, 'storage');
    process.env.XHS_LOG_DIR = path.join(tmp, 'logs');
    process.chdir(tmp);
    [
      '../lib/memory/db', '../lib/memory/events', '../lib/audit',
      '../lib/commands/log', '../lib/commands/profile', '../lib/commands/events',
    ].forEach(m => {
      try { delete require.cache[require.resolve(m)]; } catch (e) {}
    });
    try {
      await fn(tmp);
    } finally {
      try { require('../lib/memory/db').closeDb(); } catch (e) { /* */ }
      process.chdir(origCwd);
      if (origStorageEnv == null) delete process.env.XHS_STORAGE_DIR;
      else process.env.XHS_STORAGE_DIR = origStorageEnv;
      if (origLogEnv == null) delete process.env.XHS_LOG_DIR;
      else process.env.XHS_LOG_DIR = origLogEnv;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  };
}

/** 静默 console.log 抓输出 */
function captureLog(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.map(String).join(' '));
  try { return Promise.resolve(fn()).then(r => ({ result: r, output: lines.join('\n') })); }
  finally { console.log = orig; }
}

describe('P1: cmdLog (SQL path)', () => {
  it('按 --note --failed 过滤（audit.json 路径）', withTempProject(async () => {
    const cmdLog = require('../lib/commands/log');
    const fakeAudit = { load: () => ({
      sessions: [
        { operations: [
          { command: 'get', status: 'success', args: { note_id: 'n1' }, started: '2026-01-01T00:00:00.000Z' },
          { command: 'post', status: 'error', args: { note_id: 'n1' }, started: '2026-01-01T00:01:00.000Z' },
          { command: 'like', status: 'success', args: { note_id: 'n2' }, started: '2026-01-01T00:02:00.000Z' },
        ] },
      ],
    }) };

    const all = await captureLog(() => cmdLog({ audit: fakeAudit }, []));
    expect(all.output).toContain('get');
    expect(all.output).toContain('post');
    expect(all.output).toContain('like');

    const failed = await captureLog(() => cmdLog({ audit: fakeAudit }, ['--failed']));
    expect(failed.output).toContain('post');
    expect(failed.output).not.toContain('like');

    const n1Only = await captureLog(() => cmdLog({ audit: fakeAudit }, ['--note', 'n1']));
    expect(n1Only.output).toContain('n1');
    expect(n1Only.output).not.toContain('n2');
  }));
});

describe('P1: cmdProfile (SQL path)', () => {
  it('uid 精确匹配 SQLite users + comments 表', withTempProject(async () => {
    const users = require('../lib/memory/users');
    const comments = require('../lib/memory/comments');
    const cmdProfile = require('../lib/commands/profile');

    users.upsert({ uid: 'u123', nickname: 'Alice' });
    comments.upsert({ cid: 'c1', noteId: 'n1', uid: 'u123', text: 'hi' });
    comments.upsert({ cid: 'c2', noteId: 'n2', uid: 'u123', text: 'hello' });

    const r = await cmdProfile({ audit: { load: () => ({ sessions: [] }) } }, ['u123']);
    expect(r.uid).toBe('u123');
    expect(r.source).toBe('sqlite');
    expect(r.profile.nickname).toBe('Alice');
    expect(r.comments_by_user).toHaveLength(2);
  }));

  it('SQLite 无数据时回退 audit.json (v2 行为)', withTempProject(async () => {
    const cmdProfile = require('../lib/commands/profile');
    const fakeAudit = { load: () => ({
      sessions: [{ operations: [{
        command: 'post', status: 'success',
        args: { uid: 'u_anything' },
        started: '2026-01-01T00:00:00.000Z',
      }] }],
    }) };
    const r = await cmdProfile({ audit: fakeAudit }, ['u_anything']);
    expect(r.source).toBe('audit.json');
    expect(r.my_replies_to_user).toHaveLength(1);
  }));
});

describe('P1: cmdEvents', () => {
  it('--json 输出原始行（含 sessionId/id）', withTempProject(async () => {
    const events = require('../lib/memory/events');
    const cmdEvents = require('../lib/commands/events');
    events.append({ ts: 1000, command: 'get', status: 'success', noteId: 'n1', sessionId: 's1' });
    const rows = await cmdEvents({}, ['--json']);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBeTypeOf('number');
    expect(rows[0].command).toBe('get');
  }));

  it('--since 数字下界过滤', withTempProject(async () => {
    const events = require('../lib/memory/events');
    const cmdEvents = require('../lib/commands/events');
    events.append({ ts: 1000, command: 'get', status: 'success' });
    events.append({ ts: 5000, command: 'post', status: 'success' });
    const rows = await cmdEvents({}, ['--json', '--since', '3000']);
    expect(rows).toHaveLength(1);
    expect(rows[0].command).toBe('post');
  }));
});

describe('P1: findLastFetchTime SQL', () => {
  it('优先 SQL，empty 时回退 audit.json', withTempProject(async () => {
    const { AuditLogger } = require('../lib/audit');
    const events = require('../lib/memory/events');
    events.append({ ts: 5000000, command: 'get', status: 'success', noteId: 'n1' });
    events.append({ ts: 6000000, command: 'get', status: 'success', noteId: 'n1' });
    const a = new AuditLogger();
    expect(a.findLastFetchTime('n1')).toBe(6000); // ms→sec

    // events 没有 n_only_audit_json，应走 audit.json
    const fakeAudit = { load: () => ({
      sessions: [{ operations: [{
        command: 'get', status: 'success', ended: '2026-06-01T00:00:00.000Z',
        args: { note_id: 'n_only_audit_json' },
      }] }],
    }) };
    a.load = fakeAudit.load.bind(fakeAudit);
    expect(a.findLastFetchTime('n_only_audit_json')).toBeGreaterThan(0);
  }));
});
