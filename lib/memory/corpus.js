// lib/memory/corpus.js — 回复语料库
//
// 设计要点：
// - 每条「我们发布过的回复」入表一行，reply_hash = md5(normalize(reply_text))，
//   用于去重护栏（同一句不要再发第二次）。
// - outcome：published / risk_blocked / deleted / unknown。
// - 所有 SQL 包 try/catch，失败返回 null/false/0/[]。

const { getDb } = require('./db');
const { hashText, normalizeText } = require('./comments');

const PLATFORM = 'xhs';

function append(fields) {
  if (!fields || !fields.replyText) return null;
  try {
    const db = getDb();
    const info = db.prepare(`
      INSERT INTO reply_corpus (
        platform, src_cid, src_text, reply_text, reply_hash,
        note_id, posted_at, outcome
      ) VALUES (
        @platform, @srcCid, @srcText, @replyText, @replyHash,
        @noteId, @postedAt, @outcome
      )
    `).run({
      platform: PLATFORM,
      srcCid: fields.srcCid || null,
      srcText: fields.srcText != null ? String(fields.srcText) : null,
      replyText: String(fields.replyText),
      replyHash: hashText(fields.replyText),
      noteId: fields.noteId || null,
      postedAt: fields.postedAt || Date.now(),
      outcome: fields.outcome || 'published',
    });
    return info.lastInsertRowid;
  } catch (e) {
    if (process.env.XHS_DEBUG) console.warn('[corpus.append] failed:', e.message);
    return null;
  }
}

function findByText(replyText) {
  if (!replyText) return null;
  try {
    const row = getDb().prepare(`
      SELECT id, reply_text, posted_at, outcome, note_id
      FROM reply_corpus WHERE platform = ? AND reply_hash = ?
      ORDER BY posted_at DESC LIMIT 1
    `).get(PLATFORM, hashText(replyText));
    if (!row) return null;
    return {
      id: row.id,
      replyText: row.reply_text,
      postedAt: row.posted_at,
      outcome: row.outcome,
      noteId: row.note_id,
    };
  } catch (e) { return null; }
}

function recent(opts = {}) {
  try {
    const db = getDb();
    const limit = Math.max(1, Math.min(opts.limit || 20, 200));
    const where = ['platform = ?'];
    const params = [PLATFORM];
    const outcomes = opts.outcomes || ['published'];
    if (outcomes.length > 0) {
      where.push(`outcome IN (${outcomes.map(() => '?').join(',')})`);
      params.push(...outcomes);
    }
    if (opts.noteId) { where.push('note_id = ?'); params.push(opts.noteId); }
    const rows = db.prepare(`
      SELECT id, src_cid, src_text, reply_text, note_id, posted_at, outcome, effectiveness
      FROM reply_corpus WHERE ${where.join(' AND ')}
      ORDER BY COALESCE(posted_at, 0) DESC LIMIT ${limit}
    `).all(...params);
    return rows.map(_map);
  } catch (e) { return []; }
}

function search(keyword, opts = {}) {
  if (!keyword) return [];
  try {
    const db = getDb();
    const limit = Math.max(1, Math.min(opts.limit || 50, 500));
    const like = `%${String(keyword).replace(/[%_]/g, m => '\\' + m)}%`;
    const rows = db.prepare(`
      SELECT id, src_cid, src_text, reply_text, note_id, posted_at, outcome, effectiveness
      FROM reply_corpus
      WHERE platform = ? AND (src_text LIKE ? ESCAPE '\\' OR reply_text LIKE ? ESCAPE '\\')
      ORDER BY COALESCE(posted_at, 0) DESC LIMIT ${limit}
    `).all(PLATFORM, like, like);
    return rows.map(_map);
  } catch (e) { return []; }
}

function setOutcome(id, outcome) {
  if (!id) return false;
  try {
    getDb().prepare(`UPDATE reply_corpus SET outcome = ? WHERE id = ?`).run(outcome || null, id);
    return true;
  } catch (e) { return false; }
}

function setEffectiveness(id, value) {
  if (!id) return false;
  try {
    getDb().prepare(`UPDATE reply_corpus SET effectiveness = ? WHERE id = ?`).run(value, id);
    return true;
  } catch (e) { return false; }
}

function count(opts = {}) {
  try {
    const db = getDb();
    const where = ['platform = ?'];
    const params = [PLATFORM];
    if (opts.outcome) { where.push('outcome = ?'); params.push(opts.outcome); }
    if (opts.noteId)  { where.push('note_id = ?'); params.push(opts.noteId); }
    return db.prepare(`SELECT count(*) AS n FROM reply_corpus WHERE ${where.join(' AND ')}`)
      .get(...params).n;
  } catch (e) { return 0; }
}

function _map(r) {
  return {
    id: r.id,
    srcCid: r.src_cid,
    srcText: r.src_text,
    replyText: r.reply_text,
    noteId: r.note_id,
    postedAt: r.posted_at,
    outcome: r.outcome,
    effectiveness: r.effectiveness,
  };
}

module.exports = {
  append, findByText, recent, search, setOutcome, setEffectiveness, count,
  hashText, normalizeText,
};
