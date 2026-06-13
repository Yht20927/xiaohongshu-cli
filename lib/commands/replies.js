// lib/commands/replies.js — 单条评论的回复

const { getFlag, getNoteId, resolveXToken } = require('./helpers');

async function cmdReplies(ctx, args) {
  const noteId = getNoteId(args);
  if (!noteId || args.length < 2) throw new Error('usage: node cli.js replies <note_id> <comment_id> [--token <xsec_token>]');
  const cid = args.find((a, i, arr) => i > 0 && !a.startsWith('--') && a !== args[0]);
  if (!cid) throw new Error('missing comment_id');
  const xtoken = resolveXToken(args, noteId);
  ctx.audit.startOperation('replies', { note_id: noteId, cid, has_token: !!xtoken });
  const expr = `window.__bridge.getSubComments(${JSON.stringify(noteId)}, ${JSON.stringify(cid)}, '', 50, ${JSON.stringify(xtoken || '')})`;
  const data = await ctx.loggedCall('getSubComments', { note_id: noteId, cid, has_token: !!xtoken }, expr);
  const { formatComment } = require('./helpers');
  const comments = (data.comments || []).map(formatComment);
  ctx.audit.endOperation('success', { count: comments.length }, { comments });
  return comments;
}

module.exports = cmdReplies;
