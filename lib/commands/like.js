const { escapeExpression } = require('./helpers');

async function cmdLike(ctx, args) {
  const noteId = args[0];
  const commentId = args[1];
  if (!noteId || !commentId) throw new Error('usage: node cli.js like <note_id> <comment_id>');
  ctx.audit.startOperation('like', { note_id: noteId, comment_id: commentId });
  const expr = 'window.__bridge.likeComment(' + JSON.stringify(noteId) + ', ' + JSON.stringify(commentId) + ')';
  const data = await ctx.loggedCall('likeComment', { note_id: noteId, comment_id: commentId }, expr);
  if (data.code !== undefined && data.code !== 0) {
    throw new Error('like failed: ' + (data.msg || 'code=' + data.code));
  }
  const result = { status: 'liked', comment_id: commentId };
  ctx.audit.endOperation('success', {}, { result });
  return result;
}

module.exports = cmdLike;
