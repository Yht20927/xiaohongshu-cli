// lib/commands/suggest.js — LLM 回复建议（可自动发布）

const fs = require('fs');
const path = require('path');
const { getFlag } = require('./helpers');

const POST_INTERVAL_MS = 60000; // 每条评论间隔 60 秒，防止风控

/**
 * LLM 回复建议
 * @param {object} ctx - { bridge, audit, config, cmdAnalyze, cmdPost }
 * @param {string[]} args - [aweme_id, --auto, --min-priority N]
 */
async function cmdSuggest(ctx, args) {
  const awemeId = args[0];
  if (!awemeId) throw new Error('用法: node cli.js suggest <aweme_id> [--auto] [--min-priority N]');
  const auto = args.includes('--auto');
  const minPriority = getFlag(args, '--min-priority', 0);

  const llm = require('../llm');
  ctx.audit.startOperation('suggest', { aweme_id: awemeId, auto, min_priority: minPriority });

  // 先分析
  console.error('正在分析评论...');
  let analysis;
  try {
    analysis = await ctx.cmdAnalyze([awemeId]);
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

  // 读取策略
  let strategy = '';
  try { strategy = fs.readFileSync(path.join(process.cwd(), 'reply-strategy.md'), 'utf8'); } catch (e) { /* */ }

  const client = new llm.LLMClient(ctx.config.llm || {});
  const suggestions = await client.suggestReplies(toReply, strategy);

  const results = [];
  const autoList = suggestions.slice(0, 30);
  let postedCount = 0;

  for (let i = 0; i < autoList.length; i++) {
    const s = autoList[i];
    if (auto && s.reply) {
      // 非首条发布前等待间隔
      if (postedCount > 0) {
        console.error(`⏳ 等待 ${POST_INTERVAL_MS / 1000}s 后发布下一条... (${postedCount + 1}/${autoList.length})`);
        await new Promise(r => setTimeout(r, POST_INTERVAL_MS));
      }
      try {
        const postResult = await ctx.cmdPost([s.aweme_id || awemeId, s.reply, '--reply-to', s.cid]);
        results.push({ ...s, posted: true, post_cid: postResult.cid });
        postedCount++;
        console.error(`✓ 已发布 ${postedCount}/${autoList.length}: ${s.reply.slice(0, 30)}...`);
      } catch (e) {
        results.push({ ...s, posted: false, error: e.message });
        console.error(`✗ 发布失败: ${e.message}`);
      }
    } else {
      results.push(s);
    }
  }

  ctx.audit.endOperation('success', {
    suggested: results.length,
    posted: auto ? results.filter(r => r.posted).length : 0,
  }, { result: results });
  return results;
}

module.exports = cmdSuggest;
