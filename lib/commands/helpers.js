const SITE = 'xiaohongshu.com';

function escapeExpression(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function getFlag(args, flag, defaultValue) {
  const idx = args.indexOf(flag);
  if (idx === -1) return defaultValue;
  const val = args[idx + 1];
  if (val === undefined || val.startsWith('--')) return defaultValue;
  const n = Number(val);
  if (isNaN(n)) return val;
  return n;
}

function formatComment(c) {
  const out = {
    cid: c.id || c.cid || '',
    text: (c.content || c.text || '').substring(0, 120),
    likes: c.like_count || c.likes || 0,
    replies: c.sub_comment_count || c.replies || 0,
    pinned: c.pinned || false,
    time: c.create_time || c.time || 0,
    user: c.user ? {
      nickname: c.user.nickname || c.user.screen_name || '',
      user_id: c.user.user_id || c.user.id || '',
      avatar: c.user.avatar || c.user.imageb || '',
    } : null,
  };
  if (c.sub_comments) out.children = c.sub_comments.map(formatComment);
  return out;
}

module.exports = { SITE, escapeExpression, getFlag, formatComment };
