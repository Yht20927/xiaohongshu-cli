// lib/commands/corpus.js — 回复语料库管理
//
// 用法：
//   node cli.js corpus search <keyword> [--limit N]
//   node cli.js corpus recent [--limit N] [--note <note_id>]
//   node cli.js corpus stats

const corpus = require('../memory/corpus');
const { getFlag } = require('./helpers');

async function cmdCorpus(ctx, args) {
  const sub = args[0];
  if (!sub) {
    throw new Error('用法: node cli.js corpus <search|recent|stats> [...]');
  }

  ctx.audit.startOperation('corpus', { sub });

  let result;
  switch (sub) {
    case 'search': {
      const kw = args[1];
      if (!kw || kw.startsWith('--')) {
        throw new Error('用法: node cli.js corpus search <keyword> [--limit N]');
      }
      const limit = getFlag(args, '--limit', 50);
      result = corpus.search(kw, { limit });
      break;
    }
    case 'recent': {
      const limit = getFlag(args, '--limit', 20);
      const note = getFlag(args, '--note', null);
      result = corpus.recent({ limit, noteId: note || undefined });
      break;
    }
    case 'stats': {
      result = {
        total: corpus.count(),
        published: corpus.count({ outcome: 'published' }),
        risk_blocked: corpus.count({ outcome: 'risk_blocked' }),
        deleted: corpus.count({ outcome: 'deleted' }),
      };
      break;
    }
    default:
      throw new Error(`未知子命令: corpus ${sub}（可选: search / recent / stats）`);
  }

  ctx.audit.endOperation('success', {
    sub,
    count: Array.isArray(result) ? result.length : undefined,
  }, null);
  return result;
}

module.exports = cmdCorpus;
