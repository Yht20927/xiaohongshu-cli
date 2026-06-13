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
  const dashboard = new Dashboard(ctx.audit);
  const html = dashboard.render({ noteId, days });

  const ts = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
  const fp = path.join(process.cwd(), 'logs', `dashboard-${ts}.html`);
  fs.writeFileSync(fp, html);
  console.error(`仪表盘已保存: ${fp}`);

  // 跨平台打开浏览器
  try {
    const { exec } = require('child_process');
    const safePath = fp.replace(/"/g, '\\"');
    if (process.platform === 'darwin') exec(`open "${safePath}"`);
    else if (process.platform === 'linux') exec(`xdg-open "${safePath}"`);
    else exec(`start "" "${safePath}"`);
  } catch (e) { /* 静默失败 */ }

  ctx.audit.endOperation('success', { file: 'logs/' + path.basename(fp) });
  return { file: 'logs/' + path.basename(fp) };
}

// ── Dashboard 渲染引擎 ──

class Dashboard {
  constructor(audit) {
    this.audit = audit;
  }

  render({ noteId, days }) {
    const a = this.audit.load();
    const stats = this._computeStats(a, noteId, days);
    const chartData = this._buildChartData(a, noteId, days);

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>小红书运营仪表盘</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f172a; color: #e2e8f0; padding: 24px; }
  h1 { font-size: 1.5rem; margin-bottom: 20px; color: #f8fafc; }
  h2 { font-size: 1.1rem; margin-bottom: 12px; color: #94a3b8; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; margin-bottom: 24px; }
  .card { background: #1e293b; border-radius: 12px; padding: 20px; }
  .card .label { font-size: 0.85rem; color: #64748b; margin-bottom: 4px; }
  .card .value { font-size: 1.8rem; font-weight: 700; }
  .chart-container { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 24px; }
  @media (max-width: 768px) { .chart-container { grid-template-columns: 1fr; } }
  .chart-box { background: #1e293b; border-radius: 12px; padding: 20px; }
  canvas { width: 100% !important; height: 250px !important; }
  .section { margin-bottom: 24px; }
</style>
</head>
<body>
<h1>小红书运营仪表盘</h1>
<div class="grid">
  <div class="card"><div class="label">总操作次数</div><div class="value">${stats.totalOps}</div></div>
  <div class="card"><div class="label">成功次数</div><div class="value" style="color:#4ade80">${stats.successOps}</div></div>
  <div class="card"><div class="label">失败次数</div><div class="value" style="color:#f87171">${stats.failedOps}</div></div>
  <div class="card"><div class="label">平均耗时</div><div class="value">${stats.avgMs}ms</div></div>
</div>
<div class="chart-container">
  <div class="chart-box"><h2>情感分布</h2><canvas id="sentimentChart"></canvas></div>
  <div class="chart-box"><h2>评论趋势</h2><canvas id="trendChart"></canvas></div>
</div>
<script>
const sentimentData = ${JSON.stringify(chartData.sentiment)};
const trendData = ${JSON.stringify(chartData.trend)};

// 情感饼图（纯 canvas 手绘）
(function() {
  const canvas = document.getElementById('sentimentChart');
  const ctx = canvas.getContext('2d');
  canvas.width = canvas.offsetWidth * 2;
  canvas.height = 500;
  ctx.scale(2, 2);
  const w = canvas.offsetWidth, cx = w / 2 - 40, cy = 125, r = 100;
  const total = sentimentData.reduce((s, d) => s + d.value, 0);
  if (total === 0) { ctx.fillStyle = '#64748b'; ctx.font = '14px sans-serif'; ctx.fillText('暂无数据', cx - 30, cy); return; }
  let angle = -Math.PI / 2;
  const colors = { positive: '#4ade80', neutral: '#facc15', negative: '#f87171', question: '#60a5fa', other: '#a78bfa', comment: '#38bdf8' };
  for (const d of sentimentData) {
    const slice = (d.value / total) * Math.PI * 2;
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.arc(cx, cy, r, angle, angle + slice); ctx.closePath();
    ctx.fillStyle = colors[d.label] || '#94a3b8'; ctx.fill();
    angle += slice;
  }
  // 图例
  let ly = 20;
  for (const d of sentimentData) {
    ctx.fillStyle = colors[d.label] || '#94a3b8';
    ctx.fillRect(w - 120, ly, 12, 12);
    ctx.fillStyle = '#e2e8f0'; ctx.font = '11px sans-serif';
    ctx.fillText(\`\${d.label} (\${d.value})\`, w - 102, ly + 10);
    ly += 18;
  }
})();

// 趋势折线图
(function() {
  const canvas = document.getElementById('trendChart');
  const ctx = canvas.getContext('2d');
  canvas.width = canvas.offsetWidth * 2;
  canvas.height = 500;
  ctx.scale(2, 2);
  const w = canvas.offsetWidth, pad = 40;
  if (trendData.length === 0) { ctx.fillStyle = '#64748b'; ctx.font = '14px sans-serif'; ctx.fillText('暂无数据', w/2 - 30, 125); return; }
  const max = Math.max(...trendData.map(d => d.count), 1);
  const stepX = (w - pad * 2) / Math.max(trendData.length - 1, 1);
  // 网格线
  ctx.strokeStyle = '#334155'; ctx.lineWidth = 0.5;
  for (let i = 0; i <= 4; i++) {
    const y = pad + (i / 4) * (w - pad * 2);
    ctx.beginPath(); ctx.moveTo(pad, y); ctx.lineTo(w - pad, y); ctx.stroke();
  }
  // 折线
  ctx.strokeStyle = '#60a5fa'; ctx.lineWidth = 2;
  ctx.beginPath();
  trendData.forEach((d, i) => {
    const x = pad + i * stepX, y = pad + (1 - d.count / max) * (w - pad * 2);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.stroke();
  // 点 + 标签
  trendData.forEach((d, i) => {
    const x = pad + i * stepX, y = pad + (1 - d.count / max) * (w - pad * 2);
    ctx.fillStyle = '#60a5fa'; ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#94a3b8'; ctx.font = '9px sans-serif';
    ctx.save(); ctx.translate(x, y + 14); ctx.rotate(Math.PI / 4); ctx.fillText(d.label, 0, 0); ctx.restore();
  });
})();
</script>
</body>
</html>`;
  }

  _computeStats(a, noteId, days) {
    const cutoff = Date.now() - days * 86400000;
    let totalOps = 0, successOps = 0, failedOps = 0, totalMs = 0;
    for (const s of (a.sessions || [])) {
      for (const op of (s.operations || [])) {
        if (noteId && op.args?.note_id !== noteId) continue;
        const opTime = op.started ? new Date(op.started).getTime() : 0;
        if (opTime > 0 && opTime < cutoff) continue;
        totalOps++;
        if (op.status === 'success') successOps++;
        else if (op.status === 'error') failedOps++;
        if (op.durationMs) totalMs += op.durationMs;
      }
    }
    return {
      totalOps,
      successOps,
      failedOps,
      avgMs: totalOps > 0 ? Math.round(totalMs / totalOps) : 0,
    };
  }

  _buildChartData(a, noteId, days) {
    const cutoff = Date.now() - days * 86400000;
    const sentimentMap = {};
    const dayMap = {};

    // 情感统计
    for (const s of (a.sessions || [])) {
      for (const op of (s.operations || [])) {
        if (op.command === 'analyze' && op.result?.result) {
          for (const item of op.result.result) {
            const sent = item.sentiment || 'comment';
            sentimentMap[sent] = (sentimentMap[sent] || 0) + 1;
          }
        }
      }
    }

    // 按天统计操作数
    for (const s of (a.sessions || [])) {
      for (const op of (s.operations || [])) {
        if (noteId && op.args?.note_id !== noteId) continue;
        const opTime = op.started ? new Date(op.started).getTime() : 0;
        if (opTime > 0 && opTime < cutoff) continue;
        const day = op.started ? op.started.substring(0, 10) : 'unknown';
        dayMap[day] = (dayMap[day] || 0) + 1;
      }
    }

    const sentiment = Object.entries(sentimentMap).map(([label, value]) => ({ label, value }));
    const trend = Object.entries(dayMap)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([label, count]) => ({ label, count }));

    return { sentiment, trend };
  }
}

module.exports = cmdDashboard;
