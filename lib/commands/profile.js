// lib/commands/profile.js — 用户交互历史
//
// v2 改造：
// - 真正按 uid 过滤（既往实现忽略 uid 参数）
// - 优先走 SQLite events + comments 表，audit.json 全表扫作为兜底

let mem = null;
function memory() {
  if (mem === null) {
    try {
      mem = {
        events: require('../memory/events'),
        users: require('../memory/users'),
        comments: require('../memory/comments'),
      };
    } catch (e) { mem = false; }
  }
  return mem || null;
}

async function cmdProfile(ctx, args) {
  const uid = args.find(a => !a.startsWith('--'));
  if (!uid) throw new Error('用法: node cli.js profile <uid>');

  const out = { uid, source: null, profile: null, comments_by_user: [], my_replies_to_user: [] };

  // ── 路径 A：SQLite ──
  const m = memory();
  if (m) {
    try {
      const u = m.users.get(uid);
      const userComments = m.comments.listByUid(uid, { limit: 200 });
      // 我们对该用户回过的：events 里 command='post' 且某条该用户评论的 reply_cid 与 events.cid 对应
      // 简化：直接用 comments 表里 replied=1 的子集（user 的评论被回复过）
      const replied = userComments.filter(c => c.replied);

      if (u || userComments.length) {
        out.source = 'sqlite';
        out.profile = u || { uid, nickname: null };
        out.comments_by_user = userComments;
        out.my_replies_to_user = replied.map(c => ({ src_cid: c.cid, reply_cid: c.replyCid, src_text: c.text }));
        return out;
      }
    } catch (e) { /* fall through */ }
  }

  // ── 路径 B：audit.json 兜底（早期未写 SQLite 的会话） ──
  out.source = 'audit.json';
  const a = ctx.audit.load();
  const interactions = [];
  for (const s of (a.sessions || [])) {
    for (const op of (s.operations || [])) {
      if (op.command === 'post' && op.args && op.args.uid === uid) {
        interactions.push({ time: op.started, type: 'replied-by-uid', op_index: op.index });
      }
    }
  }
  out.profile = { uid };
  out.my_replies_to_user = interactions;
  return out;
}

module.exports = cmdProfile;
