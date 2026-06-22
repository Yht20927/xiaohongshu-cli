// lib/commands/suggest.js — LLM 回复建议（可自动发布，含反馈闭环）
//
// 改造点：
// - 喂 LLM「成功语料 few-shot」+「失败避雷清单」+「严禁复用清单」
// - 发布前 corpus.findByText 去重护栏，命中则单条 LLM 重写一次
// - 修 BUG：s.cid 缺失的建议直接跳过，不再 cmdPost 空 note_id

const fs = require('fs');
const path = require('path');
const { getFlag, getNoteId } = require('./helpers');

const DEFAULT_POST_INTERVAL_MS = 60000;

let mem = null;
function memory() {
  if (mem === null) {
    try {
      mem = {
        corpus: require('../memory/corpus'),
        failures: require('../memory/failures'),
      };
    } catch (e) { mem = false; }
  }
  return mem || null;
}

async function cmdSuggest(ctx, args) {
  const noteId = getNoteId(args);
  if (!noteId) throw new Error('用法: node cli.js suggest <note_id> [--auto] [--min-priority N]');
  const auto = args.includes('--auto');
  const minPriority = getFlag(args, '--min-priority', 0);
  const postInterval = getFlag(args, '--interval', DEFAULT_POST_INTERVAL_MS);

  const llm = require('../llm');
  ctx.audit.startOperation('suggest', { note_id: noteId, auto, min_priority: minPriority });

  // 先分析（cmdAnalyze 内部会拉评论 + 写 sentiment/priority 回 comments 表）
  console.error('正在分析评论...');
  let analysis;
  try {
    analysis = await ctx.cmdAnalyze([noteId]);
  } catch (e) {
    ctx.audit.endOperation('error', {}, null, e.message);
    throw e;
  }

  if (!analysis || analysis.length === 0) {
    console.error('没有需要回复的评论。');
    ctx.audit.endOperation('success', { suggested: 0 });
    return [];
  }

  // 筛选需回复的
  const toReply = analysis.filter(a => a.priority >= minPriority && a.sentiment !== 'negative');

  // 读取策略文件
  let strategy = '';
  try { strategy = fs.readFileSync(path.join(process.cwd(), 'reply-strategy.md'), 'utf8'); } catch (e) { /* */ }

  // 反馈闭环：拼装 context（corpus few-shot + failures 避雷 + avoid 严禁复用）
  const m = memory();
  let context = {};
  if (m) {
    try {
      const recent = m.corpus.recent({ limit: 20, noteId });
      context = {
        corpus: recent.map(r => ({ srcText: r.srcText, replyText: r.replyText })),
        failures: m.failures.top(10),
        avoid: m.corpus.recent({ limit: 30 }).map(r => r.replyText).filter(Boolean),
      };
    } catch (_) {}
  }

  const client = new llm.LLMClient(ctx.config.llm || {});
  let suggestions = await client.suggestReplies(toReply, strategy, '', context);

  // 单条 dedup guard：命中 corpus 的回复让 LLM 重写一次（再次命中就放行/标记）
  if (m && m.corpus) {
    for (let i = 0; i < suggestions.length; i++) {
      const s = suggestions[i];
      if (!s.reply) continue;
      const hit = m.corpus.findByText(s.reply);
      if (hit) {
        try {
          console.error(`[suggest] dedup 命中，重写 cid=${s.cid} 原回复="${s.reply.slice(0, 30)}..."`);
          const newReply = await client.rewriteReply(
            (toReply.find(t => t.cid === s.cid) || {}).summary || '',
            s.reply,
            strategy,
          );
          if (newReply && !m.corpus.findByText(newReply)) {
            suggestions[i] = { ...s, reply: newReply, _rewritten: true };
          } else {
            suggestions[i] = { ...s, _duplicate: true };
          }
        } catch (e) {
          if (process.env.XHS_DEBUG) console.warn('[suggest] rewrite failed:', e.message);
          suggestions[i] = { ...s, _duplicate: true };
        }
      }
    }
  }

  const results = [];
  const autoList = suggestions.slice(0, 30);
  let postedCount = 0;

  for (let i = 0; i < autoList.length; i++) {
    const s = autoList[i];
    // BUG 修复：cid 缺失的建议直接跳过，不再 cmdPost 空 note_id
    if (auto && s.reply && s.cid && !s._duplicate) {
      if (postedCount > 0) {
        console.error(`[suggest] 等待 ${postInterval / 1000}s 后发布下一条... (${postedCount + 1}/${autoList.length})`);
        await new Promise(r => setTimeout(r, postInterval));
      }
      try {
        const postResult = await ctx.cmdPost([noteId, s.reply, '--reply-to', s.cid]);
        results.push({ ...s, posted: true, post_cid: postResult.cid });
        postedCount++;
        console.error(`[suggest] 已发布 ${postedCount}/${autoList.length}: ${s.reply.slice(0, 30)}...`);
      } catch (e) {
        results.push({ ...s, posted: false, error: e.message });
        console.error(`[suggest] 发布失败: ${e.message}`);
      }
    } else {
      if (auto && (!s.cid || s._duplicate)) {
        console.error(`[suggest] 跳过 ${s._duplicate ? '(重复)' : '(无 cid)'}: ${(s.reply || '').slice(0, 30)}`);
      }
      results.push(s);
    }
  }

  ctx.audit.endOperation('success', {
    suggested: results.length,
    posted: auto ? results.filter(r => r.posted).length : 0,
    rewritten: results.filter(r => r._rewritten).length,
    skipped_duplicate: results.filter(r => r._duplicate).length,
  }, { result: results });
  return results;
}

module.exports = cmdSuggest;
