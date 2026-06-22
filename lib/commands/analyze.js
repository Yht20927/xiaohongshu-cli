// lib/commands/analyze.js — LLM 评论分析（情感/分类/优先级）
//
// 改造：分析结果旁路写回 comments 表（sentiment/priority），便于 suggest 和 dashboard 复用。

const fs = require('fs');
const path = require('path');
const { getNoteId } = require('./helpers');

let memComments = null;
function commentsModule() {
  if (memComments === null) {
    try { memComments = require('../memory/comments'); }
    catch (e) { memComments = false; }
  }
  return memComments || null;
}

async function cmdAnalyze(ctx, args) {
  const noteId = getNoteId(args);
  if (!noteId) throw new Error('用法: node cli.js analyze <note_id>');

  const llm = require('../llm');
  ctx.audit.startOperation('analyze', { note_id: noteId });

  // 先获取评论
  console.error('正在获取评论...');
  const commentsData = await ctx.cmdGet([noteId, '--all', '--depth', '0']);

  if (!commentsData || commentsData.length === 0) {
    ctx.audit.endOperation('success', { analyzed: 0 }, { result: [] });
    return [];
  }

  console.error(`正在分析 ${commentsData.length} 条评论...`);
  const client = new llm.LLMClient(ctx.config.llm || {});
  // 把 cid + text 显式映射给 LLM（cmdGet 返回的是 formatComment 后的 {cid,text,...}）
  const forLLM = commentsData.map(c => ({ cid: c.cid, text: c.text }));
  const results = await client.analyzeComments(forLLM, ctx.config.llm || {});
  if (!results || results.length === 0) {
    console.error('警告: LLM 未返回分析结果');
  }

  // 旁路写回 comments 表
  const cm = commentsModule();
  if (cm) {
    try {
      for (const r of results) {
        if (r && r.cid) cm.setAnalysis(r.cid, { sentiment: r.sentiment, priority: r.priority });
      }
    } catch (_) {}
  }

  // 落盘 analyze 报告
  const ts = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
  const resultsDir = path.join(process.cwd(), 'logs', 'results');
  try { fs.mkdirSync(resultsDir, { recursive: true }); } catch (_) {}
  const fp = path.join(resultsDir, `analyze-${noteId}-${ts}.json`);
  try { fs.writeFileSync(fp, JSON.stringify(results, null, 2)); } catch (_) {}

  ctx.audit.endOperation('success', { analyzed: results.length }, {
    result: results,
    resultFile: 'logs/results/' + path.basename(fp),
  });
  return results;
}

module.exports = cmdAnalyze;
