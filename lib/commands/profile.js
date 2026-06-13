// lib/commands/profile.js — 用户交互历史

/**
 * 查看用户交互历史
 * @param {object} ctx - { audit }
 * @param {string[]} args - [uid]
 */
async function cmdProfile(ctx, args) {
  const uid = args[0];
  if (!uid) throw new Error('用法: node cli.js profile <uid>');

  const a = ctx.audit.load();
  const interactions = [];
  for (const s of (a.sessions || [])) {
    for (const op of (s.operations || [])) {
      if (op.command === 'post' && op.args?.reply_to) {
        interactions.push({ time: op.started, type: 'replied', op_index: op.index });
      }
    }
  }

  const result = {
    uid,
    first_seen: interactions[0]?.time || 'unknown',
    total_interactions: interactions.length,
    interactions,
  };
  return result;
}

module.exports = cmdProfile;
