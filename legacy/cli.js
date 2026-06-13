#!/usr/bin/env node
// cli.js — 小红书评论 CLI (daemon 持久连接)
const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { buildXhsBridgeSource } = require('./lib/xhs-bridge');

const DAEMON_PORT = 19423;
const DAEMON = process.argv[2] === 'daemon';

// Daemon 健壮性模块
const { acquireLock, releaseLock, ReconnectManager, PageMonitor, HeartbeatMonitor } = require('./lib/daemon');
const { CDPClient } = require('./lib/cdp');

// ===== 审计日志 =====
const LOG_DIR = path.join(__dirname, 'logs');
const AUDIT_FILE = path.join(LOG_DIR, 'audit.json');
const RESULTS_DIR = path.join(LOG_DIR, 'results');
let audit = null;
let currentOp = null;
let noLog = false;

function ensureLogDirs() {
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
  if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR, { recursive: true });
}
function loadAudit() {
  if (!fs.existsSync(AUDIT_FILE)) return { version: '1.0', updated: new Date().toISOString(), sessions: [] };
  try { return JSON.parse(fs.readFileSync(AUDIT_FILE, 'utf8')); }
  catch(e) { return { version: '1.0', updated: new Date().toISOString(), sessions: [] }; }
}
function saveAudit() {
  if (noLog) return;
  audit.updated = new Date().toISOString();
  const tmp = AUDIT_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(audit, null, 2));
  fs.renameSync(tmp, AUDIT_FILE);
}
function newSession() {
  const last = audit.sessions[audit.sessions.length - 1];
  if (last && !last.ended) return last;
  const s = { sessionId: new Date().toISOString().replace(/[:.]/g,'-').substring(0,19)+'-'+Math.random().toString(36).substring(2,6), started: new Date().toISOString(), ended: null, operations: [] };
  audit.sessions.push(s);
  if (audit.sessions.length > 50) audit.sessions = audit.sessions.slice(-50);
  return s;
}
function startOperation(cmd, args) {
  if (noLog) return;
  ensureLogDirs(); audit = loadAudit();
  const s = newSession();
  currentOp = { index: s.operations.length + 1, command: cmd, args, started: new Date().toISOString(), ended: null, durationMs: null, status: 'running', summary: {}, apiCalls: [] };
  s.operations.push(currentOp);
  saveAudit();
}
function logApiCall(endpoint, params, durationMs, status, summary) {
  if (noLog || !currentOp) return;
  currentOp.apiCalls.push({ seq: currentOp.apiCalls.length + 1, endpoint, params, durationMs, status, summary: summary || {} });
}
function endOperation(status, summary, resultData, error) {
  if (noLog || !currentOp) return;
  currentOp.ended = new Date().toISOString();
  currentOp.durationMs = Date.now() - new Date(currentOp.started).getTime();
  currentOp.status = status;
  if (summary) currentOp.summary = summary;
  if (error) currentOp.error = error;
  const largeResults = ['get','search','my','replies'];
  if (resultData && largeResults.includes(currentOp.command) && status === 'success') {
    const ts = new Date().toISOString().replace(/[:.]/g,'-').substring(0,19);
    let label = currentOp.command;
    if (currentOp.args.note_id) label += '-' + currentOp.args.note_id;
    else if (currentOp.args.keyword) label += '-' + sanitize(currentOp.args.keyword);
    else if (currentOp.args.cid) label += '-' + currentOp.args.cid;
    const fp = path.join(RESULTS_DIR, label + '-' + ts + '.json');
    fs.writeFileSync(fp, JSON.stringify({ command: currentOp.command, args: currentOp.args, started: currentOp.started, ...resultData }, null, 2));
    currentOp.resultFile = 'logs/results/' + path.basename(fp);
  } else if (resultData && status === 'success') {
    currentOp.result = resultData;
  }
  saveAudit(); currentOp = null;
}
function sanitize(s) { return (s||'').replace(/[<>:"/\\|?*'\s]/g,'_').substring(0,20); }
function summarizeTransportMeta(meta) {
  if (!meta || typeof meta !== 'object') return null;
  const summary = {};
  if (meta.transport) summary.transport = meta.transport;
  if (meta.source) summary.source = meta.source;
  if (meta.method) summary.method = meta.method;
  if (meta.url) summary.url = meta.url;
  if (meta.status !== undefined) summary.status = meta.status;
  if (meta.completeSignature !== undefined) summary.complete_signature = !!meta.completeSignature;
  if (Array.isArray(meta.missingHeaders) && meta.missingHeaders.length) summary.missing_headers = meta.missingHeaders;
  if (meta.error) summary.error = meta.error;
  return Object.keys(summary).length ? summary : null;
}
function findLastFetchTime(noteId) {
  const a = loadAudit();
  let latest = null;
  for (const s of (a.sessions || [])) {
    for (const op of (s.operations || [])) {
      if (op.command === 'get' && op.args?.note_id === noteId && op.status === 'success' && op.ended) {
        const t = new Date(op.ended).getTime() / 1000;
        if (latest === null || t > latest) latest = t;
      }
    }
  }
  return latest;
}
async function loggedSend(endpoint, params, expression, awaitPromise) {
  const t0 = Date.now();
  try {
    const shouldAwait = awaitPromise !== false || (typeof expression === 'string' && expression.includes('window.__xhs'));
    const res = await sendToDaemon({ expression, awaitPromise: shouldAwait });
    const ms = Date.now() - t0;
    const sum = {};
    if (res.ok && res.value) {
      const v = res.value;
      if (v.comments) sum.count = v.comments.length;
      if (v.has_more !== undefined) sum.has_more = v.has_more;
      if (v.items) sum.count = v.items.length;
      if (v.data) {
        if (v.data.comments) sum.count = v.data.comments.length;
        else if (v.data.notes) sum.count = v.data.notes.length;
        else if (Array.isArray(v.data)) sum.count = v.data.length;
      }
      const transportSummary = summarizeTransportMeta(v.__xhs_meta || v.__transport || v.transport_meta);
      if (transportSummary) {
        sum.transport = transportSummary.transport;
        if (transportSummary.source) sum.transport_source = transportSummary.source;
        if (transportSummary.status !== undefined) sum.http_status = transportSummary.status;
        if (transportSummary.complete_signature !== undefined) sum.complete_signature = transportSummary.complete_signature;
        if (transportSummary.missing_headers) sum.missing_headers = transportSummary.missing_headers;
        if (transportSummary.error) sum.transport_error = transportSummary.error;
      }
      if (v.comment) { sum.cid = v.comment.cid || v.comment.id; sum.status_code = 0; }
      if (v.code !== undefined) sum.code = v.code;
    }
    logApiCall(endpoint, params, ms, res.ok ? 'success' : 'error', sum);
    return res;
  } catch(e) {
    logApiCall(endpoint, params, Date.now() - t0, 'error', { error: e.message });
    throw e;
  }
}

// ===== DevToolsActivePort 读取 =====
function getBrowserWsUrl() {
  const envPort = process.env.CDP_PORT;
  if (envPort) return `ws://127.0.0.1:${envPort}/devtools/browser`;
  const candidates = [
    path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
              'Google', 'Chrome', 'User Data', 'DevToolsActivePort'),
  ];
  for (const portFile of candidates) {
    if (fs.existsSync(portFile)) {
      const lines = fs.readFileSync(portFile, 'utf8').trim().split('\n');
      if (lines.length >= 2 && lines[0] && lines[1])
        return `ws://127.0.0.1:${lines[0]}${lines[1]}`;
    }
  }
  throw new Error('找不到 Chrome 调试端口。请启用 chrome://inspect/#remote-debugging');
}

// ===== 小红书桥接脚本 =====
// 要点：在文档加载前注入 transport 适配器，优先捕获页面自身的 axios / fetch / XHR 请求链。
const BRIDGE = buildXhsBridgeSource();

// ===== CDP 工具 =====
let cdpMsgId = 0;
function cdp(ws, method, params, sessionId) {
  return new Promise((resolve, reject) => {
    const mid = ++cdpMsgId;
    const msg = { id: mid, method, params: params || {} };
    if (sessionId) msg.sessionId = sessionId;
    const timer = setTimeout(() => reject(new Error(`${method} timeout`)), 30000);
    function onMsg(data) {
      try {
        const obj = JSON.parse(data.toString());
        if (obj.id === mid) {
          ws.removeListener('message', onMsg);
          clearTimeout(timer);
          if (obj.error) reject(new Error(obj.error.message));
          else resolve(obj.result);
        }
      } catch(e) {}
    }
    ws.on('message', onMsg);
    ws.send(JSON.stringify(msg));
  });
}

async function findAndConnect() {
  const browserWsUrl = getBrowserWsUrl();
  const ws = new WebSocket(browserWsUrl);
  await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
  const result = await cdp(ws, 'Target.getTargets');
  const targets = result.targetInfos || [];
  // 优先 www.xiaohongshu.com（APP 页面，有 RAP），排除 edith API 页面
  let page = targets.find(t => t.url && t.url.startsWith('https://www.xiaohongshu.com') && t.type === 'page');
  if (!page) page = targets.find(t => t.url && t.url.includes('xiaohongshu.com') && t.type === 'page' && !t.url.startsWith('https://edith.xiaohongshu.com/api'));
  if (!page) page = targets.find(t => t.type === 'page' && t.url && !t.url.startsWith('chrome://'));
  if (!page) { ws.close(); throw new Error('No Xiaohongshu page found.'); }
  const attachResult = await cdp(ws, 'Target.attachToTarget', { targetId: page.targetId, flatten: true });
  const sessionId = attachResult.sessionId;
  return { ws, sessionId, page };
}

// ===== Daemon =====
async function runDaemon() {
  // PID JSON 锁（含僵尸检测）
  acquireLock();

  // 用指数退避重连包装连接逻辑
  const reconnect = new ReconnectManager();
  const pageState = { value: 'running', lastActivity: Date.now() };
  let cdpClient = null;
  let sessionId = null;
  let heartbeat = null;

  async function doConnect() {
    console.error('[daemon] Connecting to Chrome...');
    const { ws, sessionId: sid, page } = await findAndConnect();
    sessionId = sid;
    cdpClient = new CDPClient(ws);
    pageState.value = 'running';
    console.error(`[daemon] Connected: ${page.title || page.url?.substring(0, 50)}`);

    // Bridge 注入 — 先注册 addScriptToEvaluateOnNewDocument（下次导航时在 RAP 之前运行）
    await cdpClient.send('Page.enable', {}, sessionId);
    await cdpClient.send('Page.addScriptToEvaluateOnNewDocument', {
      source: BRIDGE,
    }, sessionId);
    await cdpClient.send('Runtime.enable', {}, sessionId);

    // Reload 页面：触发 addScriptToEvaluateOnNewDocument → bridge 在 RAP 之前安装
    // → RAP 初始化 → bridge hooks 包裹在 RAP 之上 → 能捕获 x-s-common/x-rap-param
    console.error('[daemon] Reloading page to activate bridge before RAP...');
    await cdpClient.send('Page.reload', {}, sessionId);
    // 等待页面加载完成（DOMContentLoaded）
    await new Promise((resolve) => {
      const onLoad = (params) => {
        console.error('[daemon] Page reloaded');
        cdpClient.ws.removeListener('message', listener);
        resolve();
      };
      const listener = (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.method === 'Page.loadEventFired') {
            setTimeout(resolve, 1000); // 再等 1s 确保 JS 执行完毕
          }
        } catch(e) {}
      };
      cdpClient.ws.on('message', listener);
      setTimeout(resolve, 15000); // 15s 超时
    });
    console.error('[daemon] Bridge ready (reloaded)');

    // 页面感知 — 离开暂停，回来自动恢复
    const monitor = new PageMonitor(pageState);
    try {
      await cdpClient.send('Fetch.enable', {
        patterns: [
          {
            urlPattern: '*edith.xiaohongshu.com/*',
            requestStage: 'Request',
          },
        ],
      }, sessionId);
      cdpClient.on('Fetch.requestPaused', async (params) => {
        const req = params.request || {};
        const url = req.url || '';
        if (url.includes('edith.xiaohongshu.com')) {
          const headers = req.headers || {};
          const required = ['x-s', 'x-s-common', 'x-t', 'x-b3-traceid', 'x-xray-traceid'];
          const missing = required.filter((name) => !headers[name] && !headers[name.toLowerCase()]);
          if (missing.length) {
            console.error(`[daemon] Fetch paused ${req.method || 'GET'} ${url} missing: ${missing.join(', ')}`);
            // 尝试通过页面上下文生成签名头
            try {
              const signResult = await cdpClient.send('Runtime.evaluate', {
                expression: `(function() {
                  try {
                    var xhs = window.__xhs;
                    if (!xhs || typeof xhs._signRequest !== 'function') return null;
                    var method = ${JSON.stringify(req.method || 'GET')};
                    var reqUrl = ${JSON.stringify(url)};
                    var body = ${req.hasPostData ? JSON.stringify(req.postData || '') : 'null'};
                    return JSON.stringify(xhs._signRequest(method, reqUrl, body));
                  } catch(e) { return null; }
                })()`,
                returnByValue: true,
                awaitPromise: false,
              }, sessionId);
              if (signResult && signResult.result && signResult.result.value) {
                try {
                  const signedHeaders = JSON.parse(signResult.result.value);
                  if (signedHeaders) {
                    const newHeaders = [];
                    for (const [key, value] of Object.entries(headers)) {
                      newHeaders.push({ name: key, value: String(value) });
                    }
                    for (const [key, value] of Object.entries(signedHeaders)) {
                      if (!headers[key] && !headers[key.toLowerCase()]) {
                        newHeaders.push({ name: key, value: String(value) });
                      }
                    }
                    try {
                      await cdpClient.send('Fetch.continueRequest', {
                        requestId: params.requestId,
                        headers: newHeaders,
                      }, sessionId);
                      return;
                    } catch (e2) {
                      console.error(`[daemon] Fetch continue with headers failed: ${e2.message}`);
                    }
                  }
                } catch (parseErr) {}
              }
            } catch (signErr) {
              console.error(`[daemon] Sign header injection failed: ${signErr.message}`);
            }
          }
        }
        try {
          await cdpClient.send('Fetch.continueRequest', { requestId: params.requestId }, sessionId);
        } catch (e) {
          console.error(`[daemon] Fetch continue failed: ${e.message}`);
        }
      });
      console.error('[daemon] Fetch fallback enabled');
    } catch (e) {
      console.error(`[daemon] Fetch fallback unavailable: ${e.message}`);
    }
    cdpClient.on('Page.frameNavigated', async (params) => {
      if (!params.frame) return;
      const url = params.frame.url || '';
      monitor.handleNavigation(cdpClient, url);
      // 回到 XHS 后验证 bridge，失败则重连
      if (pageState.value === 'recovering' || pageState.value === 'running') {
        const ok = await monitor.verifyBridge(cdpClient, sessionId);
        if (!ok) {
          console.error('[daemon] Bridge lost after navigation, reconnecting...');
          if (heartbeat) heartbeat.stop();
          cdpClient.close();
          reconnect.attempt(doConnect).catch(e => {
            console.error(`[daemon] Fatal: ${e.message}`);
            cleanup();
          });
        } else {
          pageState.value = 'running';
          console.error('[daemon] Bridge recovered, resuming operations');
        }
      }
    });

    // 心跳
    heartbeat = new HeartbeatMonitor({
      interval: 60000, failureThreshold: 3,
    });
    heartbeat.onConnectionLost = () => {
      console.error('[daemon] Heartbeat lost, reconnecting...');
      heartbeat.stop();
      cdpClient.close();
      reconnect.attempt(doConnect).catch(e => {
        console.error(`[daemon] Fatal: ${e.message}`);
        cleanup();
      });
    };
    heartbeat.start(cdpClient, sessionId);

    return { cdpClient, sessionId, heartbeat };
  }

  // 首次连接（带重试）
  try {
    await reconnect.attempt(doConnect);
  } catch(e) {
    console.error(`[daemon] Initial connection failed: ${e.message}`);
    releaseLock();
    process.exit(1);
  }

  let lastActivity = Date.now();
  const INACTIVE_TIMEOUT = 20 * 60 * 1000;

  const server = http.createServer(async (req, res) => {
    lastActivity = Date.now();

    // 页面离开时拒绝操作
    if (pageState.value !== 'running' && req.url !== '/ping' && req.url !== '/stop') {
      res.writeHead(503);
      res.end(JSON.stringify({ ok: false, error: 'Daemon paused — page navigated away from Xiaohongshu' }));
      return;
    }

    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'GET' && req.url === '/ping') {
      if (pageState.value !== 'running') {
        res.end(JSON.stringify({ ok: true, status: pageState.value }));
      } else {
        res.end(JSON.stringify({ ok: true }));
      }
      return;
    }
    if (req.method === 'POST' && req.url === '/eval') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', async () => {
        try {
          const { expression, awaitPromise } = JSON.parse(body);
          const result = await cdpClient.send('Runtime.evaluate', {
            expression, returnByValue: true, awaitPromise: awaitPromise !== false,
          }, sessionId);
          res.end(JSON.stringify({ ok: true, value: result.result?.value }));
        } catch(e) { res.end(JSON.stringify({ ok: false, error: e.message })); }
      });
      return;
    }
    if (req.method === 'POST' && req.url === '/stop') {
      res.end(JSON.stringify({ ok: true }));
      cleanup(); return;
    }
    res.statusCode = 404; res.end(JSON.stringify({ error: 'not found' }));
  });

  server.listen(DAEMON_PORT, '127.0.0.1', () => {
    console.error(`[daemon] Listening on http://127.0.0.1:${DAEMON_PORT}`);
  });

  const timer = setInterval(() => {
    if (Date.now() - lastActivity > INACTIVE_TIMEOUT) {
      console.error('[daemon] Inactive timeout, exiting.');
      cleanup();
    }
  }, 60000);

  function cleanup() {
    clearInterval(timer);
    try { cdpClient?.close(); } catch(e) {}
    try { server.close(); } catch(e) {}
    releaseLock();
    process.exit(0);
  }
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
}

// ===== CLI → Daemon 通信 =====
function sendToDaemon(data) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const req = http.request({
      hostname: '127.0.0.1', port: DAEMON_PORT, path: '/eval', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch(e) { reject(new Error('Invalid daemon response')); }
      });
    });
    req.on('error', () => reject(new Error('Daemon not running. Start with: node cli.js daemon')));
    req.write(body); req.end();
  });
}

// ===== Dashboard HTML 生成 =====
function generateDashboardHTML(noteId, days) {
  const title = noteId ? `笔记 ${noteId} 评论仪表盘` : '小红书评论运营仪表盘';

  let totalComments = 0, repliedCount = 0, todayNew = 0;
  const sentimentCounts = { positive: 0, neutral: 0, negative: 0 };
  const dailyComments = {};
  const now = Date.now();
  const cutoffMs = now - days * 24 * 60 * 60 * 1000;

  try {
    const a = loadAudit();
    const todayStart = new Date(); todayStart.setHours(0,0,0,0); const todayTs = todayStart.getTime() / 1000;

    for (const s of (a.sessions || [])) {
      for (const op of (s.operations || [])) {
        if (op.status !== 'success') continue;
        const opTime = op.started ? new Date(op.started).getTime() : 0;
        if (opTime < cutoffMs) continue;
        if (noteId && op.args?.note_id !== noteId) continue;

        if (op.command === 'get' && op.summary?.comments) {
          totalComments += op.summary.comments;
          const dayKey = op.started ? op.started.substring(0, 10) : 'unknown';
          dailyComments[dayKey] = (dailyComments[dayKey] || 0) + op.summary.comments;
          if (op.args?.since && op.args.since >= todayTs) {
            todayNew += op.summary.comments;
          }
        }
        if (op.command === 'post' && op.result?.status === 'published') {
          repliedCount++;
        }
        if (op.command === 'analyze' && op.resultFile) {
          try {
            const fp = path.join(__dirname, op.resultFile);
            if (fs.existsSync(fp)) {
              const analysisData = JSON.parse(fs.readFileSync(fp, 'utf8'));
              const items = Array.isArray(analysisData) ? analysisData : [];
              for (const item of items) {
                if (item.sentiment === 'positive') sentimentCounts.positive++;
                else if (item.sentiment === 'negative') sentimentCounts.negative++;
                else sentimentCounts.neutral++;
              }
            }
          } catch {}
        }
      }
    }

    if (totalComments === 0) {
      try {
        const resultsDir = path.join(__dirname, 'logs', 'results');
        if (fs.existsSync(resultsDir)) {
          const files = fs.readdirSync(resultsDir).filter(f => f.startsWith('get-') && f.endsWith('.json'));
          for (const f of files) {
            if (noteId && !f.includes(noteId)) continue;
            try {
              const data = JSON.parse(fs.readFileSync(path.join(resultsDir, f), 'utf8'));
              const cmts = data.comments || [];
              totalComments += cmts.length;
            } catch {}
          }
        }
      } catch {}
    }
  } catch {}

  const pendingReplies = Math.max(0, totalComments - repliedCount);

  const dayLabels = [];
  const dayValues = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now - i * 24 * 60 * 60 * 1000);
    const key = d.toISOString().substring(0, 10);
    dayLabels.push(key.substring(5));
    dayValues.push(dailyComments[key] || 0);
  }

  const hasSentiment = sentimentCounts.positive + sentimentCounts.neutral + sentimentCounts.negative > 0;
  const sPos = hasSentiment ? sentimentCounts.positive : 0;
  const sNeu = hasSentiment ? sentimentCounts.neutral : 0;
  const sNeg = hasSentiment ? sentimentCounts.negative : 0;

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"><\/script>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:1200px;margin:0 auto;padding:20px;background:#f5f5f5}
h1{color:#1a1a1a}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px;margin:20px 0}
.card{background:#fff;border-radius:12px;padding:20px;box-shadow:0 2px 8px rgba(0,0,0,.08)}
.card .label{color:#666;font-size:13px}.card .value{font-size:28px;font-weight:700;color:#1a1a1a}
.charts{display:grid;grid-template-columns:repeat(auto-fit,minmax(400px,1fr));gap:16px;margin:20px 0}
.chart-box{background:#fff;border-radius:12px;padding:20px;box-shadow:0 2px 8px rgba(0,0,0,.08)}
.hint{text-align:center;padding:20px;color:#999;font-size:14px}
</style></head>
<body>
<h1>${title}</h1>
<p>${new Date().toLocaleString('zh-CN')} | 最近 ${days} 天${noteId ? ' | 笔记 ' + noteId : ''}</p>
<div class="cards">
<div class="card"><div class="label">评论总数</div><div class="value">${totalComments || '—'}</div></div>
<div class="card"><div class="label">待回复</div><div class="value">${pendingReplies || '—'}</div></div>
<div class="card"><div class="label">已回复</div><div class="value">${repliedCount || '—'}</div></div>
<div class="card"><div class="label">今日新增</div><div class="value">${todayNew || '—'}</div></div>
</div>
<div class="charts">
<div class="chart-box"><canvas id="s-chart"></canvas></div>
<div class="chart-box"><canvas id="t-chart"></canvas></div>
</div>
${!hasSentiment ? '<div class="hint">💡 运行 analyze 命令后，情感分布图表将展示真实数据</div>' : ''}
<script>
new Chart(document.getElementById('s-chart'),{type:'doughnut',data:{labels:['正面','中性','负面'],datasets:[{data:[${sPos},${sNeu},${sNeg}],backgroundColor:['#4CAF50','#FFC107','#F44336']}]},options:{responsive:true,plugins:{title:{display:true,text:'情感分布'}}}});
new Chart(document.getElementById('t-chart'),{type:'line',data:{labels:${JSON.stringify(dayLabels)},datasets:[{label:'评论数',data:${JSON.stringify(dayValues)},borderColor:'#2196F3',fill:false,tension:0.3}]},options:{responsive:true,plugins:{title:{display:true,text:'评论趋势（' + days + '天）'}},scales:{y:{beginAtZero:true}}}});
<\/script></body></html>`;
}

// ===== 标准化输出函数 =====
function normalizeComment(c) {
  return {
    cid: c.id || c.comment_id || c.cid,
    text: c.content || c.text || '',
    likes: c.like_count || c.likes || 0,
    replies: c.sub_comment_count || c.replies || 0,
    time: c.create_time || c.time || 0,
    user: c.user_info ? {
      nickname: c.user_info.nickname || '',
      user_id: c.user_info.user_id || '',
      avatar: c.user_info.image || c.user_info.avatar || '',
    } : (c.user || {}),
    pinned: !!(c.pin_info || c.is_pinned),
    children: (c.sub_comments || c.children || []).map(normalizeComment),
  };
}

function normalizeNote(n) {
  const note = n.note_card || n;
  return {
    note_id: note.note_id || note.id,
    title: note.display_title || note.title || '',
    desc: (note.desc || '').substring(0, 80),
    type: note.type || 'normal',
    time: note.time || note.create_time || 0,
    author: (note.user || note.author || {}).nickname || '',
    user_id: (note.user || note.author || {}).user_id || '',
    stats: {
      likes: note.interact_info?.liked_count || note.likes || 0,
      comments: note.interact_info?.comment_count || note.comments || 0,
      collects: note.interact_info?.collected_count || note.collects || 0,
      shares: note.interact_info?.share_count || note.shares || 0,
    },
  };
}

// ===== CLI 命令 =====
async function runCli() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const rawMode = args.includes('--raw');
  noLog = args.includes('--no-log');

  try {

  if (!cmd || cmd === 'help') {
    console.log(`
Xiaohongshu Comment CLI

  node cli.js daemon                      启动 daemon
  node cli.js ping                        探活 daemon
  node cli.js my                          我的笔记
  node cli.js search <keyword>            搜索笔记
  node cli.js get <note_id>               获取评论 (--all --depth N --new --since <ts>)
  node cli.js replies <cid> <note_id>     获取回复列表
  node cli.js post <note_id> "内容"        发表评论
  node cli.js post <note_id> "回复" --reply-to <cid>
  node cli.js analyze <note_id>            LLM 分析（情感/分类/优先级）
  node cli.js suggest <note_id>            LLM 回复建议（--auto 自动发布）
  node cli.js dashboard                    仪表盘 HTML
  node cli.js profile <user_id>            用户画像
  node cli.js stop                         停止 daemon
  node cli.js log [--tail N] [--note <id>] [--failed]  查看操作日志

  通用选项： --raw（原始输出） --no-log（本次不记录日志）
`);
    return;
  }

  if (cmd === 'ping') {
    startOperation('ping', {});
    try {
      const res = await sendToDaemon({ expression: '1', awaitPromise: false });
      console.log('pong (daemon alive)');
      endOperation('success', {}, { result: 'pong' });
    } catch(e) {
      console.log('Daemon not running');
      endOperation('error', {}, null, e.message);
      process.exit(1);
    }
    return;
  }

  if (cmd === 'stop') {
    startOperation('stop', {});
    try { await sendToDaemon({ expression: '1' }); } catch(e) {}
    const req = http.request({ hostname: '127.0.0.1', port: DAEMON_PORT, path: '/stop', method: 'POST' });
    req.on('error', () => {});
    req.end();
    console.log('Daemon stopped.');
    endOperation('success', {}, { result: 'Daemon stopped.' });
    return;
  }

  if (cmd === 'replies') {
    const cid = args[1];
    if (!cid) { console.error('cid required'); process.exit(1); }
    let cursor = '', count = 20, noteId = '';
    for (let i = 2; i < args.length; i++) {
      if (args[i] === '--cursor') cursor = args[++i] || '';
      else if (args[i] === '--count') count = parseInt(args[++i]) || 20;
      else if (!noteId && !args[i].startsWith('--')) noteId = args[i];
    }
    startOperation('replies', { cid, note_id: noteId, cursor, count });
    console.error(`Fetching replies for ${cid}...`);
    const res = await loggedSend('replies', { cid, note_id: noteId, cursor, count },
      `window.__xhs.getSubComments('${noteId}', '${cid}', '${cursor}', ${count})`, false);
    if (!res.ok) throw new Error(res.error);
    const data = res.value || {};
    const items = (data.data?.comments || data.comments || []).map(normalizeComment);
    if (rawMode) {
      console.log(JSON.stringify(data, null, 2));
    } else {
      console.log(JSON.stringify(items, null, 2));
    }
    endOperation('success', { count: items.length, has_more: data.data?.has_more }, { comments: items });
    return;
  }

  if (cmd === 'post') {
    const noteId = args[1];
    if (!noteId) { console.error('note_id required'); process.exit(1); }
    let content = '';
    let replyTo = null;
    for (let i = 2; i < args.length; i++) {
      if (args[i] === '--reply-to') replyTo = args[++i];
      else if (!args[i].startsWith('--') && !content) content = args[i];
    }
    if (!content) { console.error('Comment content required'); process.exit(1); }
    startOperation('post', { note_id: noteId, content, reply_to: replyTo });
    console.error(`Posting comment to ${noteId}...`);
    const replyToParam = replyTo ? `'${replyTo}'` : 'null';
    const res = await loggedSend('post', { note_id: noteId, content, reply_to: replyTo },
      `window.__xhs.publish('${noteId}', ${JSON.stringify(content)}, ${replyToParam}, [])`, false);
    if (!res.ok) throw new Error(res.error);
    const data = res.value || {};
    if (rawMode) {
      console.log(JSON.stringify(data, null, 2));
    } else {
      if (data.code === 0 || data.success) {
        const c = data.data?.comment || data.comment || data.data || {};
        console.log(JSON.stringify({
          cid: c.id || c.comment_id || c.cid,
          text: c.content || content,
          time: c.create_time || Math.floor(Date.now() / 1000),
          status: 'published',
        }, null, 2));
      } else {
        console.log(JSON.stringify({
          error: data.msg || data.message || `code=${data.code}`,
          code: data.code,
        }, null, 2));
      }
    }
    const success = data.code === 0 || data.success;
    endOperation(success ? 'success' : 'error',
      { code: data.code, msg: data.msg },
      { result: data },
      success ? null : (data.msg || `code=${data.code}`));
    return;
  }

  if (cmd === 'delete') {
    const noteId = args[1];
    const commentId = args[2];
    if (!noteId || !commentId) { console.error('Usage: node cli.js delete <note_id> <comment_id>'); process.exit(1); }
    startOperation('delete', { note_id: noteId, comment_id: commentId });
    console.error(`Deleting comment ${commentId}...`);
    const res = await loggedSend('delete', { note_id: noteId, comment_id: commentId },
      `window.__xhs.deleteComment('${noteId}', '${commentId}')`, false);
    if (!res.ok) throw new Error(res.error);
    const data = res.value || {};
    if (rawMode) {
      console.log(JSON.stringify(data, null, 2));
    } else {
      console.log(JSON.stringify({
        status: data.code === 0 ? 'deleted' : 'failed',
        code: data.code,
        msg: data.msg || '',
      }, null, 2));
    }
    endOperation(data.code === 0 ? 'success' : 'error', { code: data.code }, { result: data });
    return;
  }

  if (cmd === 'like') {
    const noteId = args[1];
    const commentId = args[2];
    if (!noteId || !commentId) { console.error('Usage: node cli.js like <note_id> <comment_id>'); process.exit(1); }
    startOperation('like', { note_id: noteId, comment_id: commentId });
    const res = await loggedSend('like', { note_id: noteId, comment_id: commentId },
      `window.__xhs.likeComment('${noteId}', '${commentId}')`, false);
    if (!res.ok) throw new Error(res.error);
    const data = res.value || {};
    if (rawMode) {
      console.log(JSON.stringify(data, null, 2));
    } else {
      console.log(JSON.stringify({
        status: data.code === 0 ? 'liked' : 'failed',
        code: data.code,
      }, null, 2));
    }
    endOperation(data.code === 0 ? 'success' : 'error', { code: data.code }, { result: data });
    return;
  }

  if (cmd === 'my') {
    let cursor = '', count = 30;
    for (let i = 1; i < args.length; i++) {
      if (args[i] === '--cursor') cursor = args[++i] || '';
      else if (args[i] === '--count') count = parseInt(args[++i]) || 30;
    }
    startOperation('my', { cursor, count });
    console.error('Fetching my notes...');
    const res = await loggedSend('my', { cursor, count },
      `window.__xhs.myNotes('${cursor}', ${count})`, false);
    if (!res.ok) throw new Error(res.error);
    const data = res.value || {};
    if (rawMode) {
      console.log(JSON.stringify(data, null, 2));
    } else {
      const notes = (data.data?.notes || data.notes || []).map(normalizeNote);
      console.log(JSON.stringify(notes, null, 2));
    }
    const items = data.data?.notes || data.notes || [];
    endOperation('success', { count: items.length, has_more: data.data?.has_more }, { notes: items });
    return;
  }

  if (cmd === 'search') {
    let keyword = '';
    let page = 1, pageSize = 20;
    for (let i = 1; i < args.length; i++) {
      if (args[i] === '--page') page = parseInt(args[++i]) || 1;
      else if (args[i] === '--count') pageSize = parseInt(args[++i]) || 20;
      else if (!args[i].startsWith('--') && !keyword) keyword = args[i];
    }
    if (!keyword) { console.error('keyword required'); process.exit(1); }
    startOperation('search', { keyword, page, page_size: pageSize });
    console.error(`Searching "${keyword}"...`);
    const res = await loggedSend('search', { keyword, page, page_size: pageSize },
      `window.__xhs.search(${JSON.stringify(keyword)}, ${page}, ${pageSize})`, false);
    if (!res.ok) throw new Error(res.error);
    const data = res.value || {};
    if (rawMode) {
      console.log(JSON.stringify(data, null, 2));
    } else {
      const notes = (data.data?.items || data.data?.notes || data.items || []).map(normalizeNote);
      console.log(JSON.stringify(notes, null, 2));
    }
    const items = data.data?.items || data.data?.notes || data.items || [];
    endOperation('success', { count: items.length, has_more: data.data?.has_more }, { notes: items });
    return;
  }

  if (cmd === 'get') {
    const noteId = args[1];
    if (!noteId) { console.error('note_id required'); process.exit(1); }

    let cursor = '', count = 20, pages = 1, depth = 0;
    let allMode = false, newMode = false, sinceTs = null;

    for (let i = 2; i < args.length; i++) {
      if (args[i] === '--count') count = parseInt(args[++i]) || 20;
      else if (args[i] === '--pages') pages = parseInt(args[++i]) || 1;
      else if (args[i] === '--all') allMode = true;
      else if (args[i] === '--depth') depth = parseInt(args[++i]) || 0;
      else if (args[i] === '--new') newMode = true;
      else if (args[i] === '--since') sinceTs = parseInt(args[++i]) || null;
      else if (args[i] === '--cursor') cursor = args[++i] || '';
    }

    if (newMode && !sinceTs) {
      sinceTs = findLastFetchTime(noteId);
      if (sinceTs) {
        console.error(`[incremental] Last fetch: ${new Date(sinceTs * 1000).toISOString()}`);
      } else {
        console.error('[incremental] No history found, falling back to full fetch');
      }
    }

    if (allMode) pages = 999;
    startOperation('get', { note_id: noteId, cursor, count, pages, depth, new_mode: newMode, since: sinceTs });

    const allComments = [];
    const seenCids = new Set();
    let apiCalls = 0;
    let stopped = false;

    for (let p = 0; p < pages && !stopped; p++) {
      console.error(`Fetching page ${p + 1}${pages < 999 ? '/' + pages : ''} (cursor=${cursor || 'start'})...`);
      const res = await loggedSend('getComments', { note_id: noteId, cursor, count },
        `window.__xhs.getComments('${noteId}', '${cursor}', ${count})`, false);
      apiCalls++;
      if (!res.ok) throw new Error(res.error);

      const data = res.value || {};
      const comments = data.data?.comments || data.comments || [];
      const hasMore = data.data?.has_more !== undefined ? data.data.has_more : (comments.length >= count);
      const nextCursor = data.data?.cursor || '';

      if (comments.length === 0) break;

      let filtered = comments;
      let oldCutoff = 0;
      if (sinceTs) {
        filtered = comments.filter(c => {
          const ct = (c.create_time || c.time || 0) / 1000;
          return ct > sinceTs;
        });
        oldCutoff = comments.length - filtered.length;
        if (oldCutoff > 0) {
          console.error(`[incremental] Filtered ${oldCutoff} old comments, kept ${filtered.length} new`);
        }
      }

      for (const c of filtered) {
        if (seenCids.has(c.id || c.comment_id)) continue;
        seenCids.add(c.id || c.comment_id);
        const nc = normalizeComment(c);

        // 获取子评论
        if (depth >= 1 && nc.replies > 0) {
          let subCursor = '';
          const allChildren = [];
          const subSeen = new Set();
          for (let sp = 0; sp < 10; sp++) {
            const subRes = await loggedSend('getSubComments',
              { note_id: noteId, root_comment_id: nc.cid, cursor: subCursor },
              `window.__xhs.getSubComments('${noteId}', '${nc.cid}', '${subCursor}', ${count})`, false);
            apiCalls++;
            if (!subRes.ok) break;
            const subData = subRes.value || {};
            const subs = subData.data?.comments || subData.comments || [];
            if (subs.length === 0) break;
            for (const s of subs) {
              if (subSeen.has(s.id || s.comment_id)) continue;
              subSeen.add(s.id || s.comment_id);
              allChildren.push(normalizeComment(s));
            }
            subCursor = subData.data?.cursor || '';
            if (!subData.data?.has_more) break;
          }
          nc.children = allChildren;
        }
        allComments.push(nc);
      }

      // 增量模式：遇到旧评论立即停止
      if (sinceTs && oldCutoff > 0) {
        console.error(`[incremental] Reached old comments, stopping.`);
        stopped = true;
        break;
      }

      if (!hasMore || !nextCursor) break;
      cursor = nextCursor;
    }

    if (rawMode) {
      console.log(JSON.stringify(allComments, null, 2));
    } else {
      console.log(JSON.stringify(allComments, null, 2));
    }
    endOperation('success',
      { comments: allComments.length, pages_used: Math.min(pages, allComments.length > 0 ? Math.ceil(allComments.length / count) : 0), api_calls: apiCalls, depth, mode: newMode ? 'incremental' : 'full' },
      { comments: allComments });
    return;
  }

  if (cmd === 'analyze') {
    const noteId = args[1];
    if (!noteId) { console.error('note_id required'); process.exit(1); }

    // 检查 LLM key
    let llmConfig = {};
    try { llmConfig = require('./config.json').llm || {}; } catch {}
    const apiKey = llmConfig.api_key || process.env.OPENAI_API_KEY;
    if (!apiKey) {
      console.error('LLM API key not configured. Set api_key in config.json or OPENAI_API_KEY env.');
      process.exit(1);
    }

    // 先从文件加载评论，如果没有则自动拉取
    startOperation('analyze', { note_id: noteId });
    console.error(`Analyzing comments for note ${noteId}...`);

    // 尝试从最近的 get 结果中读取评论
    let comments = [];
    const resultsDir = path.join(__dirname, 'logs', 'results');
    if (fs.existsSync(resultsDir)) {
      const files = fs.readdirSync(resultsDir)
        .filter(f => f.startsWith('get-' + noteId) && f.endsWith('.json'))
        .sort()
        .reverse();
      if (files.length > 0) {
        const data = JSON.parse(fs.readFileSync(path.join(resultsDir, files[0]), 'utf8'));
        comments = data.comments || [];
      }
    }

    if (comments.length === 0) {
      // 自动拉取 100 条评论
      console.error('No cached comments found. Fetching up to 100 comments...');
      let cursor = '';
      const fetchedCmts = [];
      for (let p = 0; p < 5; p++) {
        const res = await loggedSend('getComments', { note_id: noteId, cursor },
          `window.__xhs.getComments('${noteId}', '${cursor}', 20)`, false);
        if (!res.ok) break;
        const data = res.value || {};
        const cmts = data.data?.comments || data.comments || [];
        fetchedCmts.push(...cmts);
        cursor = data.data?.cursor || '';
        if (!data.data?.has_more || !cursor) break;
      }
      comments = fetchedCmts.map(normalizeComment);
    }

    if (comments.length === 0) {
      console.log('[]');
      endOperation('success', { analyzed: 0 }, { analysis: [] });
      return;
    }

    const { LLMClient } = require('./lib/llm');
    const llm = new LLMClient();
    const strategy = { style: '自然亲切' };
    const analysis = await llm.analyzeComments(
      comments.map(c => ({ cid: c.cid, text: c.text })),
      strategy
    );

    const result = (Array.isArray(analysis) ? analysis : []).map(a => ({
      ...a,
      text: comments.find(c => c.cid === a.cid)?.text?.substring(0, 50) || '',
    }));

    console.log(JSON.stringify(result, null, 2));
    endOperation('success', { analyzed: result.length }, { analysis: result });
    return;
  }

  if (cmd === 'suggest') {
    const noteId = args[1];
    if (!noteId) { console.error('note_id required'); process.exit(1); }
    const autoMode = args.includes('--auto');
    let minPriority = 1;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--min-priority') minPriority = parseInt(args[++i]) || 1;
    }

    let llmConfig = {};
    try { llmConfig = require('./config.json').llm || {}; } catch {}
    const apiKey = llmConfig.api_key || process.env.OPENAI_API_KEY;
    if (!apiKey) {
      console.error('LLM API key not configured. Set api_key in config.json or OPENAI_API_KEY env.');
      process.exit(1);
    }

    startOperation('suggest', { note_id: noteId, auto: autoMode, min_priority: minPriority });
    console.error(`Generating reply suggestions for note ${noteId}...`);

    // 加载评论
    let comments = [];
    const resultsDir = path.join(__dirname, 'logs', 'results');
    if (fs.existsSync(resultsDir)) {
      const files = fs.readdirSync(resultsDir)
        .filter(f => f.startsWith('get-' + noteId) && f.endsWith('.json'))
        .sort().reverse();
      if (files.length > 0) {
        const data = JSON.parse(fs.readFileSync(path.join(resultsDir, files[0]), 'utf8'));
        comments = data.comments || [];
      }
    }

    if (comments.length === 0) {
      console.error('No cached comments. Run `node cli.js get <note_id> --all` first.');
      process.exit(1);
    }

    // 先分析
    const { LLMClient } = require('./lib/llm');
    const llm = new LLMClient();
    const strategy = { style: '自然亲切' };
    const analysis = await llm.analyzeComments(
      comments.map(c => ({ cid: c.cid, text: c.text })),
      strategy
    );

    // 筛选高优先级
    const highPriority = (Array.isArray(analysis) ? analysis : [])
      .filter(a => a.priority >= minPriority);

    if (highPriority.length === 0) {
      console.log(JSON.stringify({ suggestions: [], note: 'No comments meet priority threshold' }, null, 2));
      endOperation('success', { suggestions: 0, auto_published: 0 });
      return;
    }

    // 生成回复建议
    const suggestions = await llm.suggestReplies(
      highPriority.map(a => ({ cid: a.cid, text: comments.find(c => c.cid === a.cid)?.text || '' })),
      strategy,
      comments[0]?.text?.substring(0, 60) || noteId
    );

    const suggestList = Array.isArray(suggestions) ? suggestions : [];
    let autoPublished = 0, autoFailed = 0;

    // 自动发布
    if (autoMode) {
      for (const s of suggestList) {
        if (!s.reply || !s.cid) continue;
        console.error(`[auto] Replying to ${s.cid}: ${s.reply.substring(0, 40)}...`);
        const res = await loggedSend('post', { note_id: noteId, content: s.reply, reply_to: s.cid },
          `window.__xhs.publish('${noteId}', ${JSON.stringify(s.reply)}, '${s.cid}', [])`, false);
        const data = res.value || {};
        if (data.code === 0 || data.success) {
          s.published = true;
          autoPublished++;
        } else {
          s.published = false;
          s.error = data.msg || `code=${data.code}`;
          autoFailed++;
        }
      }
    }

    console.log(JSON.stringify({ suggestions: suggestList, auto_published: autoPublished, auto_failed: autoFailed }, null, 2));
    endOperation('success', { suggestions: suggestList.length, auto_published: autoPublished, auto_failed: autoFailed });
    return;
  }

  if (cmd === 'dashboard') {
    let noteId = null;
    let days = 14;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--note') noteId = args[++i];
      else if (args[i] === '--days') days = parseInt(args[++i]) || 14;
    }
    startOperation('dashboard', { note_id: noteId, days });
    const html = generateDashboardHTML(noteId, days);
    const outFile = path.join(LOG_DIR, `dashboard-${new Date().toISOString().replace(/[:.]/g,'-').substring(0,19)}.html`);
    fs.writeFileSync(outFile, html);
    console.log(`Dashboard saved: ${outFile}`);
    // 尝试打开浏览器
    const { exec } = require('child_process');
    exec(`start "" "${outFile}"`, () => {});
    endOperation('success', { file: outFile });
    return;
  }

  if (cmd === 'profile') {
    const userId = args[1];
    if (!userId) { console.error('user_id required'); process.exit(1); }
    startOperation('profile', { user_id: userId });
    console.error(`Fetching profile for user ${userId}...`);
    const res = await loggedSend('userInfo', { user_id: userId },
      `window.__xhs.userInfo('${userId}')`, false);
    if (!res.ok) throw new Error(res.error);
    const data = res.value || {};
    if (rawMode) {
      console.log(JSON.stringify(data, null, 2));
    } else {
      const u = data.data || {};
      console.log(JSON.stringify({
        user_id: u.user_id || userId,
        nickname: u.nickname || '',
        avatar: u.image || u.images || '',
        desc: u.desc || '',
        stats: {
          follows: u.follows || 0,
          fans: u.fans || 0,
          notes: u.note_count || u.notes || 0,
          liked: u.liked_count || 0,
          collected: u.collected_count || 0,
        },
      }, null, 2));
    }
    endOperation('success', { user_id: userId });
    return;
  }

  if (cmd === 'log') {
    let tailN = 10, noteId = null, failedOnly = false;
    for (let i = 1; i < args.length; i++) {
      if (args[i] === '--tail') tailN = parseInt(args[++i]) || 10;
      else if (args[i] === '--note') noteId = args[++i];
      else if (args[i] === '--failed') failedOnly = true;
    }
    startOperation('log', { tail: tailN, note_id: noteId, failed: failedOnly });

    const a = loadAudit();
    const allOps = [];
    for (const s of (a.sessions || [])) {
      for (const op of (s.operations || [])) {
        if (noteId && op.args?.note_id !== noteId) continue;
        if (failedOnly && op.status !== 'error') continue;
        allOps.push(op);
      }
    }

    const ops = allOps.slice(-tailN);
    for (const op of ops) {
      const statusIcon = op.status === 'success' ? '✅' : op.status === 'error' ? '❌' : '⏳';
      const dur = op.durationMs ? (op.durationMs / 1000).toFixed(1) + 's' : '—';
      console.log(`${statusIcon} [${op.started?.substring(0,19) || '?'}] ${op.command} ${JSON.stringify(op.args)} ${dur}`);
      if (op.resultFile) console.log(`   result: ${op.resultFile}`);
      if (op.summary && Object.keys(op.summary).length) console.log(`   summary: ${JSON.stringify(op.summary)}`);
      if (op.error) console.log(`   error: ${op.error}`);
    }
    console.log(`\nTotal: ${ops.length} operations${noteId ? ' for note ' + noteId : ''}`);

    endOperation('success', { displayed: ops.length, total: allOps.length });
    return;
  }

  if (cmd === 'note') {
    const noteId = args[1];
    if (!noteId) { console.error('note_id required'); process.exit(1); }
    startOperation('note', { note_id: noteId });
    console.error(`Fetching note ${noteId}...`);
    const res = await loggedSend('getNote', { note_id: noteId },
      `window.__xhs.getNote('${noteId}')`, false);
    if (!res.ok) throw new Error(res.error);
    const data = res.value || {};
    if (rawMode) {
      console.log(JSON.stringify(data, null, 2));
    } else {
      const item = data.data?.items?.[0]?.note_card || data.data;
      if (item) {
        console.log(JSON.stringify(normalizeNote({ note_card: item }), null, 2));
      } else {
        console.log(JSON.stringify(data, null, 2));
      }
    }
    endOperation('success', { note_id: noteId });
    return;
  }

  console.error(`Unknown command: ${cmd}`);
  process.exit(1);

  } catch(e) {
    if (!noLog && currentOp) endOperation('error', {}, null, e.message);
    throw e;
  }
}

// ===== 入口 =====
if (DAEMON) {
  runDaemon().catch(e => { console.error('[daemon] Error:', e.message); process.exit(1); });
} else {
  runCli().catch(e => { console.error('[CLI] Error:', e.message); process.exit(1); });
}
