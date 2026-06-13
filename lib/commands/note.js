const { escapeExpression, getFlag } = require('./helpers');
const tokenCache = require('../token-cache');

function normalize(noteRaw, noteId) {
  const note = (noteRaw && noteRaw.note_card) || noteRaw || {};
  const interact = note.interact_info || {};
  return {
    note_id: note.note_id || note.id || noteId,
    title: note.display_title || note.title || '',
    desc: note.desc || '',
    time: note.time || note.create_time || 0,
    author: (note.user || {}).nickname || '',
    type: note.type || '',
    stats: {
      likes: interact.liked_count || 0,
      comments: interact.comment_count || 0,
      collects: interact.collected_count || 0,
      shares: interact.share_count || 0,
    },
  };
}

async function cmdNote(ctx, args) {
  const noteId = args[0];
  if (!noteId) throw new Error('usage: node cli.js note <note_id> [--token <xsec_token>] [--source <pc_search|pc_user|pc_feed>]');

  // 1) token 优先级：--token > 缓存
  let tokenArg = getFlag(args, '--token', null);
  let sourceArg = getFlag(args, '--source', null);
  if (!tokenArg) {
    const cached = tokenCache.get(noteId);
    if (cached) { tokenArg = cached.xsec_token; sourceArg = sourceArg || cached.xsec_source; }
  }
  sourceArg = sourceArg || 'pc_search';

  ctx.audit.startOperation('note', { note_id: noteId, has_token: !!tokenArg, source: sourceArg });

  const expr = 'window.__bridge.getNote(' + JSON.stringify(noteId) + ', ' + JSON.stringify(tokenArg || '') + ', ' + JSON.stringify(sourceArg) + ')';

  let data;
  let usedFallback = false;
  try {
    data = await ctx.loggedCall('getNote', { note_id: noteId, source: sourceArg, has_token: !!tokenArg }, expr);
  } catch (e) {
    // 461 / -10000 / 风控 → page fallback
    const recoverable = e.code === 461 || e.code === -10000 || e.code === 300012 || /risk|spam|frequen/i.test(e.message || '');
    if (!recoverable) throw e;
    console.error(`[note] api 失败 (${e.message})，尝试页面回退...`);
    const fbExpr = 'window.__bridge.getNoteFromPage(' + JSON.stringify(noteId) + ', ' + JSON.stringify(tokenArg || '') + ')';
    data = await ctx.loggedCall('getNoteFromPage', { note_id: noteId }, fbExpr);
    usedFallback = true;
  }

  const item = (data && data.items && data.items[0]) || data || {};
  const result = normalize(item, noteId);
  if (usedFallback) result._source = 'page';

  ctx.audit.endOperation('success', { used_fallback: usedFallback }, { result });
  return result;
}

module.exports = cmdNote;
