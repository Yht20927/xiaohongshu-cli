// lib/memory/comments.js — 评论实体
//
// 设计要点：
// - 主键 (platform, cid)；upsert 合并语义：first_seen 取早，last_seen 取晚；
//   text/likes/sentiment/priority/replied/reply_cid 仅在 excluded 非空 / 非默认时才覆盖。
// - text_hash 用于跨评论去重，由调用方传入或由本模块自动 md5(normalize(text))。
// - 所有写操作 try/catch，失败返回 false/0/null，不污染主流程。

const crypto = require('crypto');
const { getDb } = require('./db');

const PLATFORM = 'xhs';

/** 文本规范化：去首尾空白 + 折叠空白 + 转小写。 */
function normalizeText(s) {
  return String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function hashText(s) {
  if (!s) return null;
  return crypto.createHash('md5').update(normalizeText(s), 'utf8').digest('hex');
}

function upsert(fields) {
  if (!fields || !fields.cid || !fields.noteId) return false;
  try {
    const db = getDb();
    _upsertStmt(db).run(_paramsFor(fields));
    return true;
  } catch (e) {
    if (process.env.XHS_DEBUG) console.warn('[comments.upsert] failed:', e.message);
    return false;
  }
}

function upsertMany(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return 0;
  try {
    const db = getDb();
    const stmt = _upsertStmt(db);
    const tx = db.transaction((rows) => {
      let n = 0;
      for (const e of rows) {
        if (!e || !e.cid || !e.noteId) continue;
        stmt.run(_paramsFor(e));
        n++;
      }
      return n;
    });
    return tx(entries);
  } catch (e) {
    if (process.env.XHS_DEBUG) console.warn('[comments.upsertMany] failed:', e.message);
    return 0;
  }
}

function _upsertStmt(db) {
  return db.prepare(`
    INSERT INTO comments (
      cid, platform, note_id, uid, text, text_hash, likes, created_at,
      pinned, parent_cid, first_seen, last_seen
    ) VALUES (
      @cid, @platform, @noteId, @uid, @text, @textHash, @likes, @createdAt,
      @pinned, @parentCid, @seenAt, @seenAt
    )
    ON CONFLICT(platform, cid) DO UPDATE SET
      note_id    = excluded.note_id,
      uid        = COALESCE(excluded.uid, uid),
      text       = COALESCE(excluded.text, text),
      text_hash  = COALESCE(excluded.text_hash, text_hash),
      likes      = COALESCE(excluded.likes, likes),
      created_at = COALESCE(excluded.created_at, created_at),
      pinned     = CASE WHEN excluded.pinned = 1 THEN 1 ELSE pinned END,
      parent_cid = COALESCE(excluded.parent_cid, parent_cid),
      first_seen = MIN(COALESCE(first_seen, excluded.first_seen), excluded.first_seen),
      last_seen  = MAX(COALESCE(last_seen, 0), excluded.last_seen)
  `);
}

function _paramsFor(f) {
  return {
    cid: String(f.cid),
    platform: PLATFORM,
    noteId: String(f.noteId),
    uid: f.uid ? String(f.uid) : null,
    text: f.text != null ? String(f.text) : null,
    textHash: f.text != null ? hashText(f.text) : null,
    likes: f.likes != null ? Number(f.likes) : null,
    createdAt: f.createdAt != null ? Number(f.createdAt) : null,
    pinned: f.pinned ? 1 : 0,
    parentCid: f.parentCid || null,
    seenAt: f.seenAt || Date.now(),
  };
}

/**
 * 标记某条评论已被回复。
 */
function markReplied(cid, noteId, replyCid) {
  if (!cid || !noteId) return false;
  try {
    upsert({ cid, noteId });
    getDb().prepare(`UPDATE comments SET replied = 1, reply_cid = ? WHERE platform = ? AND cid = ?`)
      .run(replyCid || null, PLATFORM, String(cid));
    return true;
  } catch (e) {
    if (process.env.XHS_DEBUG) console.warn('[comments.markReplied] failed:', e.message);
    return false;
  }
}

/** 写入 LLM 分析结果。 */
function setAnalysis(cid, { sentiment, priority }) {
  if (!cid) return false;
  try {
    getDb().prepare(`UPDATE comments SET sentiment = ?, priority = ? WHERE platform = ? AND cid = ?`)
      .run(sentiment || null, priority != null ? Number(priority) : null, PLATFORM, String(cid));
    return true;
  } catch (e) { return false; }
}

function get(cid) {
  if (!cid) return null;
  try {
    const row = getDb().prepare(`
      SELECT cid, platform, note_id, uid, text, text_hash, likes, created_at,
             pinned, parent_cid, sentiment, priority, replied, reply_cid,
             first_seen, last_seen
      FROM comments WHERE platform = ? AND cid = ?
    `).get(PLATFORM, String(cid));
    if (!row) return null;
    return {
      cid: row.cid,
      noteId: row.note_id,
      uid: row.uid,
      text: row.text,
      textHash: row.text_hash,
      likes: row.likes,
      createdAt: row.created_at,
      pinned: !!row.pinned,
      parentCid: row.parent_cid,
      sentiment: row.sentiment,
      priority: row.priority,
      replied: !!row.replied,
      replyCid: row.reply_cid,
      firstSeen: row.first_seen,
      lastSeen: row.last_seen,
    };
  } catch (e) { return null; }
}

function listByUid(uid, opts = {}) {
  if (!uid) return [];
  try {
    const limit = Math.max(1, Math.min(opts.limit || 200, 10000));
    const rows = getDb().prepare(`
      SELECT cid, note_id, text, likes, created_at, sentiment, priority, replied, reply_cid
      FROM comments WHERE platform = ? AND uid = ?
      ORDER BY COALESCE(created_at, 0) DESC LIMIT ${limit}
    `).all(PLATFORM, String(uid));
    return rows.map(_mapShort);
  } catch (e) { return []; }
}

function listByNote(noteId, opts = {}) {
  if (!noteId) return [];
  try {
    const limit = Math.max(1, Math.min(opts.limit || 200, 10000));
    const where = ['platform = ?', 'note_id = ?'];
    const params = [PLATFORM, String(noteId)];
    if (opts.replied != null) { where.push('replied = ?'); params.push(opts.replied ? 1 : 0); }
    if (opts.sentiment) { where.push('sentiment = ?'); params.push(opts.sentiment); }
    const rows = getDb().prepare(`
      SELECT cid, note_id, uid, text, likes, created_at, sentiment, priority, replied, reply_cid
      FROM comments WHERE ${where.join(' AND ')}
      ORDER BY COALESCE(priority, 0) DESC, COALESCE(likes, 0) DESC
      LIMIT ${limit}
    `).all(...params);
    return rows.map(_mapShort);
  } catch (e) { return []; }
}

function _mapShort(r) {
  return {
    cid: r.cid,
    noteId: r.note_id,
    uid: r.uid,
    text: r.text,
    likes: r.likes,
    createdAt: r.created_at,
    sentiment: r.sentiment,
    priority: r.priority,
    replied: !!r.replied,
    replyCid: r.reply_cid,
  };
}

function count(opts = {}) {
  try {
    const where = ['platform = ?'];
    const params = [PLATFORM];
    if (opts.noteId) { where.push('note_id = ?'); params.push(String(opts.noteId)); }
    if (opts.uid)    { where.push('uid = ?');     params.push(String(opts.uid)); }
    if (opts.replied != null) { where.push('replied = ?'); params.push(opts.replied ? 1 : 0); }
    return getDb().prepare(`SELECT count(*) AS n FROM comments WHERE ${where.join(' AND ')}`)
      .get(...params).n;
  } catch (e) { return 0; }
}

/**
 * 查询已回复的评论 cid 列表，供 Skill 层去重。
 * filters: { noteId, since }，均为可选。
 */
function listReplied(filters = {}, opts = {}) {
  try {
    const db = getDb();
    const where = ['platform = ?', 'replied = 1'];
    const params = [PLATFORM];
    if (filters.noteId) { where.push('note_id = ?'); params.push(String(filters.noteId)); }
    if (filters.since)   { where.push('last_seen >= ?'); params.push(Number(filters.since)); }
    const limit = Math.max(1, Math.min(opts.limit || 10000, 100000));
    const rows = db.prepare(`
      SELECT cid, note_id, reply_cid, last_seen
      FROM comments
      WHERE ${where.join(' AND ')}
      ORDER BY last_seen DESC
      LIMIT ${limit}
    `).all(...params);
    return rows.map(r => ({
      cid: r.cid,
      noteId: r.note_id,
      replyCid: r.reply_cid,
      lastSeen: r.last_seen,
    }));
  } catch (e) {
    if (process.env.XHS_DEBUG) console.warn('[comments.listReplied] failed:', e.message);
    return [];
  }
}

module.exports = {
  upsert, upsertMany, get, markReplied, setAnalysis,
  listByUid, listByNote, listReplied, count, hashText, normalizeText,
};
