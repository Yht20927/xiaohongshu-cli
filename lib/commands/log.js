// lib/commands/log.js — 操作日志查看

const { getFlag } = require('./helpers');

/**
 * 查看操作日志
 * @param {object} ctx - { audit }
 * @param {string[]} args - [--tail N, --note <id>, --failed]
 */
async function cmdLog(ctx, args) {
  const tail = getFlag(args, '--tail', 10);
  const noteId = getFlag(args, '--note', null);
  const failedOnly = args.includes('--failed');

  const a = ctx.audit.load();
  const ops = [];
  for (const s of (a.sessions || [])) {
    for (const op of (s.operations || [])) {
      if (noteId && op.args?.note_id !== noteId) continue;
      if (failedOnly && op.status !== 'error') continue;
      ops.push(op);
    }
  }

  const recent = ops.slice(-tail);
  for (const op of recent) {
    const icon = op.status === 'success' ? '✅' : '❌';
    const dur = op.durationMs ? `${(op.durationMs / 1000).toFixed(1)}s` : '—';
    console.log(`${icon} [${op.started?.substring(0, 19) || '?'}] ${op.command} ${JSON.stringify(op.args)} ${dur}`);
    if (op.summary && Object.keys(op.summary).length) {
      console.log(`   summary: ${JSON.stringify(op.summary)}`);
    }
    if (op.resultFile) console.log(`   result: ${op.resultFile}`);
  }
  if (recent.length === 0) console.log('No matching operations found.');
}

module.exports = cmdLog;
