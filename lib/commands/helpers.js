const SITE = 'xiaohongshu.com';
const tokenCache = require('../token-cache');

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

/** 从 args 中提取 note_id（第一个非 flag 参数） */
function getNoteId(args) {
  return args.find(a => !a.startsWith('--')) || null;
}

/** 从 args 中获取 xsec_token，先查 --token 参数，再查缓存 */
function resolveXToken(args, noteId) {
  const idx = args.indexOf('--token');
  if (idx !== -1 && args[idx + 1] && !args[idx + 1].startsWith('--')) {
    return args[idx + 1];
  }
  if (noteId) {
    const cached = tokenCache.get(noteId);
    if (cached) return cached.xsec_token;
  }
  return null;
}

module.exports = { SITE, getFlag, formatComment, getNoteId, resolveXToken };
