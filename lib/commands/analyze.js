// lib/commands/analyze.js — LLM 评论分析（情感/分类/优先级）

const fs = require('fs');
const path = require('path');
const { getNoteId } = require('./helpers');

/**
 * LLM 分析评论
 * @param {object} ctx - { bridge, audit, config, cmdGet }
 * @param {string[]} args - [note_id]
 */
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
  const results = await client.analyzeComments(commentsData);
  if (!results || results.length === 0) {
    console.error('警告: LLM 未返回分析结果');
  }

  const ts = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
  const fp = path.join(process.cwd(), 'logs', 'results', `analyze-${noteId}-${ts}.json`);
  fs.writeFileSync(fp, JSON.stringify(results, null, 2));

  ctx.audit.endOperation('success', { analyzed: results.length }, {
    result: results,
    resultFile: 'logs/results/' + path.basename(fp),
  });
  return results;
}

module.exports = cmdAnalyze;
