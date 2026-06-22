// tests/p2-entities.test.js — v3 P2 实体表 + whois 测试
//
// 关键不变量：
// 1. comments.upsertMany 把同 cid 多次写入合并：first_seen 取早，last_seen 取晚
// 2. users.upsertMany 累加 commentDelta；comment_count 等于实际观察次数
// 3. notes.markGet/markPost 维护 last_get_ts / last_post_ts
// 4. cmdGet（测试中用 persist 直接调）正确把原始评论树落到 users + comments
// 5. cmdWhois 输出 found / 评论列表 / my_replies
// 6. notes.list 支持 isMine 过滤

const fs = require('fs');
const path = require('path');
const os = require('os');

function withTempProject(fn) {
  return async () => {
    const id = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xhs-p2-' + id + '-'));
    const origStorageEnv = process.env.XHS_STORAGE_DIR;
    const origLogEnv = process.env.XHS_LOG_DIR;
    const origCwd = process.cwd();
    process.env.XHS_STORAGE_DIR = path.join(tmp, 'storage');
    process.env.XHS_LOG_DIR = path.join(tmp, 'logs');
    process.chdir(tmp);
    [
      '../lib/memory/db', '../lib/memory/events',
      '../lib/memory/users', '../lib/memory/comments', '../lib/memory/notes',
      '../lib/audit',
      '../lib/commands/get', '../lib/commands/whois',
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

describe('P2: comments repo', () => {
  it('upsertMany 合并同 cid：first_seen 取早，last_seen 取晚', withTempProject(async () => {
    const comments = require('../lib/memory/comments');
    comments.upsertMany([
      { cid: 'c1', noteId: 'n1', uid: 'u1', text: 'hi', likes: 5, createdAt: 1700000, seenAt: 2_000_000 },
    ]);
    comments.upsertMany([
      { cid: 'c1', noteId: 'n1', uid: 'u1', text: 'hi', likes: 7, createdAt: 1700000, seenAt: 1_000_000 },
    ]);
    const c = comments.get('c1');
    expect(c.firstSeen).toBe(1_000_000);
    expect(c.lastSeen).toBe(2_000_000);
    expect(c.likes).toBe(7); // COALESCE 覆盖（excluded 非 null）
    expect(c.textHash).toBeTruthy();
  }));

  it('markReplied 标记 replied + reply_cid', withTempProject(async () => {
    const comments = require('../lib/memory/comments');
    comments.upsert({ cid: 'src', noteId: 'n1', uid: 'u1', text: 'q?' });
    expect(comments.markReplied('src', 'n1', 'mine')).toBe(true);
    const c = comments.get('src');
    expect(c.replied).toBe(true);
    expect(c.replyCid).toBe('mine');
  }));

  it('setAnalysis 写入 sentiment + priority', withTempProject(async () => {
    const comments = require('../lib/memory/comments');
    comments.upsert({ cid: 'c1', noteId: 'n1', uid: 'u1', text: 'good' });
    comments.setAnalysis('c1', { sentiment: 'positive', priority: 4 });
    const c = comments.get('c1');
    expect(c.sentiment).toBe('positive');
    expect(c.priority).toBe(4);
  }));

  it('listByUid 按 created_at DESC 跨笔记', withTempProject(async () => {
    const comments = require('../lib/memory/comments');
    comments.upsertMany([
      { cid: 'a', noteId: 'n1', uid: 'u1', text: 'a', createdAt: 100 },
      { cid: 'b', noteId: 'n2', uid: 'u1', text: 'b', createdAt: 300 },
      { cid: 'c', noteId: 'n1', uid: 'u1', text: 'c', createdAt: 200 },
      { cid: 'd', noteId: 'n1', uid: 'other', text: 'd', createdAt: 400 },
    ]);
    const list = comments.listByUid('u1');
    expect(list.map(c => c.cid)).toEqual(['b', 'c', 'a']);
  }));
});

describe('P2: users repo', () => {
  it('upsertMany 累加 commentDelta', withTempProject(async () => {
    const users = require('../lib/memory/users');
    users.upsertMany([
      { uid: 'u1', nickname: 'A', commentDelta: 1 },
      { uid: 'u1', nickname: 'A', commentDelta: 1 },
      { uid: 'u1', nickname: 'A', commentDelta: 1 },
    ]);
    const u = users.get('u1');
    expect(u.commentCount).toBe(3);
  }));

  it('setTier + addTag/removeTag', withTempProject(async () => {
    const users = require('../lib/memory/users');
    users.upsert({ uid: 'u1' });
    users.setTier('u1', 'vip');
    users.addTag('u1', '技术粉');
    users.addTag('u1', '常提问');
    users.addTag('u1', '技术粉'); // 去重
    users.removeTag('u1', '常提问');
    const u = users.get('u1');
    expect(u.tier).toBe('vip');
    expect(u.tags).toEqual(['技术粉']);
  }));
});

describe('P2: notes repo', () => {
  it('markGet 累加 totalCommentsSeen + 维护 last_get_ts', withTempProject(async () => {
    const notes = require('../lib/memory/notes');
    notes.markGet('n1', 5, 1000);
    notes.markGet('n1', 3, 2000);
    const n = notes.get('n1');
    expect(n.totalCommentsSeen).toBe(8);
    expect(n.lastGetTs).toBe(2000);
  }));

  it('markPost 维护 last_post_ts，is_mine 一旦 true 不回退', withTempProject(async () => {
    const notes = require('../lib/memory/notes');
    notes.upsert({ noteId: 'n1', isMine: true, title: 'My Note' });
    notes.markPost('n1', 5000);
    notes.upsert({ noteId: 'n1', isMine: false }); // 不应回退
    const n = notes.get('n1');
    expect(n.isMine).toBe(true);
    expect(n.title).toBe('My Note');
    expect(n.lastPostTs).toBe(5000);
  }));

  it('list 支持 isMine 过滤', withTempProject(async () => {
    const notes = require('../lib/memory/notes');
    notes.upsert({ noteId: 'n1', isMine: true, title: 'Mine' });
    notes.upsert({ noteId: 'n2', isMine: false, title: 'Others' });
    notes.upsert({ noteId: 'n3', isMine: true, title: 'Mine Too' });

    const all = notes.list();
    expect(all).toHaveLength(3);

    const mine = notes.list({ isMine: true });
    expect(mine).toHaveLength(2);
    expect(mine.every(n => n.isMine)).toBe(true);

    const others = notes.list({ isMine: false });
    expect(others).toHaveLength(1);
    expect(others[0].noteId).toBe('n2');
  }));
});

describe('P2: cmdWhois', () => {
  it('已知用户：输出评论列表 + my_replies', withTempProject(async () => {
    const cmdWhois = require('../lib/commands/whois');
    const { AuditLogger } = require('../lib/audit');
    const users = require('../lib/memory/users');
    const comments = require('../lib/memory/comments');

    users.upsert({ uid: 'u1', nickname: 'Alice' });
    users.setTier('u1', 'vip');
    users.addTag('u1', '种子');

    comments.upsert({ cid: 'c1', noteId: 'n1', uid: 'u1', text: 'hi', createdAt: 1700 });
    comments.upsert({ cid: 'mine', noteId: 'n1', uid: 'me', text: 'thanks', createdAt: 1701, parentCid: 'c1' });
    comments.markReplied('c1', 'n1', 'mine');

    const out = await cmdWhois({ audit: new AuditLogger() }, ['u1']);
    expect(out.found).toBe(true);
    expect(out.profile.tier).toBe('vip');
    expect(out.profile.tags).toContain('种子');
    expect(out.total_comments).toBe(1);
    expect(out.total_my_replies).toBe(1);
    expect(out.my_replies[0].cid).toBe('mine');
  }));

  it('未知用户：found=false 但不抛', withTempProject(async () => {
    const cmdWhois = require('../lib/commands/whois');
    const { AuditLogger } = require('../lib/audit');
    const out = await cmdWhois({ audit: new AuditLogger() }, ['unknown']);
    expect(out.found).toBe(false);
    expect(out.total_comments).toBe(0);
  }));
});
