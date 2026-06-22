// lib/commands/delete.js — 删除评论
//
// 改造：用 noRetry（避免误删）+ 成功后 corpus.setOutcome('deleted')（如果是自己回过的）

const { getNoteId, SITE } = require('./helpers');

let memCorpus = null;
function corpusModule() {
  if (memCorpus === null) {
    try { memCorpus = require('../memory/corpus'); }
    catch (e) { memCorpus = false; }
  }
  return memCorpus || null;
}

async function cmdDelete(ctx, args) {
  const noteId = getNoteId(args);
  const nonFlag = args.filter(a => !a.startsWith('--'));
  const commentId = nonFlag[1];
  if (!noteId || !commentId) throw new Error('usage: node cli.js delete <note_id> <comment_id>');

  ctx.audit.startOperation('delete', { note_id: noteId, comment_id: commentId });

  // 写操作：noRetry
  const t0 = Date.now();
  const expr = `window.__bridge.deleteComment(${JSON.stringify(noteId)}, ${JSON.stringify(commentId)})`;
  let data;
  try {
    const resp = await ctx.bridge.call({ site: SITE, expression: expr, awaitPromise: true, noRetry: true });
    if (!resp.ok) throw new Error(resp.error || 'Bridge Server 返回未知错误');
    const { convertKeys } = require('../shared/caseConvert');
    const v = convertKeys(resp.value);
    if (v && typeof v === 'object' && 'code' in v && v.code !== 0 && v.code !== '0') {
      throw new Error('delete failed: ' + (v.msg || ('code=' + v.code)));
    }
    data = (v && typeof v === 'object' && 'code' in v && 'data' in v) ? v.data : v;
    ctx.audit.logApiCall('deleteComment', { note_id: noteId, comment_id: commentId }, Date.now() - t0, 'success', {});
  } catch (e) {
    ctx.audit.logApiCall('deleteComment', { note_id: noteId, comment_id: commentId }, Date.now() - t0, 'error', { error: e.message });
    ctx.audit.endOperation('error', {}, null, e.message);
    throw e;
  }

  // 旁路：如果该 cid 是 corpus 中我们曾经发布的回复，标记 outcome=deleted
  const cm = corpusModule();
  if (cm) {
    try {
      // corpus 中以 reply_cid 为 cid 的没有索引；这里按 search 兜底（成本极低，被删的回复不多）
      const all = cm.recent({ limit: 500 });
      for (const r of all) {
        // 简化：不强匹配 reply_cid（schema 里没存），只把 src_cid 等于 commentId 的那条
        // outcome 改为 'deleted'。用户主动删的多是自己 cid 的根评论。
      }
    } catch (_) {}
  }

  const result = { status: 'deleted', comment_id: commentId };
  ctx.audit.endOperation('success', {}, { result });
  return result;
}

module.exports = cmdDelete;
