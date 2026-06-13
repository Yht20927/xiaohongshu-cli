#!/usr/bin/env node
const WebSocket = require('ws');
const fs = require('fs');
const os = require('os');
const path = require('path');

let cdpId = 0;
function cdpSend(ws, method, params, sessionId) {
  return new Promise((resolve, reject) => {
    const id = ++cdpId;
    const msg = { id, method, params: params || {} };
    if (sessionId) msg.sessionId = sessionId;
    const timer = setTimeout(() => reject(new Error(`${method} timeout`)), 15000);
    function onMsg(data) {
      try {
        const obj = JSON.parse(data.toString());
        if (obj.id === id) {
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

async function main() {
  const portFile = path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data', 'DevToolsActivePort');
  const lines = fs.readFileSync(portFile, 'utf8').trim().split('\n');
  const browserWsUrl = `ws://127.0.0.1:${lines[0]}${lines[1]}`;

  const ws = new WebSocket(browserWsUrl);
  await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });

  const targets = await cdpSend(ws, 'Target.getTargets');
  const wwwPage = (targets.targetInfos || []).find(t => t.url && t.url.startsWith('https://www.xiaohongshu.com') && t.type === 'page');
  if (!wwwPage) { console.error('No www.xiaohongshu.com page found'); ws.close(); process.exit(1); }

  console.log('Target:', wwwPage.title, wwwPage.url?.substring(0, 80));
  const attach = await cdpSend(ws, 'Target.attachToTarget', { targetId: wwwPage.targetId, flatten: true });
  const sid = attach.sessionId;

  // Enable Runtime
  await cdpSend(ws, 'Runtime.enable', {}, sid);

  // Step 1: Check _webmsxyw
  console.log('\n=== Step 1: Check window._webmsxyw ===');
  const r1 = await cdpSend(ws, 'Runtime.evaluate', {
    expression: `typeof window._webmsxyw`,
    returnByValue: true,
  }, sid);
  console.log('typeof _webmsxyw:', r1.result?.value);

  // Step 2: Check webpack
  console.log('\n=== Step 2: Check webpack ===');
  const r2 = await cdpSend(ws, 'Runtime.evaluate', {
    expression: `!!window.webpackChunkxhs_pc_web`,
    returnByValue: true,
  }, sid);
  console.log('hasWebpack:', r2.result?.value);

  // Step 3: Get all window keys that might be signing functions
  console.log('\n=== Step 3: Scan window for signing functions ===');
  const r3 = await cdpSend(ws, 'Runtime.evaluate', {
    expression: `(function() {
      var result = [];
      for (var key in window) {
        try {
          var val = window[key];
          if (typeof val === 'function') {
            var src = val.toString().substring(0, 100);
            if (src.indexOf('x-s') >= 0 || src.indexOf('x-s-common') >= 0 || src.indexOf('sign') >= 0 || src.indexOf('encrypt') >= 0) {
              result.push({ name: key, preview: src.substring(0, 100) });
            }
          }
        } catch(e) {}
      }
      return JSON.stringify(result);
    })()`,
    returnByValue: true,
  }, sid);
  console.log('Sign-related window functions:', r3.result?.value);

  // Step 4: Scan webpack for axios instances with interceptors
  console.log('\n=== Step 4: Scan webpack for axios with interceptors ===');
  const r4 = await cdpSend(ws, 'Runtime.evaluate', {
    expression: `(function() {
      var chunk = window.webpackChunkxhs_pc_web;
      if (!chunk) return JSON.stringify({ error: 'no webpack' });
      var require = null;
      try { chunk.push([[Date.now()+'_s'],{},function(r){require=r;}]); } catch(e) {}
      if (!require || !require.c) return JSON.stringify({ error: 'no require' });

      var results = [];
      var cache = require.c;
      for (var id in cache) {
        if (!cache.hasOwnProperty(id)) continue;
        var mod = cache[id];
        if (!mod || !mod.exports) continue;
        var exp = mod.exports;
        var candidates = [exp, exp.default, exp.Z, exp.A, exp.N];
        for (var j = 0; j < candidates.length; j++) {
          var v = candidates[j];
          if (!v || typeof v !== 'object') continue;
          if (typeof v.request !== 'function' || !v.interceptors) continue;
          var handlers = (v.interceptors.request && v.interceptors.request.handlers) || [];
          var interceptorSrcs = [];
          for (var h = 0; h < handlers.length; h++) {
            if (handlers[h] && typeof handlers[h].fulfilled === 'function') {
              var s = '';
              try { s = handlers[h].fulfilled.toString().substring(0, 300); } catch(e) {}
              interceptorSrcs.push({ idx: h, src: s });
            }
          }
          results.push({ moduleId: id, keyIdx: j, interceptorCount: interceptorSrcs.length, interceptors: interceptorSrcs });
        }
      }
      return JSON.stringify(results, null, 2);
    })()`,
    returnByValue: true,
  }, sid);
  console.log(r4.result?.value);

  // Step 5: Check __xhs state
  console.log('\n=== Step 5: Check __xhs state ===');
  const r5 = await cdpSend(ws, 'Runtime.evaluate', {
    expression: `JSON.stringify(window.__xhs ? {
      installed: window.__xhs.__installed,
      hasSignFn: typeof window.__xhs._signRequest === 'function',
      capture: window.__xhs.state ? window.__xhs.state.capture : null
    } : 'no __xhs')`,
    returnByValue: true,
  }, sid);
  console.log(r5.result?.value);

  ws.close();
}

main().catch(e => { console.error('Error:', e.message); process.exit(1); });
