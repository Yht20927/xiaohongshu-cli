// lib/commands/replies.js — 单条评论的回复

const { getNoteId, resolveXToken, formatComment } = require('./helpers');

async function cmdReplies(ctx, args) {
  const noteId = getNoteId(args);
  // 修 BUG：cid===noteId 时旧的 args.find 会取错；改用 filter 取第二个非 flag 参数
  const nonFlag = args.filter(a => !a.startsWith('--'));
  const cid = nonFlag[1];
  if (!noteId || !cid) {
    throw new Error('usage: node cli.js replies <note_id> <comment_id> [--token <xsec_token>]');
  }
  const xtoken = resolveXToken(args, noteId);
  ctx.audit.startOperation('replies', { note_id: noteId, cid, has_token: !!xtoken });
  const expr = `window.__bridge.getSubComments(${JSON.stringify(noteId)}, ${JSON.stringify(cid)}, '', 50, ${JSON.stringify(xtoken || '')})`;
  const data = await ctx.loggedCall('getSubComments', { note_id: noteId, cid, has_token: !!xtoken }, expr);
  const comments = (data.comments || []).map(formatComment);
  ctx.audit.endOperation('success', { count: comments.length }, { comments });
  return comments;
}

module.exports = cmdReplies;
