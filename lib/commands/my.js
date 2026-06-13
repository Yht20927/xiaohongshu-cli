const { getFlag } = require('./helpers');
const tokenCache = require('../token-cache');

// 解析按真实响应样本（my-response.txt）：
// data.notes[i] 字段平铺：note_id / display_title / user / interact_info / cover / xsec_token / type
function parseMyNote(n) {
  const interact = n.interact_info || {};
  return {
    note_id: n.note_id || n.id || '',
    title: (n.display_title || n.title || '').substring(0, 80),
    type: n.type || '',
    author: (n.user || {}).nickname || (n.user || {}).nick_name || '',
    cover: (n.cover || {}).url_default || (n.cover || {}).url_pre || '',
    stats: {
      likes: Number(interact.liked_count || 0),
    },
    xsec_token: n.xsec_token || '',
  };
}

async function cmdMy(ctx, args) {
  const count = getFlag(args, '--count', 30);
  const debug = args.includes('--debug');
  ctx.audit.startOperation('my', { count });

  const expr = 'window.__bridge.myNotes(\'\', ' + count + ')';
  const data = await ctx.loggedCall('myNotes', { count }, expr);
  const notes = (data && data.notes) || [];

  // 调试：先吐结构再死
  if (debug) {
    console.error('=== DEBUG my ===');
    console.error('top-level keys:', Object.keys(data || {}));
    console.error('notes.length:', notes.length);
    if (notes[0]) {
      console.error('notes[0] keys:', Object.keys(notes[0]).sort());
      console.error('notes[0] sample:', JSON.stringify(notes[0], null, 2).slice(0, 1500));
    }
    console.error('=== END DEBUG ===');
  }

  tokenCache.ingest(notes, 'pc_user');
  const items = notes.map(parseMyNote);
  ctx.audit.endOperation('success', { count: items.length }, { result: items });
  return items;
}

module.exports = cmdMy;
