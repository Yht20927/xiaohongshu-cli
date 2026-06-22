// lib/memory/notes.js — 笔记实体（对应 douyin 的 videos.js）
//
// 设计要点：
// - 主键 (platform, note_id)；upsert 智能合并。
// - is_mine 一旦置 1 不会被覆盖回 0（"once mine, always mine"）。
// - last_get_ts / last_post_ts 各自取 MAX。
// - xsec_token 字段是 token-cache 的持久化升级版（仍由 lib/token-cache.js 维护内存层）。

const { getDb } = require('./db');

const PLATFORM = 'xhs';

function upsert(fields) {
  if (!fields || !fields.noteId) return false;
  try {
    const db = getDb();
    const now = Date.now();
    db.prepare(`
      INSERT INTO notes (
        note_id, platform, title, author_uid, is_mine,
        total_comments_seen, last_get_ts, last_post_ts,
        xsec_token, xsec_source, token_updated_at
      ) VALUES (
        @noteId, @platform, @title, @authorUid, @isMine,
        @totalSeen, @lastGet, @lastPost,
        @xsecToken, @xsecSource, @tokenAt
      )
      ON CONFLICT(platform, note_id) DO UPDATE SET
        title              = COALESCE(excluded.title, title),
        author_uid         = COALESCE(excluded.author_uid, author_uid),
        is_mine            = CASE WHEN excluded.is_mine = 1 THEN 1 ELSE is_mine END,
        total_comments_seen= total_comments_seen + COALESCE(excluded.total_comments_seen, 0),
        last_get_ts        = MAX(COALESCE(last_get_ts, 0), COALESCE(excluded.last_get_ts, 0)),
        last_post_ts       = MAX(COALESCE(last_post_ts, 0), COALESCE(excluded.last_post_ts, 0)),
        xsec_token         = COALESCE(excluded.xsec_token, xsec_token),
        xsec_source        = COALESCE(excluded.xsec_source, xsec_source),
        token_updated_at   = COALESCE(excluded.token_updated_at, token_updated_at)
    `).run({
      noteId: String(fields.noteId),
      platform: PLATFORM,
      title: fields.title || null,
      authorUid: fields.authorUid || null,
      isMine: fields.isMine ? 1 : 0,
      totalSeen: fields.totalSeen != null ? Number(fields.totalSeen) : 0,
      lastGet: fields.lastGetTs != null ? Number(fields.lastGetTs) : null,
      lastPost: fields.lastPostTs != null ? Number(fields.lastPostTs) : null,
      xsecToken: fields.xsecToken || null,
      xsecSource: fields.xsecSource || null,
      tokenAt: fields.xsecToken ? now : null,
    });
    return true;
  } catch (e) {
    if (process.env.XHS_DEBUG) console.warn('[notes.upsert] failed:', e.message);
    return false;
  }
}

function markGet(noteId, totalSeen, ts) {
  return upsert({ noteId, lastGetTs: ts || Date.now(), totalSeen: totalSeen || 0 });
}

function markPost(noteId, ts) {
  return upsert({ noteId, lastPostTs: ts || Date.now() });
}

function get(noteId) {
  if (!noteId) return null;
  try {
    const db = getDb();
    const row = db.prepare(`
      SELECT note_id, platform, title, author_uid, is_mine,
             total_comments_seen, last_get_ts, last_post_ts,
             xsec_token, xsec_source, token_updated_at
      FROM notes WHERE platform = ? AND note_id = ?
    `).get(PLATFORM, String(noteId));
    if (!row) return null;
    return {
      noteId: row.note_id,
      platform: row.platform,
      title: row.title,
      authorUid: row.author_uid,
      isMine: !!row.is_mine,
      totalCommentsSeen: row.total_comments_seen,
      lastGetTs: row.last_get_ts,
      lastPostTs: row.last_post_ts,
      xsecToken: row.xsec_token,
      xsecSource: row.xsec_source,
      tokenUpdatedAt: row.token_updated_at,
    };
  } catch (e) { return null; }
}

function count() {
  try {
    return getDb().prepare(`SELECT count(*) AS n FROM notes WHERE platform = ?`).get(PLATFORM).n;
  } catch (e) { return 0; }
}

/**
 * 列出笔记。
 * @param {object} [opts]
 * @param {boolean} [opts.isMine] 过滤自己的笔记
 * @param {number} [opts.limit] 最大返回数（默认 100，上限 10000）
 * @returns {Array}
 */
function list(opts = {}) {
  try {
    const db = getDb();
    const limit = Math.max(1, Math.min(opts.limit || 100, 10000));
    const where = ['platform = ?'];
    const params = [PLATFORM];
    if (opts.isMine != null) { where.push('is_mine = ?'); params.push(opts.isMine ? 1 : 0); }
    const rows = db.prepare(`
      SELECT note_id, title, author_uid, is_mine,
             total_comments_seen, last_get_ts, last_post_ts,
             xsec_token, xsec_source, token_updated_at
      FROM notes WHERE ${where.join(' AND ')}
      ORDER BY COALESCE(last_get_ts, last_post_ts, 0) DESC
      LIMIT ${limit}
    `).all(...params);
    return rows.map(r => ({
      noteId: r.note_id,
      title: r.title,
      authorUid: r.author_uid,
      isMine: !!r.is_mine,
      totalCommentsSeen: r.total_comments_seen,
      lastGetTs: r.last_get_ts,
      lastPostTs: r.last_post_ts,
      xsecToken: r.xsec_token,
      xsecSource: r.xsec_source,
      tokenUpdatedAt: r.token_updated_at,
    }));
  } catch (e) { return []; }
}

module.exports = { upsert, markGet, markPost, get, count, list };
