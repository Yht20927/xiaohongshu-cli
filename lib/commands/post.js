const { escapeExpression, getFlag } = require('./helpers');

async function cmdPost(ctx, args) {
  const noteId = args[0];
  const text = args[1];
  if (!noteId || !text) throw new Error('usage: node cli.js post <note_id> <text> [--reply-to <cid>]');
  const replyTo = getFlag(args, '--reply-to', null);

  ctx.audit.startOperation('post', { note_id: noteId, text, reply_to: replyTo });
  const rto = replyTo ? JSON.stringify(replyTo) : 'null';
  const expr = 'window.__bridge.publish(' + JSON.stringify(noteId) + ', ' + JSON.stringify(text) + ', ' + rto + ', [])';
  const data = await ctx.loggedCall('post', { note_id: noteId, text }, expr);

  if (data.code !== undefined && data.code !== 0) {
    const err = new Error(data.msg || ('code=' + data.code));
    ctx.audit.endOperation('error', { code: data.code }, null, err.message);
    throw err;
  }

  const comment = (data.comment || data.data || {});
  const result = {
    cid: comment.id || comment.cid || '',
    text: comment.content || comment.text || text,
    time: comment.create_time || comment.time || 0,
    status: 'published',
  };
  ctx.audit.endOperation('success', { cid: result.cid }, { result });
  return result;
}

module.exports = cmdPost;
