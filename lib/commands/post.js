// lib/commands/post.js — 发表评论/回复

const { getFlag, getNoteId } = require('./helpers');

async function cmdPost(ctx, args) {
  const noteId = getNoteId(args);
  if (!noteId) throw new Error('usage: node cli.js post <note_id> "内容" [--reply-to <cid>]');

  // 第一个非-flag 参数是 note_id，第二个非-flag 参数是内容
  const nonFlagArgs = args.filter(a => !a.startsWith('--'));
  const text = nonFlagArgs[1];
  if (!text) throw new Error('usage: node cli.js post <note_id> "内容" [--reply-to <cid>]');

  const replyTo = getFlag(args, '--reply-to', null);

  ctx.audit.startOperation('post', { note_id: noteId, text, reply_to: replyTo });
  const rto = replyTo ? JSON.stringify(replyTo) : 'null';
  const expr = `window.__bridge.publish(${JSON.stringify(noteId)}, ${JSON.stringify(text)}, ${rto}, [])`;
  const data = await ctx.loggedCall('post', { note_id: noteId, text }, expr);

  if (data && data.code !== undefined && data.code !== 0) {
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
