// lib/commands/get.js — 获取笔记评论

const { getFlag, formatComment, getNoteId, resolveXToken } = require('./helpers');
const tokenCache = require('../token-cache');

const REPLY_CONCURRENCY = 3;

async function promiseAllLimit(tasks, limit) {
  const results = new Array(tasks.length);
  let nextIdx = 0;
  async function worker() {
    while (nextIdx < tasks.length) {
      const idx = nextIdx++;
      results[idx] = await tasks[idx]();
    }
  }
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

async function fetchAllReplies(ctx, noteId, rootCommentId, limit, xtoken) {
  const all = [];
  let cursor = "";
  const pageSize = Math.min(20, limit || 50);
  while (all.length < (limit || 50)) {
    const expr = `window.__bridge.getSubComments(${JSON.stringify(noteId)}, ${JSON.stringify(rootCommentId)}, ${JSON.stringify(cursor)}, ${pageSize}, ${JSON.stringify(xtoken || '')})`;
    const data = await ctx.bridgeCall(expr);
    const comments = data.comments || [];
    all.push(...comments);
    if (!data.has_more || comments.length === 0) break;
    cursor = data.cursor || "";
  }
  return all.slice(0, limit || 50);
}

async function cmdGet(ctx, args) {
  const noteId = getNoteId(args);
  if (!noteId) throw new Error('用法: node cli.js get <note_id> [--all] [--depth N] [--new] [--since <ts>] [--token <xsec_token>]');

  const all = args.includes('--all');
  const depth = getFlag(args, '--depth', 0);
  const perPage = getFlag(args, '--count', 20);
  const replyLimit = getFlag(args, '--reply-limit', 50);
  const pages = getFlag(args, '--pages', all ? Infinity : 1);
  const isNew = args.includes('--new');
  const since = getFlag(args, '--since', null);

  const xtoken = resolveXToken(args, noteId);

  let cutoff = null;
  if (isNew) {
    cutoff = ctx.audit.findLastFetchTime(noteId);
    if (!cutoff) console.error('[info] 无历史拉取记录，回退为全量');
  } else if (since) {
    cutoff = Number(since);
  }

  const startOpArgs = { note_id: noteId, all, depth, pages, has_token: !!xtoken };
  if (cutoff) startOpArgs.since = cutoff;
  ctx.audit.startOperation('get', startOpArgs);

  const allComments = [];
  let cursor = "";
  let pageCount = 0;

  while (pageCount < pages) {
    const expr = `window.__bridge.getComments(${JSON.stringify(noteId)}, ${JSON.stringify(cursor)}, ${perPage}, ${JSON.stringify(xtoken || '')})`;
    const data = await ctx.loggedCall('getComments', { note_id: noteId, cursor, count: perPage, has_token: !!xtoken }, expr);
    const comments = data.comments || [];
    pageCount++;

    let filtered = comments;
    if (cutoff) {
      filtered = comments.filter(c => (c.create_time || 0) > cutoff);
      if (filtered.length < comments.length) {
        allComments.push(...filtered);
        break;
      }
    }

    if (depth >= 1) {
      const replyTasks = filtered
        .filter(c => (c.sub_comment_count || 0) > 0)
        .map(c => async () => {
          const children = await fetchAllReplies(ctx, noteId, c.id || c.cid, replyLimit, xtoken);
          return { comment: c, children };
        });

      if (replyTasks.length > 0) {
        const replyResults = await promiseAllLimit(replyTasks, REPLY_CONCURRENCY);
        for (const { comment, children } of replyResults) {
          comment.children = children.map(formatComment);
        }
      }
    }

    allComments.push(...filtered);
    if (!data.has_more || comments.length === 0) break;
    cursor = data.cursor || "";
  }

  const result = allComments.map(formatComment);
  ctx.audit.endOperation('success', { comments: result.length, pages: pageCount }, { comments: result });
  return result;
}

module.exports = cmdGet;
