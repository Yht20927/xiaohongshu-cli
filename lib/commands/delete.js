// lib/commands/delete.js — 删除评论

const { getNoteId } = require('./helpers');

async function cmdDelete(ctx, args) {
  const noteId = getNoteId(args);
  if (!noteId || args.length < 2) throw new Error('usage: node cli.js delete <note_id> <comment_id>');
  const commentId = args.find((a, i, arr) => i > 0 && !a.startsWith('--') && a !== args[0]);
  if (!commentId) throw new Error('missing comment_id');
  ctx.audit.startOperation('delete', { note_id: noteId, comment_id: commentId });
  const expr = `window.__bridge.deleteComment(${JSON.stringify(noteId)}, ${JSON.stringify(commentId)})`;
  const data = await ctx.loggedCall('deleteComment', { note_id: noteId, comment_id: commentId }, expr);
  if (data && data.code !== undefined && data.code !== 0) {
    throw new Error('delete failed: ' + (data.msg || 'code=' + data.code));
  }
  const result = { status: 'deleted', comment_id: commentId };
  ctx.audit.endOperation('success', {}, { result });
  return result;
}

module.exports = cmdDelete;
