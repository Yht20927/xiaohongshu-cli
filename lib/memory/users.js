// lib/memory/users.js — 用户实体
//
// 设计要点：
// - upsert：合并语义。新字段非空才覆盖；first_seen 取早，last_seen 取晚；comment_count/reply_count 累加。
// - tier 用枚举字符串，不强校验（避免后续扩展时改 schema）。
// - tags 是 JSON 数组字符串，addTag/removeTag 自动去重。
// - 所有写操作 try/catch，SQL 失败返回 null，不影响主流程。

const { getDb } = require('./db');

const PLATFORM = 'xhs';

function upsert(fields) {
  if (!fields || !fields.uid) return false;
  try {
    const db = getDb();
    const seenAt = fields.seenAt || Date.now();
    const cd = fields.commentDelta || 0;
    const rd = fields.replyDelta || 0;
    db.prepare(`
      INSERT INTO users (uid, platform, sec_uid, nickname, first_seen, last_seen, comment_count, reply_count)
      VALUES (@uid, @platform, @secUid, @nickname, @seenAt, @seenAt, @cd, @rd)
      ON CONFLICT(platform, uid) DO UPDATE SET
        sec_uid = COALESCE(excluded.sec_uid, sec_uid),
        nickname = COALESCE(excluded.nickname, nickname),
        first_seen = MIN(first_seen, excluded.first_seen),
        last_seen  = MAX(last_seen, excluded.last_seen),
        comment_count = comment_count + @cd,
        reply_count   = reply_count + @rd
    `).run({
      uid: String(fields.uid),
      platform: PLATFORM,
      secUid: fields.secUid || null,
      nickname: fields.nickname || null,
      seenAt,
      cd,
      rd,
    });
    return true;
  } catch (e) {
    if (process.env.XHS_DEBUG) console.warn('[users.upsert] failed:', e.message);
    return false;
  }
}

function upsertMany(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return 0;
  try {
    const db = getDb();
    const stmt = db.prepare(`
      INSERT INTO users (uid, platform, sec_uid, nickname, first_seen, last_seen, comment_count, reply_count)
      VALUES (@uid, @platform, @secUid, @nickname, @seenAt, @seenAt, @cd, @rd)
      ON CONFLICT(platform, uid) DO UPDATE SET
        sec_uid = COALESCE(excluded.sec_uid, sec_uid),
        nickname = COALESCE(excluded.nickname, nickname),
        first_seen = MIN(first_seen, excluded.first_seen),
        last_seen  = MAX(last_seen, excluded.last_seen),
        comment_count = comment_count + @cd,
        reply_count   = reply_count + @rd
    `);
    const tx = db.transaction((rows) => {
      let n = 0;
      for (const e of rows) {
        if (!e || !e.uid) continue;
        stmt.run({
          uid: String(e.uid),
          platform: PLATFORM,
          secUid: e.secUid || null,
          nickname: e.nickname || null,
          seenAt: e.seenAt || Date.now(),
          cd: e.commentDelta != null ? e.commentDelta : 1,
          rd: e.replyDelta || 0,
        });
        n++;
      }
      return n;
    });
    return tx(entries);
  } catch (e) {
    if (process.env.XHS_DEBUG) console.warn('[users.upsertMany] failed:', e.message);
    return 0;
  }
}

function get(uid) {
  if (!uid) return null;
  try {
    const db = getDb();
    const row = db.prepare(`
      SELECT uid, platform, sec_uid, nickname, first_seen, last_seen,
             comment_count, reply_count, tier, tags_json, notes
      FROM users WHERE platform = ? AND uid = ?
    `).get(PLATFORM, String(uid));
    if (!row) return null;
    return {
      uid: row.uid,
      platform: row.platform,
      secUid: row.sec_uid,
      nickname: row.nickname,
      firstSeen: row.first_seen,
      lastSeen: row.last_seen,
      commentCount: row.comment_count,
      replyCount: row.reply_count,
      tier: row.tier,
      tags: row.tags_json ? safeParse(row.tags_json) : [],
      notes: row.notes,
    };
  } catch (e) {
    if (process.env.XHS_DEBUG) console.warn('[users.get] failed:', e.message);
    return null;
  }
}

function setTier(uid, tier) {
  if (!uid) return false;
  try {
    upsert({ uid });
    getDb().prepare(`UPDATE users SET tier = ? WHERE platform = ? AND uid = ?`)
      .run(tier || null, PLATFORM, String(uid));
    return true;
  } catch (e) { return false; }
}

function addTag(uid, tag) {
  if (!uid || !tag) return false;
  try {
    upsert({ uid });
    const u = get(uid);
    const tags = new Set(u && u.tags || []);
    tags.add(String(tag));
    return _writeTags(uid, [...tags]);
  } catch (e) { return false; }
}

function removeTag(uid, tag) {
  if (!uid || !tag) return false;
  try {
    const u = get(uid);
    if (!u) return false;
    const tags = (u.tags || []).filter(t => t !== tag);
    return _writeTags(uid, tags);
  } catch (e) { return false; }
}

function setNotes(uid, notes) {
  if (!uid) return false;
  try {
    upsert({ uid });
    getDb().prepare(`UPDATE users SET notes = ? WHERE platform = ? AND uid = ?`)
      .run(notes || null, PLATFORM, String(uid));
    return true;
  } catch (e) { return false; }
}

function list(opts = {}) {
  try {
    const db = getDb();
    const where = ['platform = ?'];
    const params = [PLATFORM];
    if (opts.tier) { where.push('tier = ?'); params.push(opts.tier); }
    const limit = Math.max(1, Math.min(opts.limit || 100, 10000));
    const rows = db.prepare(`
      SELECT uid, sec_uid, nickname, first_seen, last_seen, comment_count, reply_count, tier, tags_json
      FROM users WHERE ${where.join(' AND ')}
      ORDER BY COALESCE(last_seen, 0) DESC LIMIT ${limit}
    `).all(...params);
    return rows.map(r => ({
      uid: r.uid,
      nickname: r.nickname,
      tier: r.tier,
      commentCount: r.comment_count,
      replyCount: r.reply_count,
      lastSeen: r.last_seen,
      tags: r.tags_json ? safeParse(r.tags_json) : [],
    }));
  } catch (e) { return []; }
}

function count() {
  try {
    return getDb().prepare(`SELECT count(*) AS n FROM users WHERE platform = ?`).get(PLATFORM).n;
  } catch (e) { return 0; }
}

function _writeTags(uid, tags) {
  getDb().prepare(`UPDATE users SET tags_json = ? WHERE platform = ? AND uid = ?`)
    .run(JSON.stringify(tags), PLATFORM, String(uid));
  return true;
}

function safeParse(s) {
  try { return JSON.parse(s); } catch (e) { return []; }
}

module.exports = { upsert, upsertMany, get, setTier, addTag, removeTag, setNotes, list, count };
