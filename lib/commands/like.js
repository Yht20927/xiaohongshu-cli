// lib/commands/like.js — 点赞评论（写操作，noRetry）

const { getNoteId, SITE } = require('./helpers');

async function cmdLike(ctx, args) {
  const noteId = getNoteId(args);
  const nonFlag = args.filter(a => !a.startsWith('--'));
  const commentId = nonFlag[1];
  if (!noteId || !commentId) throw new Error('usage: node cli.js like <note_id> <comment_id>');

  ctx.audit.startOperation('like', { note_id: noteId, comment_id: commentId });

  const t0 = Date.now();
  const expr = `window.__bridge.likeComment(${JSON.stringify(noteId)}, ${JSON.stringify(commentId)})`;
  try {
    const resp = await ctx.bridge.call({ site: SITE, expression: expr, awaitPromise: true, noRetry: true });
    if (!resp.ok) throw new Error(resp.error || 'Bridge Server 返回未知错误');
    const { convertKeys } = require('../shared/caseConvert');
    const v = convertKeys(resp.value);
    if (v && typeof v === 'object' && 'code' in v && v.code !== 0 && v.code !== '0') {
      throw new Error('like failed: ' + (v.msg || ('code=' + v.code)));
    }
    ctx.audit.logApiCall('likeComment', { note_id: noteId, comment_id: commentId }, Date.now() - t0, 'success', {});
  } catch (e) {
    ctx.audit.logApiCall('likeComment', { note_id: noteId, comment_id: commentId }, Date.now() - t0, 'error', { error: e.message });
    ctx.audit.endOperation('error', {}, null, e.message);
    throw e;
  }

  const result = { status: 'liked', comment_id: commentId };
  ctx.audit.endOperation('success', {}, { result });
  return result;
}

module.exports = cmdLike;
