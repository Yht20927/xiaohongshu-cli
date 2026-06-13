const { escapeExpression, formatComment, getFlag } = require('./helpers');
const tokenCache = require('../token-cache');

async function cmdReplies(ctx, args) {
  const noteId = args[0];
  const cid = args[1];
  if (!noteId || !cid) throw new Error('usage: node cli.js replies <note_id> <comment_id> [--token <xsec_token>]');
  let xtoken = getFlag(args, '--token', null);
  if (!xtoken) {
    const cached = tokenCache.get(noteId);
    if (cached) xtoken = cached.xsec_token;
  }
  ctx.audit.startOperation('replies', { note_id: noteId, cid, has_token: !!xtoken });
  const expr = 'window.__bridge.getSubComments(' + JSON.stringify(noteId) + ', ' + JSON.stringify(cid) + ', \'\', 50, ' + JSON.stringify(xtoken || '') + ')';
  const data = await ctx.loggedCall('getSubComments', { note_id: noteId, cid, has_token: !!xtoken }, expr);
  const comments = (data.comments || []).map(formatComment);
  ctx.audit.endOperation('success', { count: comments.length }, { comments });
  return comments;
}

module.exports = cmdReplies;
