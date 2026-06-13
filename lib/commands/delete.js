const { escapeExpression } = require('./helpers');

async function cmdDelete(ctx, args) {
  const noteId = args[0];
  const commentId = args[1];
  if (!noteId || !commentId) throw new Error('usage: node cli.js delete <note_id> <comment_id>');
  ctx.audit.startOperation('delete', { note_id: noteId, comment_id: commentId });
  const expr = 'window.__bridge.deleteComment(' + JSON.stringify(noteId) + ', ' + JSON.stringify(commentId) + ')';
  const data = await ctx.loggedCall('deleteComment', { note_id: noteId, comment_id: commentId }, expr);
  if (data.code !== undefined && data.code !== 0) {
    throw new Error('delete failed: ' + (data.msg || 'code=' + data.code));
  }
  const result = { status: 'deleted', comment_id: commentId };
  ctx.audit.endOperation('success', {}, { result });
  return result;
}

module.exports = cmdDelete;
