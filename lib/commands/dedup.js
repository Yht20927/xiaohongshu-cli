// lib/commands/dedup.js — 检查一段文本是否曾经发过
//
// 用法：
//   node cli.js dedup "<候选回复文本>"
//
// 返回：{ duplicate: bool, match: { id, reply_text, posted_at, ... } | null }

const corpus = require('../memory/corpus');

async function cmdDedup(ctx, args) {
  const text = args.find(a => !a.startsWith('--'));
  if (!text) throw new Error('用法: node cli.js dedup "<候选回复文本>"');

  ctx.audit.startOperation('dedup', { text_len: text.length });
  const match = corpus.findByText(text);
  const out = {
    duplicate: !!match,
    text,
    match: match ? {
      id: match.id,
      reply_text: match.replyText,
      posted_at: match.postedAt ? new Date(match.postedAt).toISOString() : null,
      note_id: match.noteId,
      outcome: match.outcome,
    } : null,
  };
  ctx.audit.endOperation('success', { duplicate: out.duplicate }, null);
  return out;
}

module.exports = cmdDedup;
