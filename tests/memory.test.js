// tests/memory.test.js — SQLite 记忆层端到端
const { withTempProject } = require('./withTempProject');

afterEach(() => {
  // 不在这里 close db；withTempProject 已处理
});

describe('memory layer', () => {
  it('migrates schema to v3 on first open', async () => {
    await withTempProject(() => {
      const db = require('../lib/memory/db');
      const handle = db.getDb();
      expect(handle.pragma('user_version', { simple: true })).toBe(3);
      // 表都存在
      const tables = handle.prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all().map(r => r.name);
      expect(tables).toEqual(expect.arrayContaining(['comments', 'events', 'failure_patterns', 'notes', 'reply_corpus', 'users']));
    });
  });

  it('self-heals when db file deleted', async () => {
    await withTempProject(({ storageDir }) => {
      const fs = require('fs');
      const path = require('path');
      const db = require('../lib/memory/db');
      const events = require('../lib/memory/events');
      events.append({ command: 'get', status: 'success', noteId: 'n1' });
      expect(events.count()).toBe(1);
      // 删除 db 文件 + 关闭句柄 + 清缓存模拟跨进程
      db.closeDb();
      const dbFile = path.join(storageDir, 'xiaohongshu.db');
      try { fs.unlinkSync(dbFile); } catch (_) {}
      try { fs.unlinkSync(dbFile + '-wal'); } catch (_) {}
      try { fs.unlinkSync(dbFile + '-shm'); } catch (_) {}
      delete require.cache[require.resolve('../lib/memory/db')];
      delete require.cache[require.resolve('../lib/memory/events')];
      const events2 = require('../lib/memory/events');
      // 重建后 events 应为 0，但 append 仍然可写
      expect(events2.count()).toBe(0);
      expect(events2.append({ command: 'get', status: 'success', noteId: 'n2' })).toBeTruthy();
      expect(events2.count()).toBe(1);
    });
  });

  it('users.upsertMany merges with COALESCE semantics', async () => {
    await withTempProject(() => {
      const users = require('../lib/memory/users');
      users.upsertMany([{ uid: 'u1', nickname: 'alice', commentDelta: 1 }]);
      users.upsertMany([{ uid: 'u1', commentDelta: 2 }]); // 不传 nickname
      const u = users.get('u1');
      expect(u.nickname).toBe('alice');     // 旧值保留
      expect(u.commentCount).toBe(3);       // 累加
    });
  });

  it('comments.upsert supports text_hash and listByNote', async () => {
    await withTempProject(() => {
      const comments = require('../lib/memory/comments');
      comments.upsertMany([
        { cid: 'c1', noteId: 'n1', uid: 'u1', text: '你好' },
        { cid: 'c2', noteId: 'n1', uid: 'u2', text: '不错' },
      ]);
      const got = comments.get('c1');
      expect(got.text).toBe('你好');
      expect(got.textHash).toBeTruthy();
      expect(comments.listByNote('n1').length).toBe(2);
    });
  });

  it('events.findLastFetchTime returns max ts of successful gets', async () => {
    await withTempProject(() => {
      const events = require('../lib/memory/events');
      const t1 = Date.now() - 60_000;
      const t2 = Date.now();
      events.append({ ts: t1, command: 'get', status: 'success', noteId: 'n1' });
      events.append({ ts: t2, command: 'get', status: 'success', noteId: 'n1' });
      events.append({ ts: t2 + 1000, command: 'get', status: 'error', noteId: 'n1' }); // 不算
      expect(events.findLastFetchTime('n1')).toBe(Math.floor(t2 / 1000));
      expect(events.findLastFetchTime('absent')).toBe(null);
    });
  });

  it('audit.endOperation double-writes to events table', async () => {
    await withTempProject(() => {
      const { AuditLogger } = require('../lib/audit');
      const events = require('../lib/memory/events');
      const a = new AuditLogger();
      a.startOperation('get', { note_id: 'n1' });
      a.endOperation('success', { count: 5 });
      const list = events.query({ command: 'get', noteId: 'n1' });
      expect(list.length).toBe(1);
      expect(list[0].status).toBe('success');
      expect(list[0].summary.count).toBe(5);
    });
  });
});
