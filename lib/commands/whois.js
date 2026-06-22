// lib/commands/whois.js — 用户全量画像（v3 P2）
//
// 输出某用户跨笔记的全部交互：
//   - 基本信息（nickname / first_seen / last_seen / counts / tier / tags / notes）
//   - 该用户的全部评论（带 sentiment / priority / 是否被我回复）
//   - 我们对该用户的回复（reply_count，逐条文本）
//
// 数据全部来自 SQLite 实体表：
//   users / comments（uid 维度索引）
// 没有数据时返回空骨架，不报错。

let mem = null;
function memory() {
  if (mem === null) {
    try {
      mem = {
        users: require('../memory/users'),
        comments: require('../memory/comments'),
      };
    } catch (e) {
      if (process.env.XHS_DEBUG) console.warn('[whois] memory unavailable:', e.message);
      mem = false;
    }
  }
  return mem || null;
}

/**
 * @param {object} ctx
 * @param {string[]} args - [uid]
 */
async function cmdWhois(ctx, args) {
  const uid = args[0];
  if (!uid) throw new Error('用法: node cli.js whois <uid>');

  ctx.audit.startOperation('whois', { uid });

  const m = memory();
  if (!m) {
    const out = { uid, profile: null, found: false, total_comments: 0, total_my_replies: 0, comments: [], my_replies: [] };
    ctx.audit.endOperation('success', { found: false, comments: 0, my_replies: 0 }, null);
    return out;
  }

  const user = m.users.get(uid);
  const allComments = m.comments.listByUid(uid, { limit: 500 });

  // 把"我对此用户的回复"单独抽出：comments 表里 parent 是这个用户写的某条 → reply_cid 指向我发的那条
  const replied = allComments.filter(c => c.replied);
  const repliedCids = new Set(replied.map(c => c.replyCid).filter(Boolean));
  const myReplies = repliedCids.size > 0
    ? Array.from(repliedCids).map(c => m.comments.get(c)).filter(Boolean)
    : [];

  const out = {
    uid,
    profile: user ? {
      nickname: user.nickname,
      sec_uid: user.secUid,
      first_seen: user.firstSeen ? new Date(user.firstSeen).toISOString() : null,
      last_seen:  user.lastSeen  ? new Date(user.lastSeen).toISOString()  : null,
      comment_count: user.commentCount,
      reply_count:   user.replyCount,
      tier: user.tier,
      tags: user.tags || [],
      notes: user.notes || null,
    } : null,
    found: !!user,
    total_comments: allComments.length,
    total_my_replies: myReplies.length,
    comments: allComments.map(c => ({
      cid: c.cid,
      note_id: c.noteId,
      text: c.text,
      likes: c.likes,
      created_at: c.createdAt ? new Date(c.createdAt * 1000).toISOString() : null,
      sentiment: c.sentiment,
      priority: c.priority,
      replied: c.replied,
      reply_cid: c.replyCid,
    })),
    my_replies: myReplies.map(c => ({
      cid: c.cid,
      note_id: c.noteId,
      parent_cid: c.parentCid,
      text: c.text,
      created_at: c.createdAt ? new Date(c.createdAt * 1000).toISOString() : null,
    })),
  };

  ctx.audit.endOperation('success', {
    found: out.found,
    comments: out.total_comments,
    my_replies: out.total_my_replies,
  }, null);

  return out;
}

module.exports = cmdWhois;
