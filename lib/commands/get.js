// lib/commands/get.js — 获取笔记评论
//
// 行为：
// - 翻页拉取，可 --all（不限页数）+ --depth 1（拉子评论）
// - --new / --since <ts>：增量拉取，cutoff 之前的评论会被过滤掉，但**不会提前 break**
//   （因为置顶评论 create_time 较旧，但后面分页里仍可能出现新评论；只有 has_more=false / 空页才停）
// - 旁路写 SQLite：comments / users / notes 实体表 upsert（事务批量）

const { getFlag, formatComment, getNoteId, resolveXToken } = require('./helpers');
const tokenCache = require('../token-cache');

const REPLY_CONCURRENCY = 3;

let mem = null;
function memory() {
  if (mem === null) {
    try {
      mem = {
        comments: require('../memory/comments'),
        users: require('../memory/users'),
        notes: require('../memory/notes'),
      };
    } catch (e) {
      if (process.env.XHS_DEBUG) console.warn('[get] memory unavailable:', e.message);
      mem = false;
    }
  }
  return mem || null;
}

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

// 批量旁路写 SQLite：评论 + 用户 + 笔记
function persist(noteId, rawComments) {
  const m = memory();
  if (!m) return;
  try {
    // users
    const userMap = new Map();
    const commentRows = [];
    const collect = (c, parentCid) => {
      const u = c.user || {};
      const uid = u.user_id || u.id || null;
      if (uid && !userMap.has(uid)) {
        userMap.set(uid, {
          uid,
          nickname: u.nickname || u.screen_name || null,
          commentDelta: 0, // 累加在循环里
        });
      }
      if (uid) userMap.get(uid).commentDelta++;
      commentRows.push({
        cid: c.id || c.cid,
        noteId,
        uid,
        text: c.content || c.text || null,
        likes: Number(c.like_count || c.likes || 0) || 0,
        createdAt: Number(c.create_time || c.time || 0) || null,
        pinned: !!c.pinned,
        parentCid: parentCid || null,
      });
      const subs = c.sub_comments || c.children || [];
      for (const s of subs) collect(s, c.id || c.cid);
    };
    for (const c of rawComments) collect(c, null);

    if (commentRows.length) m.comments.upsertMany(commentRows);
    if (userMap.size) m.users.upsertMany([...userMap.values()]);
    m.notes.markGet(noteId, commentRows.length);
  } catch (e) {
    if (process.env.XHS_DEBUG) console.warn('[get.persist] failed:', e.message);
  }
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
  const rawAll = []; // 原始 comments，含子评论，用于持久化
  let cursor = "";
  let pageCount = 0;

  while (pageCount < pages) {
    const expr = `window.__bridge.getComments(${JSON.stringify(noteId)}, ${JSON.stringify(cursor)}, ${perPage}, ${JSON.stringify(xtoken || '')})`;
    const data = await ctx.loggedCall('getComments', { note_id: noteId, cursor, count: perPage, has_token: !!xtoken }, expr);
    const comments = data.comments || [];
    pageCount++;

    // 关键修复：cutoff 命中后**只过滤、不 break**，避免置顶评论让真正的新评论被丢弃
    let filtered = comments;
    if (cutoff) {
      filtered = comments.filter(c => (c.create_time || 0) > cutoff);
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
          comment.sub_comments = children; // 给 persist 用，含原始字段
        }
      }
    }

    rawAll.push(...filtered);
    allComments.push(...filtered);
    if (!data.has_more || comments.length === 0) break;
    cursor = data.cursor || "";
  }

  // 旁路写 SQLite（失败静默）
  persist(noteId, rawAll);

  const result = allComments.map(formatComment);
  ctx.audit.endOperation('success', { comments: result.length, pages: pageCount }, { comments: result });
  return result;
}

module.exports = cmdGet;
