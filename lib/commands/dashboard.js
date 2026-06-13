// lib/commands/dashboard.js — 运营仪表盘

const fs = require('fs');
const path = require('path');
const { getFlag } = require('./helpers');

/**
 * 生成运营仪表盘
 * @param {object} ctx - { audit }
 * @param {string[]} args - [--note <id>, --days N]
 */
async function cmdDashboard(ctx, args) {
  const noteId = getFlag(args, '--note', null);
  const days = getFlag(args, '--days', 14);

  ctx.audit.startOperation('dashboard', { note_id: noteId, days });
  // Simple placeholder - full dashboard generation can be added later
  const html = `<html><body><h1>Dashboard</h1><p>note: ${noteId} | days: ${days}</p></body></html>`;

  const ts = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
  const fp = path.join(process.cwd(), 'logs', `dashboard-${ts}.html`);
  fs.writeFileSync(fp, html);
  console.error(`仪表盘已保存: ${fp}`);

  // 跨平台打开浏览器
  try {
    const { exec } = require('child_process');
    const platform = process.platform;
    if (platform === 'darwin') exec(`open "${fp}"`);
    else if (platform === 'linux') exec(`xdg-open "${fp}"`);
    else exec(`start "" "${fp}"`); // Windows
  } catch (e) { /* 静默失败 */ }

  ctx.audit.endOperation('success', { file: 'logs/' + path.basename(fp) });
  return { file: 'logs/' + path.basename(fp) };
}

module.exports = cmdDashboard;
