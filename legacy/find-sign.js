#!/usr/bin/env node
const WebSocket = require('ws');
const fs = require('fs');
const os = require('os');
const path = require('path');
const portFile = path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data', 'DevToolsActivePort');
const lines = fs.readFileSync(portFile, 'utf8').trim().split('\n');
const ws = new WebSocket(`ws://127.0.0.1:${lines[0]}${lines[1]}`);
let cdpId = 0;
function evalJS(code, sid) {
  return new Promise((resolve, reject) => {
    const id = ++cdpId;
    const msg = { id, method: 'Runtime.evaluate', params: { expression: code, returnByValue: true, awaitPromise: false } };
    if (sid) msg.sessionId = sid;
    const timer = setTimeout(() => resolve('timeout'), 10000);
    ws.on('message', function h(data) {
      try { const obj = JSON.parse(data.toString()); if (obj.id === id) { ws.removeListener('message', h); clearTimeout(timer); resolve(obj.result?.value); } } catch(e) {}
    });
    ws.send(JSON.stringify(msg));
  });
}
ws.on('open', async () => {
  const targets = await evalJS('JSON.stringify((await (await fetch("http://127.0.0.1:9222/json")).json()).map(t=>({id:t.id,url:t.url?.substring(0,60)})))');
  console.log('Target search skipped, using DevToolsActivePort');

  // 直接 attach 到 www.xiaohongshu.com
  const targetInfo = await new Promise((resolve) => {
    const mid = ++cdpId;
    ws.send(JSON.stringify({ id: mid, method: 'Target.getTargets' }));
    ws.on('message', function h(data) {
      const obj = JSON.parse(data.toString());
      if (obj.id === mid) {
        ws.removeListener('message', h);
        const page = obj.result?.targetInfos?.find(t => t.url?.startsWith('https://www.xiaohongshu.com') && t.type === 'page');
        resolve(page);
      }
    });
  });

  if (!targetInfo) { console.log('No XHS page found'); ws.close(); return; }
  console.log('Target:', targetInfo.title, targetInfo.url?.substring(0, 80));

  const attachResult = await new Promise((resolve) => {
    const mid = ++cdpId;
    ws.send(JSON.stringify({ id: mid, method: 'Target.attachToTarget', params: { targetId: targetInfo.targetId, flatten: true } }));
    ws.on('message', function h(data) {
      const obj = JSON.parse(data.toString());
      if (obj.id === mid) { ws.removeListener('message', h); resolve(obj.result); }
    });
  });
  const sid = attachResult.sessionId;

  // 搜索 webpack 中所有拦截器
  console.log('\n=== Searching ALL interceptors ===');
  const r1 = await evalJS(`(function() {
    var chunk = window.webpackChunkxhs_pc_web;
    var require = null;
    try { chunk.push([[Date.now()+'_s'],{},function(r){require=r;}]); } catch(e) {}
    if (!require || !require.c) return 'no require';
    var found = [];
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
        for (var h = 0; h < handlers.length; h++) {
          if (!handlers[h] || typeof handlers[h].fulfilled !== 'function') continue;
          var src = '';
          try { src = handlers[h].fulfilled.toString().substring(0, 200); } catch(e) {}
          found.push({ id: id, key: j, idx: h, src: src });
        }
      }
    }
    return JSON.stringify(found, null, 2);
  })()`, sid);
  console.log(r1);

  ws.close();
  process.exit(0);
});
ws.on('error', e => { console.error(e.message); process.exit(1); });
setTimeout(() => process.exit(1), 20000);
