const tokenCache = require('../token-cache');

// 解析按真实响应样本（search-response.txt）：
// data.items[i] = { id, xsec_token, model_type:"note", note_card:{ display_title, user, interact_info, type, image_list, corner_tag_info, cover } }
// search 接口的 interact_info 含 liked_count/collected_count/comment_count/shared_count（字符串）；没有 desc
function parseSearchItem(d) {
  const card = d.note_card || {};
  const interact = card.interact_info || {};
  const tag = (card.corner_tag_info || []).find(t => t.type === 'publish_time') || {};
  return {
    note_id: d.id || d.note_id || '',
    title: (card.display_title || '').substring(0, 80),
    type: card.type || d.model_type || '',
    author: (card.user || {}).nickname || (card.user || {}).nick_name || '',
    publish_time: tag.text || '',
    stats: {
      likes: Number(interact.liked_count || 0),
      collects: Number(interact.collected_count || 0),
      comments: Number(interact.comment_count || 0),
      shares: Number(interact.shared_count || 0),
    },
    xsec_token: d.xsec_token || '',
  };
}

async function cmdSearch(ctx, args) {
  const nonFlagArgs = args.filter(a => !a.startsWith('--'));
  const kw = nonFlagArgs[0];
  if (!kw) throw new Error('usage: node cli.js search <keyword> [--page N] [--count N]');
  const { getFlag } = require('./helpers');
  const page = getFlag(args, '--page', 1);
  const count = getFlag(args, '--count', 20);
  const debug = args.includes('--debug');

  const expr = `window.__bridge.search(${JSON.stringify(kw)}, ${page}, ${count})`;
  ctx.audit.startOperation('search', { keyword: kw, page, count });

  const data = await ctx.loggedCall('search', { keyword: kw, page, count }, expr);
  const rawItems = (data && data.items) || [];

  if (debug) {
    console.error('=== DEBUG search ===');
    console.error('top-level keys:', Object.keys(data || {}));
    console.error('items.length:', rawItems.length);
    if (rawItems[0]) {
      console.error('items[0] keys:', Object.keys(rawItems[0]).sort());
      console.error('items[0] sample:', JSON.stringify(rawItems[0], null, 2).slice(0, 1500));
    }
    console.error('=== END DEBUG ===');
  }

  tokenCache.ingest(rawItems, 'pc_search');

  // 只保留真正的 note 类型（结果里可能混 hot_query / live 等）
  const items = rawItems.filter(d => (d.model_type === 'note' || d.note_card)).map(parseSearchItem);
  ctx.audit.endOperation('success', { count: items.length }, { result: items });
  return items;
}

module.exports = cmdSearch;
