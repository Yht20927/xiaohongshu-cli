// ==UserScript==
// @name         Bridge: Xiaohongshu
// @namespace    bridge-framework
// @match        *://*.xiaohongshu.com/*
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      127.0.0.1
// ==/UserScript==

// ═══════════════════════════════════════════════════════════
// Bridge Framework — 小红书脚本
// 通过 GM_xmlhttpRequest 绕过 Chrome PNA loopback 限制
// unsafeWindow 用于页面上下文的 eval 和 __bridge API
// ═══════════════════════════════════════════════════════════

(function() {
  'use strict';

  const CONFIG = {
    server: 'http://127.0.0.1:19424',
    site: 'xiaohongshu.com',
    token: '',
    reconnectDelay: 2000,
  };

  let connected = false;
  let registered = false;
  let retryCount = 0;
  let pollFailCount = 0;

  function gmFetch(url, opts) {
    var headers = Object.assign({}, opts && opts.headers);
    if (CONFIG.token) headers['Authorization'] = 'Bearer ' + CONFIG.token;
    return new Promise(function(resolve, reject) {
      GM_xmlhttpRequest(Object.assign({ url: url, timeout: 35000 }, opts, {
        headers: headers,
        onload: function(r) { resolve(r); },
        onerror: function(e) { reject(new Error('GM_xmlhttpRequest failed')); },
        ontimeout: function() { reject(new Error('GM_xmlhttpRequest timeout')); },
      }));
    });
  }

  async function connect() {
    if (!registered) {
      try {
        console.log('[Bridge:XHS] Registering via GM_xmlhttpRequest...');
        var r = await gmFetch(CONFIG.server + '/api/connect', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          data: JSON.stringify({
            site: CONFIG.site,
            url: location.href,
            title: document.title,
            userAgent: navigator.userAgent,
          }),
        });
        if (r.status === 200) {
          registered = true;
          connected = true;
          retryCount = 0;
          console.log('[Bridge:XHS] Registered with Bridge Server');
        } else {
          throw new Error('status ' + r.status);
        }
      } catch (err) {
        retryCount++;
        var delay = Math.min(CONFIG.reconnectDelay * Math.pow(2, retryCount - 1), 60000);
        console.warn('[Bridge:XHS] Registration failed, retry in ' + Math.round(delay/1000) + 's:', err.message);
        setTimeout(connect, delay);
        return;
      }
    }
    poll();
  }

  async function poll() {
    if (!registered) return;
    try {
      var r = await gmFetch(CONFIG.server + '/api/poll?site=' + CONFIG.site, { method: 'GET' });
      if (r.status !== 200) throw new Error('status ' + r.status);
      var msg = JSON.parse(r.responseText);

      if (msg.type === 'eval') {
        connected = true;
        pollFailCount = 0;
        try {
          var result = (0, unsafeWindow.eval)(msg.expression);
          if (msg.awaitPromise !== false) result = await Promise.resolve(result);
          await gmFetch(CONFIG.server + '/api/result', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            data: JSON.stringify({ id: msg.id, value: safeSerialize(result) }),
          });
        } catch (e) {
          await gmFetch(CONFIG.server + '/api/result', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            data: JSON.stringify({ id: msg.id, error: e.message || String(e) }),
          });
        }
        poll();
      } else {
        connected = true;
        pollFailCount = 0;
        poll();
      }
    } catch (err) {
      pollFailCount++;
      if (pollFailCount >= 3) {
        console.warn('[Bridge:XHS] Poll failed repeatedly, reconnecting:', err.message);
        connected = false;
        registered = false;
        pollFailCount = 0;
        setTimeout(connect, CONFIG.reconnectDelay);
      } else {
        setTimeout(poll, 1000);
      }
    }
  }

  function safeSerialize(value) {
    try {
      return JSON.parse(JSON.stringify(value === undefined ? null : value));
    } catch(e) { return null; }
  }

  // ── SPA 导航检测 ──
  var lastUrl = location.href;
  function checkUrlChange() {
    if (location.href !== lastUrl) lastUrl = location.href;
  }
  var _pushState = unsafeWindow.history.pushState;
  var _replaceState = unsafeWindow.history.replaceState;
  unsafeWindow.history.pushState = function() { _pushState.apply(this, arguments); checkUrlChange(); };
  unsafeWindow.history.replaceState = function() { _replaceState.apply(this, arguments); checkUrlChange(); };
  unsafeWindow.addEventListener('popstate', checkUrlChange);
  unsafeWindow.addEventListener('hashchange', checkUrlChange);

  // ═══════════════════════════════════════════════════════════
  // 小红书 Bridge API — 注入页面上下文
  // 使用页面 webpack 中的 axios 实例，所有签名自动注入
  // ═══════════════════════════════════════════════════════════

    var BRIDGE_CODE = (function(){/*
(function() {
  "use strict";
  var BASE = "https://edith.xiaohongshu.com";

  function getWebpackRequire() {
    if (window.__xhsWpr) return window.__xhsWpr;
    var chunk = window.webpackChunkxhs_pc_web;
    if (!chunk || typeof chunk.push !== "function") return null;
    try {
      var key = "xhs_b_" + Date.now();
      chunk.push([[key], {}, function(r) { window.__xhsWpr = r; }]);
    } catch(e) {}
    return window.__xhsWpr || null;
  }

  function findAxios() {
    var req = getWebpackRequire();
    if (!req || !req.c) return null;
    for (var id in req.c) {
      if (!req.c.hasOwnProperty(id)) continue;
      var exp = (req.c[id] || {}).exports;
      if (!exp) continue;
      var cands = [exp, exp.default, exp.Z, exp.A, exp.N];
      for (var i = 0; i < cands.length; i++) {
        var c = cands[i];
        if (!c || typeof c !== "object") continue;
        if (typeof c.get !== "function" && typeof c.post !== "function") continue;
        if (!c.interceptors) continue;
        window.__xhsAxios = c;
        window.__xhsAxiosId = id;
        return c;
      }
    }
    var mod = req.c["85456"];
    if (mod && mod.exports) {
      var d = mod.exports.default || mod.exports;
      if (d && (typeof d.get === "function" || typeof d.post === "function")) {
        window.__xhsAxios = d;
        window.__xhsAxiosId = "85456";
        return d;
      }
    }
    return null;
  }

  function getAxios() {
    if (window.__xhsAxios) {
      if (typeof window.__xhsAxios.get === "function" || typeof window.__xhsAxios.post === "function")
        return window.__xhsAxios;
      window.__xhsAxios = null;
      window.__xhsAxiosId = null;
    }
    if (!window.__xhsWpr) getWebpackRequire();
    var a = findAxios();
    if (a) return a;
    throw new Error("axios not captured");
  }

  function buildUrl(path, query) {
    var url = BASE + path;
    if (query) {
      var parts = [];
      for (var k in query) {
        if (!query.hasOwnProperty(k)) continue;
        var v = query[k];
        if (v === undefined || v === null) continue;
        parts.push(encodeURIComponent(k) + "=" + encodeURIComponent(v));
      }
      if (parts.length > 0) url += "?" + parts.join("&");
    }
    return url;
  }

  function sid() {
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function(c) {
      var r = Math.random() * 16 | 0;
      return (c === "x" ? r : r & 0x3 | 0x8).toString(16);
    });
  }

  // 把 err 完整序列化（自身属性 + response/config 摘要）方便 CLI 看真因
  function dumpErr(err) {
    var d = { message: (err && err.message) || String(err) };
    if (err && typeof err === "object") {
      try {
        for (var k in err) {
          if (k === "request" || k === "config") continue;
          try { d[k] = err[k]; } catch(e) {}
        }
      } catch(e) {}
      if (err.response) {
        d.response = {
          status: err.response.status,
          statusText: err.response.statusText,
          data: err.response.data,
        };
      }
      if (err.config) {
        d.config = { url: err.config.url, method: err.config.method, baseURL: err.config.baseURL };
      }
      if (err.stack) d.stack = String(err.stack).split("\n").slice(0, 4).join(" | ");
    }
    return d;
  }

  // 标准 rawCall：不旁路响应拦截器，让 xhs 自己完成签名/解密/字段补全。
  // 成功 → 返回 axios then 给的值（通常已经是 xhs envelope 或其内容）
  // 失败 → 把 dumpErr 输出整条塞进 message 抛出，让 CLI 能看到真因
  function rawCall(method, path, query, body) {
    var url = buildUrl(path, query);
    var ax = getAxios();
    var p = method === "GET" ? ax.get(url) : ax.post(url, body || {});
    return p.then(function(r) {
      // 三种返回形态都要兼容：
      //  A) axios response 原始: { status, headers, data: {code,msg,data,success} }
      //  B) xhs envelope: { code, msg, data, success }   ← 拦截器把 envelope 直接交出
      //  C) 内容: notes/items/items 等                    ← 拦截器把 envelope 的 data 拆掉了
      if (r && typeof r === "object") {
        if (typeof r.status === "number" && r.data && typeof r.data === "object" && "code" in r.data) {
          return r.data; // A → envelope
        }
        if ("code" in r && "data" in r && ("success" in r || "msg" in r)) {
          return r; // B → envelope，原样回（CLI 会再 unwrap data）
        }
        // C → 内容（notes/items），包成伪 envelope 让 CLI 一致处理
        return { code: 0, success: true, msg: "ok", data: r, _unwrapped_by_interceptor: true };
      }
      return r;
    }).catch(function(err) {
      var d = dumpErr(err);
      // 优先：err.response.data 是 xhs envelope，直接返回，让 CLI 走统一 code 判断
      if (d.response && d.response.data && typeof d.response.data === "object") {
        var pkg = d.response.data;
        pkg._http_status = d.response.status;
        if (pkg.code === undefined) pkg.code = -1 * d.response.status;
        return pkg;
      }
      // 否则把 dump 完整抛出
      var brief = (d.response && d.response.status ? ("HTTP " + d.response.status + " ") : "")
        + (d.message || "axios error");
      var e2 = new Error("[xhs-call] " + brief + " (path=" + path + ") " + JSON.stringify(d).slice(0, 800));
      e2._xhsDump = d;
      throw e2;
    });
  }

  // 专用：通过临时旁路响应拦截器调用，拿到完全原始的 envelope（含风控 code）
  // 仅用于 getNote 等需要看到 461/-10000 原始 code 的接口
  var _respSnap = null;
  function rawCallBypass(method, path, query, body) {
    var url = buildUrl(path, query);
    var ax = getAxios();
    var ir = ax && ax.interceptors && ax.interceptors.response;
    var snapshot = null;
    if (ir && ir.handlers) {
      snapshot = ir.handlers.slice();
      for (var i = 0; i < ir.handlers.length; i++) ir.handlers[i] = null;
    }
    function restore() {
      if (!snapshot || !ir || !ir.handlers) return;
      for (var i = 0; i < snapshot.length && i < ir.handlers.length; i++) ir.handlers[i] = snapshot[i];
    }
    var cfg = { validateStatus: function() { return true; } };
    var p = method === "GET" ? ax.get(url, cfg) : ax.post(url, body || {}, cfg);
    return p.then(function(r) {
      restore();
      if (r && typeof r === "object" && "status" in r && "data" in r) {
        var pkg = r.data;
        if (r.status >= 400 && pkg && typeof pkg === "object") {
          pkg._http_status = r.status;
          if (pkg.code === undefined) pkg.code = -1 * r.status;
        }
        return pkg;
      }
      return r;
    }).catch(function(err) {
      restore();
      var d = dumpErr(err);
      if (d.response && d.response.data && typeof d.response.data === "object") {
        var pkg = d.response.data;
        pkg._http_status = d.response.status;
        if (pkg.code === undefined) pkg.code = -1 * d.response.status;
        return pkg;
      }
      var brief = (d.response && d.response.status ? ("HTTP " + d.response.status + " ") : "")
        + (d.message || "axios error");
      var e2 = new Error("[xhs-call-bypass] " + brief + " (path=" + path + ") " + JSON.stringify(d).slice(0, 800));
      e2._xhsDump = d;
      throw e2;
    });
  }

  // 通过 SPA 路由切到 explore 页 + 等 __INITIAL_STATE__ 拿 note（风控兜底）
  async function getNoteFromPage(nid, xtoken) {
    var target = "/explore/" + nid + (xtoken ? ("?xsec_token=" + encodeURIComponent(xtoken) + "&xsec_source=pc_search") : "");
    var nav = window.__NEXT_ROUTER__ || null;
    if (location.pathname.indexOf("/explore/" + nid) === -1) {
      // 用 history pushState 触发 SPA 路由
      try { window.history.pushState({}, "", target); window.dispatchEvent(new PopStateEvent("popstate")); } catch(e) {}
    }
    // 轮询 __INITIAL_STATE__ 拿 note；最多 8s
    var t0 = Date.now();
    while (Date.now() - t0 < 8000) {
      var state = window.__INITIAL_STATE__ || {};
      var nd = state.note || state.noteDetail || state.NoteDetail || {};
      var noteMap = nd.noteDetailMap || nd.noteDetail || nd.detailMap || {};
      var hit = noteMap && (noteMap[nid] || noteMap._rawValue && noteMap._rawValue[nid]);
      if (hit) {
        var note = (hit.note) || hit;
        if (note && (note.note_id || note.id || note.title)) {
          return { code: 0, success: true, data: { items: [{ id: nid, note_card: note, model_type: "note" }] }, _source: "page" };
        }
      }
      await new Promise(function(r){ setTimeout(r, 250); });
    }
    return { code: -1, msg: "getNoteFromPage timeout: __INITIAL_STATE__ not populated", _source: "page" };
  }

  window.__bridge = {
    getMe:          function() { return rawCall("GET", "/api/sns/web/v2/user/me"); },
    search:         function(kw, pg, ps) { return rawCall("POST", "/api/sns/web/v1/search/notes", null, {keyword:kw, page:pg||1, page_size:ps||20, search_id:sid(), sort:"general", note_type:0}); },
    // image_formats 必须是数组、extra 必须是对象、payload 顺序匹配新版接口
    getNote:        function(nid, xtoken, xsource) {
      var body = {
        source_note_id: nid,
        image_formats: ["jpg","webp","avif"],
        extra: { need_body_topic: "1" }
      };
      if (xtoken) body.xsec_token = xtoken;
      body.xsec_source = xsource || "pc_search";
      // bypass：让 CLI 拿到原始 code（含风控/无权限）
      return rawCallBypass("POST", "/api/sns/web/v1/feed", null, body);
    },
    getNoteFromPage: getNoteFromPage,
    getComments:    function(nid, c, n, xtoken) {
      var q = { note_id: nid, cursor: c||"", top_comment_id: "", count: n||20, image_formats: "jpg,webp,avif" };
      if (xtoken) q.xsec_token = xtoken;
      return rawCall("GET", "/api/sns/web/v2/comment/page", q);
    },
    getSubComments: function(nid, rcid, c, n, xtoken) {
      var q = { note_id: nid, root_comment_id: rcid, cursor: c||"", count: n||20, image_formats: "jpg,webp,avif" };
      if (xtoken) q.xsec_token = xtoken;
      return rawCall("GET", "/api/sns/web/v2/comment/sub/page", q);
    },
    publish:        function(nid, txt, rto, at) { var b={note_id:nid, content:txt, at_users:at||[]}; if(rto)b.target_comment_id=rto; return rawCall("POST", "/api/sns/web/v1/comment/post", null, b); },
    deleteComment:  function(nid, cid) { return rawCall("POST", "/api/sns/web/v1/comment/delete", null, {note_id:nid, comment_id:cid}); },
    likeComment:    function(nid, cid) { return rawCall("POST", "/api/sns/web/v1/comment/like", null, {note_id:nid, comment_id:cid}); },
    myNotes:        async function(c, n) {
      var me = await this.getMe();
      // 兼容 snake / camel 两种字段名
      var d = (me||{}).data || me || {};
      var uid = d.user_id || d.userId || d.user_id_str || d.userId_str;
      if (!uid) return { code:-1, msg:"Not logged in (no user_id in /me response): " + JSON.stringify(d).slice(0,200) };
      return rawCall("GET","/api/sns/web/v1/user_posted",{num:n||30,cursor:c||"",user_id:uid,image_formats:"jpg,webp,avif"});
    },
    userNotes:      function(uid, c, n) { return rawCall("GET", "/api/sns/web/v1/user_posted", {num:n||30, cursor:c||"", user_id:uid, image_formats:"jpg,webp,avif"}); },
    userInfo:       function(uid) { return rawCall("GET", "/api/sns/web/v1/user/otherinfo", {target_user_id:uid}); }
  };

  console.log("[Bridge:XHS] __bridge API ready (v7: 3-shape detect + getMe field fallback + error dump)");
})();
*/}).toString().match(/\/\*([\s\S]*)\*\//)[1];

  // 注入到页面上下文（用页面的 axios，自动签名）
  unsafeWindow.eval(BRIDGE_CODE);

  // ── 启动轮询 ──
  connect();

  console.log('[Bridge:Xiaohongshu] Ready — connected to ' + CONFIG.server);
})();
