// lib/commands/post.js — 发表评论/回复
//
// 改造点：
// - 通过 BridgeClient `noRetry: true` 调用，避免「写超时但已写入 → 重试 → 重复发布」
// - 成功后旁路写：reply_corpus + comments.markReplied + notes.markPost
// - 失败旁路写：failure_patterns（hit_count++）

const { getFlag, getNoteId, SITE } = require('./helpers');

let mem = null;
function memory() {
  if (mem === null) {
    try {
      mem = {
        corpus: require('../memory/corpus'),
        comments: require('../memory/comments'),
        notes: require('../memory/notes'),
        failures: require('../memory/failures'),
      };
    } catch (e) {
      if (process.env.XHS_DEBUG) console.warn('[post] memory unavailable:', e.message);
      mem = false;
    }
  }
  return mem || null;
}

async function cmdPost(ctx, args) {
  const noteId = getNoteId(args);
  if (!noteId) throw new Error('usage: node cli.js post <note_id> "内容" [--reply-to <cid>]');

  const nonFlagArgs = args.filter(a => !a.startsWith('--'));
  const text = nonFlagArgs[1];
  if (!text) throw new Error('usage: node cli.js post <note_id> "内容" [--reply-to <cid>]');

  const replyTo = getFlag(args, '--reply-to', null);

  ctx.audit.startOperation('post', { note_id: noteId, text, reply_to: replyTo });
  const rto = replyTo ? JSON.stringify(replyTo) : 'null';
  const expr = `window.__bridge.publish(${JSON.stringify(noteId)}, ${JSON.stringify(text)}, ${rto}, [])`;

  // 写操作：直接走 bridge.call(noRetry: true)，不经 loggedCall（loggedCall 内部用 ctx.bridgeCall，
  // ctx.bridgeCall 默认重试），并自行做审计 + 旁路写。
  const t0 = Date.now();
  let data;
  try {
    const resp = await ctx.bridge.call({ site: SITE, expression: expr, awaitPromise: true, noRetry: true });
    if (!resp.ok) throw new Error(resp.error || 'Bridge Server 返回未知错误');
    const { convertKeys } = require('../shared/caseConvert');
    const v = convertKeys(resp.value);
    if (v && typeof v === 'object' && 'code' in v && v.code !== 0 && v.code !== '0') {
      const err = new Error(`xhs[${v.code}] ${v.msg || v.message || 'unknown'}`);
      err.code = v.code;
      err.envelope = v;
      throw err;
    }
    data = (v && typeof v === 'object' && 'code' in v && 'data' in v) ? v.data : v;
    ctx.audit.logApiCall('post', { note_id: noteId, text }, Date.now() - t0, 'success', {});
  } catch (e) {
    ctx.audit.logApiCall('post', { note_id: noteId, text }, Date.now() - t0, 'error', { error: e.message });
    // 失败：记 failure 模式
    const m = memory();
    if (m) {
      try { m.failures.record(e.envelope || e, { exampleText: text.slice(0, 200) }); } catch (_) {}
    }
    ctx.audit.endOperation('error', {}, null, e.message);
    throw e;
  }

  const comment = (data && (data.comment || data.data)) || data || {};
  const result = {
    cid: comment.id || comment.cid || '',
    text: comment.content || comment.text || text,
    time: comment.create_time || comment.time || 0,
    status: 'published',
  };

  // 成功：旁路写 corpus + markReplied + markPost
  const m = memory();
  if (m) {
    try {
      m.corpus.append({
        replyText: text,
        srcCid: replyTo || null,
        noteId,
        postedAt: Date.now(),
        outcome: 'published',
      });
      if (replyTo) m.comments.markReplied(replyTo, noteId, result.cid);
      m.notes.markPost(noteId);
    } catch (_) {}
  }

  ctx.audit.endOperation('success', { cid: result.cid }, { result });
  return result;
}

module.exports = cmdPost;
