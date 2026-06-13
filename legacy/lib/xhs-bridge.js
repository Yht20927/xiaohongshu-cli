function buildXhsBridgeSource() {
  return String.raw`(function () {
  if (window.__xhs && window.__xhs.__installed) return;
  if (!window.location || String(window.location.hostname || '').indexOf('xiaohongshu.com') < 0) return;

  var BASE = 'https://edith.xiaohongshu.com';
  var TARGET_HOST = 'edith.xiaohongshu.com';
  var REQUIRED_HEADERS = ['x-s', 'x-s-common', 'x-t', 'x-b3-traceid', 'x-xray-traceid'];
  var HISTORY_LIMIT = 20;

  var nativeFetch = typeof window.fetch === 'function' ? window.fetch.bind(window) : null;
  var NativeXHR = window.XMLHttpRequest;
  var capturedAxios = null;
  var capturedAxiosSource = '';
  var capturedSignFn = null;
  var webpackRequire = null;
  var verifiedAxios = false;

  var state = window.__xhsState || (window.__xhsState = {
    __installed: true,
    version: 'transport-v3',
    transport: 'auto',
    capture: {
      webpack: false,
      axios: false,
      fetch: false,
      xhr: false,
      verified: false,
      signFn: false
    },
    last: null,
    history: []
  });

  function pushHistory(entry) {
    state.last = entry;
    state.history.push(entry);
    while (state.history.length > HISTORY_LIMIT) state.history.shift();
  }

  function lowerKeys(headers) {
    var out = {};
    if (!headers) return out;
    if (typeof headers.toJSON === 'function') {
      try { headers = headers.toJSON(); } catch (e) {}
    }
    if (typeof headers.forEach === 'function') {
      try {
        headers.forEach(function (value, key) {
          out[String(key).toLowerCase()] = String(value);
        });
        return out;
      } catch (e) {}
    }
    if (Array.isArray(headers)) {
      for (var i = 0; i < headers.length; i++) {
        var pair = headers[i];
        if (pair && pair.length >= 2) out[String(pair[0]).toLowerCase()] = String(pair[1]);
      }
      return out;
    }
    for (var key in headers) {
      if (!Object.prototype.hasOwnProperty.call(headers, key)) continue;
      var value = headers[key];
      if (value === undefined || typeof value === 'function') continue;
      out[String(key).toLowerCase()] = String(value);
    }
    return out;
  }

  function parseJSON(text) {
    if (text === undefined || text === null || text === '') return null;
    if (typeof text !== 'string') return text;
    try { return JSON.parse(text); } catch (e) { return text; }
  }

  function coerceResponseBody(value, status, statusText) {
    if (value && typeof value === 'object') return value;
    if (value === null || value === undefined || value === '') {
      return {
        code: status || 0,
        msg: statusText || 'HTTP ' + (status || 0)
      };
    }
    return {
      code: status || 0,
      msg: statusText || 'HTTP ' + (status || 0),
      raw: value
    };
  }

  function buildQuery(query) {
    if (!query) return '';
    var parts = [];
    for (var key in query) {
      if (!Object.prototype.hasOwnProperty.call(query, key)) continue;
      var value = query[key];
      if (value === undefined || value === null) continue;
      // 保留逗号不编码，与页面行为一致
      var encoded = encodeURIComponent(String(value)).replace(/%2C/gi, ',');
      parts.push(encodeURIComponent(key) + '=' + encoded);
    }
    return parts.join('&');
  }

  function buildUrl(path, query) {
    var suffix = buildQuery(query);
    if (!suffix) return BASE + path;
    return BASE + path + (path.indexOf('?') >= 0 ? '&' : '?') + suffix;
  }

  function normalizeBody(body, headers) {
    if (body === undefined || body === null) return undefined;
    if (typeof body === 'string') return body;
    var contentType = headers['content-type'] || headers['Content-Type'] || '';
    if (contentType.indexOf('application/x-www-form-urlencoded') >= 0) {
      var form = [];
      for (var key in body) {
        if (!Object.prototype.hasOwnProperty.call(body, key)) continue;
        var value = body[key];
        if (value === undefined || value === null) continue;
        form.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(value)));
      }
      return form.join('&');
    }
    return JSON.stringify(body);
  }

  function missingHeaders(headers) {
    var lower = lowerKeys(headers);
    var missing = [];
    for (var i = 0; i < REQUIRED_HEADERS.length; i++) {
      if (!lower[REQUIRED_HEADERS[i]]) missing.push(REQUIRED_HEADERS[i]);
    }
    return missing;
  }

  function buildMeta(transport, method, url, requestHeaders, responseHeaders, status, source, error) {
    var normalizedRequestHeaders = lowerKeys(requestHeaders);
    var normalizedResponseHeaders = lowerKeys(responseHeaders);
    var meta = {
      transport: transport,
      method: method,
      url: url,
      status: status || 0,
      source: source || '',
      requestHeaders: normalizedRequestHeaders,
      responseHeaders: normalizedResponseHeaders,
      missingHeaders: missingHeaders(normalizedRequestHeaders),
      completeSignature: missingHeaders(normalizedRequestHeaders).length === 0
    };
    if (error) meta.error = error;
    return meta;
  }

  function attachMeta(body, meta) {
    var output;
    if (body && typeof body === 'object') {
      output = body;
    } else if (body === undefined || body === null) {
      output = {};
    } else {
      output = { value: body };
    }
    try {
      Object.defineProperty(output, '__xhs_meta', {
        value: meta,
        enumerable: true,
        configurable: true
      });
    } catch (e) {
      output.__xhs_meta = meta;
    }
    return output;
  }

  function captureAxios(candidate, source) {
    if (!candidate || candidate === capturedAxios) return candidate;
    if (typeof candidate.request !== 'function') return null;
    if (!candidate.interceptors || !candidate.interceptors.request || !candidate.interceptors.response) return null;
    capturedAxios = candidate;
    capturedAxiosSource = source || 'unknown';
    state.capture.axios = true;
    state.capture.axiosSource = capturedAxiosSource;
    hookAxiosInstance(candidate);
    return candidate;
  }

  function looksLikeAxios(candidate) {
    return !!(candidate && typeof candidate.request === 'function' && candidate.interceptors && candidate.interceptors.request && candidate.interceptors.response);
  }

  function hasSigningInterceptor(axiosInstance) {
    try {
      var reqInterceptors = axiosInstance.interceptors.request;
      if (!reqInterceptors || !reqInterceptors.handlers) return false;
      var handlers = reqInterceptors.handlers;
      for (var i = 0; i < handlers.length; i++) {
        var h = handlers[i];
        if (!h || typeof h.fulfilled !== 'function') continue;
        var src = '';
        try { src = h.fulfilled.toString(); } catch (e) {}
        if (src.indexOf('x-s') >= 0 || src.indexOf('x-s-common') >= 0 || src.indexOf('X-S') >= 0) return true;
      }
    } catch (e) {}
    return false;
  }

  function verifyAxiosByTest(axiosInstance) {
    try {
      var testConfig = { url: BASE + '/api/sns/web/v2/user/me', method: 'GET', headers: { 'accept': 'application/json' } };
      var chain = axiosInstance.interceptors.request.handlers;
      var config = testConfig;
      for (var i = 0; i < chain.length; i++) {
        if (chain[i] && typeof chain[i].fulfilled === 'function') {
          try { config = chain[i].fulfilled(config) || config; } catch (e) {}
        }
      }
      var h = config.headers || {};
      var lower = {};
      for (var k in h) { if (h.hasOwnProperty(k)) lower[String(k).toLowerCase()] = h[k]; }
      if (lower['x-s'] || lower['x-s-common']) return true;
    } catch (e) {}
    return false;
  }

  function getWebpackRequire() {
    if (webpackRequire) return webpackRequire;
    var chunkKey = 'webpackChunkxhs_pc_web';
    var chunk = window[chunkKey];
    if (!chunk || typeof chunk.push !== 'function') return null;
    try {
      chunk.push([[String(Date.now()) + '_xhs_probe'], {}, function (require) {
        webpackRequire = require;
      }]);
    } catch (e) {}
    if (webpackRequire) state.capture.webpack = true;
    return webpackRequire;
  }

  function scanWebpackForAxios(require) {
    if (!require || !require.c) return null;
    var cache = require.c;
    var verified = null;
    var fallback = null;
    for (var id in cache) {
      if (!Object.prototype.hasOwnProperty.call(cache, id)) continue;
      var module = cache[id];
      if (!module || !module.exports) continue;
      var exp = module.exports;
      var candidates = [exp, exp && exp.default, exp && exp.Z, exp && exp.A, exp && exp.N];
      for (var i = 0; i < candidates.length; i++) {
        var candidate = candidates[i];
        if (!looksLikeAxios(candidate)) continue;
        if (hasSigningInterceptor(candidate)) {
          verified = candidate;
          break;
        }
        if (!fallback) fallback = candidate;
      }
      if (verified) break;
      if (exp && typeof exp === 'object') {
        for (var key in exp) {
          if (!Object.prototype.hasOwnProperty.call(exp, key)) continue;
          if (!looksLikeAxios(exp[key])) continue;
          if (hasSigningInterceptor(exp[key])) {
            verified = exp[key];
            break;
          }
          if (!fallback) fallback = exp[key];
        }
      }
      if (verified) break;
    }
    return verified || fallback;
  }

  function findAxios() {
    if (capturedAxios && verifiedAxios) return capturedAxios;
    if (looksLikeAxios(window.axios)) return captureAxios(window.axios, 'window.axios');
    if (looksLikeAxios(window.hy)) return captureAxios(window.hy, 'window.hy');

    var require = getWebpackRequire();
    if (require) {
      var axios = scanWebpackForAxios(require);
      if (axios) {
        var result = captureAxios(axios, 'webpack');
        if (!verifiedAxios) {
          var hasSigning = hasSigningInterceptor(axios);
          var verifyResult = verifyAxiosByTest(axios);
          if (hasSigning || verifyResult) {
            verifiedAxios = true;
            state.capture.verified = true;
          }
        }
        getSignFn();
        return result;
      }
    }
    return null;
  }

  function installWebpackHook() {
    var chunkKey = 'webpackChunkxhs_pc_web';
    var chunk = window[chunkKey];
    if (!chunk || typeof chunk.push !== 'function' || chunk.__xhsHooked) return;
    var originalPush = chunk.push.bind(chunk);
    chunk.push = function () {
      var args = Array.prototype.slice.call(arguments);
      var payload = args[0];
      if (payload && typeof payload[2] === 'function') {
        var runtime = payload[2];
        payload[2] = function (require) {
          webpackRequire = require;
          state.capture.webpack = true;
          try {
            var axios = scanWebpackForAxios(require);
            if (axios) {
              captureAxios(axios, 'webpack-runtime');
              if (!verifiedAxios && hasSigningInterceptor(axios)) {
                verifiedAxios = true;
                state.capture.verified = true;
              }
            }
            getSignFn();
          } catch (e) {}
          return runtime(require);
        };
      }
      var result = originalPush.apply(chunk, args);
      try {
        var require = getWebpackRequire();
        var axios = scanWebpackForAxios(require);
        if (axios) {
          captureAxios(axios, 'webpack-push');
          if (!verifiedAxios && hasSigningInterceptor(axios)) {
            verifiedAxios = true;
            state.capture.verified = true;
          }
        }
        getSignFn();
      } catch (e) {}
      return result;
    };
    chunk.__xhsHooked = true;
    state.capture.webpack = true;
  }

  function installFetchHook() {
    // 不再覆盖 window.fetch — 让 RAP hook 保留，bridge 通过 getPatchedFetch() 使用 RAP-patched fetch
    state.capture.fetch = true;
  }

  function installXhrHook() {
    if (!NativeXHR || !NativeXHR.prototype) return;
    var proto = NativeXHR.prototype;

    // 获取原始方法（可能是页面已 hook 的版本，保留 RAP 逻辑）
    var originalOpen = proto.open;
    var originalSend = proto.send;
    var originalSetRequestHeader = proto.setRequestHeader;

    proto.open = function (method, url, async, user, password) {
      this.__xhsMeta = {
        method: String(method || 'GET').toUpperCase(),
        url: url,
        headers: {}
      };
      return originalOpen.apply(this, arguments);
    };

    proto.setRequestHeader = function (name, value) {
      if (this.__xhsMeta) {
        var lname = String(name).toLowerCase();
        this.__xhsMeta.headers[lname] = String(value);
        if (lname === 'x-s' && this.__xhsMeta.url && this.__xhsMeta.url.indexOf(TARGET_HOST) >= 0) {
          state.lastSignedRequest = {
            method: this.__xhsMeta.method,
            url: this.__xhsMeta.url,
            headers: Object.assign({}, this.__xhsMeta.headers),
            time: Date.now()
          };
        }
        if (lname === 'x-s-common' && this.__xhsMeta.url && this.__xhsMeta.url.indexOf(TARGET_HOST) >= 0) {
          state.lastXsCommon = String(value);
        }
        if (lname === 'x-rap-param' && this.__xhsMeta.url && this.__xhsMeta.url.indexOf(TARGET_HOST) >= 0) {
          state.lastRapParam = String(value);
        }
      }
      return originalSetRequestHeader.apply(this, arguments);
    };

    proto.send = function (body) {
      if (this.__xhsMeta && this.__xhsMeta.url && this.__xhsMeta.url.indexOf(TARGET_HOST) >= 0) {
        state.lastObserved = {
          transport: 'xhr',
          method: this.__xhsMeta.method,
          url: this.__xhsMeta.url,
          hasSignedHeaders: !!(this.__xhsMeta.headers['x-s'] || this.__xhsMeta.headers['x-s-common'])
        };
      }
      return originalSend.apply(this, arguments);
    };

    proto.__xhsHooked = true;
    state.capture.xhr = true;
  }

  function getKModule() {
    try {
      var require = getWebpackRequire();
      if (!require || !require.c) return null;
      var mod = require.c['26594'];
      if (mod && mod.exports) return mod.exports;
    } catch (e) {}
    return null;
  }

  function seccoreSign(url, body) {
    var K = getKModule();
    if (!K || typeof K.xE !== 'function' || typeof K.lz !== 'function' || typeof K.Pu !== 'function') return null;
    if (typeof window.mnsv2 !== 'function') return null;
    try {
      var s = Object.prototype.toString;
      var u = url;
      if (body !== null && body !== undefined) {
        if (s.call(body) === '[object Object]' || s.call(body) === '[object Array]') {
          // don't append
        } else if (typeof body === 'object') {
          u += JSON.stringify(body);
        } else if (typeof body === 'string') {
          u += body;
        }
      }
      var m = K.Pu(u);
      var w = K.Pu(url);
      var C = window.mnsv2(u, m, w);
      var P = {
        x0: '4.3.5',
        x1: 'xhs-pc-web',
        x2: window.xsecplatform || 'PC',
        x3: C,
        x4: body ? typeof body : ''
      };
      return 'XYS_' + K.xE(K.lz(JSON.stringify(P)));
    } catch (e) { return null; }
  }

  function getSignFn() {
    // 总是优先检查 seccore_signv2（生成 XYS_ 签名）
    var K = getKModule();
    if (K && typeof window.mnsv2 === 'function') {
      if (!capturedSignFn || state.capture.signFnSource !== 'seccore_signv2') {
        capturedSignFn = function(cfg) {
          var url = (typeof cfg === 'string' ? cfg : (cfg && cfg.url) || '').replace('https://edith.xiaohongshu.com', '');
          var body = (cfg && cfg.data) || null;
          var xs = seccoreSign(url, body);
          if (!xs) return null;
          return { 'X-S': xs, 'x-s': xs, 'X-T': Date.now(), 'x-t': Date.now() };
        };
        state.capture.signFn = true;
        state.capture.signFnSource = 'seccore_signv2';
      }
      return capturedSignFn;
    }

    // 回退到 _webmsxyw（不缓存，等 seccore 可用时自动切换）
    if (typeof window._webmsxyw === 'function') {
      if (!capturedSignFn) {
        capturedSignFn = window._webmsxyw;
        state.capture.signFn = true;
        state.capture.signFnSource = '_webmsxyw';
      }
      return capturedSignFn;
    }
    return null;
  }

  function extractApiPath(url) {
    try {
      var idx = url.indexOf('/api/');
      if (idx >= 0) return url.substring(idx);
      var u = new URL(url);
      return u.pathname + u.search;
    } catch (e) {
      var m = url.match(/edith\.xiaohongshu\.com(\/.*)/);
      return m ? m[1] : url;
    }
  }

  function generateTraceId() {
    var hex = '0123456789abcdef';
    var id = '';
    for (var i = 0; i < 16; i++) {
      id += hex[Math.floor(Math.random() * 16)];
    }
    return id;
  }

  function generateXrayTraceId() {
    var hex = '0123456789abcdef';
    var id = '';
    for (var i = 0; i < 32; i++) {
      id += hex[Math.floor(Math.random() * 16)];
    }
    return id;
  }

  function xsCommonSign() {
    // x-s-common 是 session 级签名（M/U 永远为空），优先使用页面捕获的值
    // 如果页面已发出过请求，lastXsCommon 包含正确的 x-s-common
    if (state.lastXsCommon) {
      return state.lastXsCommon;
    }
    
    // 兜底：自己生成（可能不完全匹配服务器期望）
    var K = getKModule();
    if (!K || typeof K.xE !== 'function' || typeof K.lz !== 'function' || typeof K.tb !== 'function') return null;
    
    try {
      var b1 = localStorage.getItem('b1') || '';
      var ef = {
        s0: Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15),
        s1: '',
        x0: localStorage.getItem('b1b1') || '1',
        x1: '4.3.5',
        x2: window.xsecplatform || 'PC',
        x3: 'xhs-pc-web',
        x4: '6.14.1',
        x5: (function() {
          var m = document.cookie.match(/(?:^|;\\s*)a1=([^;]*)/);
          return m ? m[1] : '';
        })(),
        x6: '',
        x7: '',
        x8: b1,
        x9: K.tb(b1),
        x10: (function() {
          var v = Number(sessionStorage.getItem('sc')) || 0;
          v++;
          sessionStorage.setItem('sc', String(v));
          return v;
        })(),
        x11: 'normal',
        x12: (localStorage.getItem('dsllt') || '') + ';' + (window._dsl || '')
      };
      return K.xE(K.lz(JSON.stringify(ef)));
    } catch(e) {
      console.error('[xhs-bridge] xsCommonSign error:', e.message);
      return null;
    }
  }

  function generateSigningHeaders(method, url, body) {
    var signFn = getSignFn();
    if (!signFn) { console.error('[xhs-bridge] generateSigningHeaders: no signFn'); return null; }
    var apiPath = extractApiPath(url);
    var data = body || {};
    var attempts = [
      { api: apiPath, data: data, method: method },
      { api: apiPath, data: data },
      { url: url, data: data, method: method },
      { url: apiPath, data: data, method: method },
      apiPath, data, method
    ];
    for (var i = 0; i < attempts.length; i++) {
      try {
        var arg = attempts[i];
        var result = (i < 5) ? signFn(arg) : signFn(apiPath, data, method);
        if (result && typeof result === 'object') {
          var out = {};
          for (var k in result) {
            if (result.hasOwnProperty(k)) {
              out[k] = result[k];
              out[String(k).toLowerCase()] = result[k];
            }
          }
          // 生成 x-s-common
          var xsCommon = xsCommonSign();
          if (xsCommon) {
            out['x-s-common'] = xsCommon;
            out['X-S-Common'] = xsCommon;
          }
          // 补充缺失的 trace 头
          if (!out['x-b3-traceid'] && !out['X-B3-Traceid']) {
            out['x-b3-traceid'] = generateTraceId();
          }
          if (!out['x-xray-traceid'] && !out['X-Xray-Traceid']) {
            out['x-xray-traceid'] = generateXrayTraceId();
          }
          if (out['x-s'] || out['x-t'] || out['x-s-common'] || out['X-S'] || out['X-T']) {
            console.error('[xhs-bridge] sign OK attempt=' + i + ' keys=' + Object.keys(out).join(','));
            return out;
          }
          console.error('[xhs-bridge] sign attempt=' + i + ' no x-s in result, keys=' + Object.keys(result).join(','));
        }
      } catch (e) { console.error('[xhs-bridge] sign attempt=' + i + ' error: ' + e.message); }
    }
    console.error('[xhs-bridge] generateSigningHeaders: all attempts failed');
    return null;
  }

  function ensureSigningHeaders(headers, method, url, body) {
    var h = lowerKeys(headers);
    if (h['x-s'] && h['x-t']) return headers;
    console.error('[xhs-bridge] ensureSigningHeaders: x-s missing, calling generateSigningHeaders for ' + method + ' ' + url);
    var signed = generateSigningHeaders(method, url, body);
    if (signed) {
      var merged = {};
      for (var k in headers) { if (headers.hasOwnProperty(k)) merged[k] = headers[k]; }
      for (var k2 in signed) {
        if (signed.hasOwnProperty(k2)) {
          var lk = String(k2).toLowerCase();
          if (!merged[k2] && !merged[lk]) merged[k2] = signed[k2];
        }
      }
      // 补充 x-s-common（如果签名函数未返回，使用页面捕获的值）
      var m = lowerKeys(merged);
      if (!m['x-s-common'] && state.lastXsCommon) {
        merged['x-s-common'] = state.lastXsCommon;
      }
      // 补充 x-rap-param（如果页面已捕获）
      if (!m['x-rap-param'] && state.lastRapParam) {
        merged['x-rap-param'] = state.lastRapParam;
      }
      console.error('[xhs-bridge] ensureSigningHeaders: merged keys=' + Object.keys(merged).join(','));
      return merged;
    }
    console.error('[xhs-bridge] ensureSigningHeaders: generateSigningHeaders returned null');
    return headers;
  }

  function requestWithAxios(cfg) {
    var axios = findAxios();
    if (!axios) throw new Error('axios not captured');

    var headers = {};
    var srcHeaders = cfg.headers || {};
    for (var k in srcHeaders) { if (srcHeaders.hasOwnProperty(k)) headers[k] = srcHeaders[k]; }

    if (!lowerKeys(headers)['x-s']) {
      var signed = ensureSigningHeaders(headers, cfg.method || 'GET', cfg.url, cfg.body);
      if (signed !== headers) {
        headers = signed;
      }
    }

    var requestConfig = {
      url: cfg.url,
      method: cfg.method || 'GET',
      withCredentials: true,
      headers: headers
    };
    if (cfg.body !== undefined) {
      requestConfig.data = cfg.body;
    }
    if (cfg.params) {
      requestConfig.params = cfg.params;
    }

    return axios.request(requestConfig).then(function (response) {
      var responseHeaders = response && response.headers ? response.headers : {};
      var responseBody = coerceResponseBody(parseJSON(response && response.data), response && response.status ? response.status : 200, response && response.statusText ? response.statusText : '');
      var meta = buildMeta(
        'axios',
        requestConfig.method,
        cfg.url,
        response && response.config && response.config.headers ? response.config.headers : lowerKeys(headers),
        responseHeaders,
        response && response.status ? response.status : 200,
        capturedAxiosSource || 'axios',
        ''
      );
      pushHistory(meta);
      return attachMeta(responseBody, meta);
    }).catch(function (error) {
      if (error && error.response) {
        var response = error.response;
        var responseHeaders = response.headers || {};
        var responseBody = coerceResponseBody(parseJSON(response.data), response.status || 0, response.statusText || '');
        var meta = buildMeta(
          'axios',
          requestConfig.method,
          cfg.url,
          error.config && error.config.headers ? error.config.headers : lowerKeys(headers),
          responseHeaders,
          response.status || 0,
          capturedAxiosSource || 'axios',
          ''
        );
        pushHistory(meta);
        return attachMeta(responseBody, meta);
      }

      var meta = buildMeta(
        'axios',
        requestConfig.method,
        cfg.url,
        error && error.config && error.config.headers ? error.config.headers : lowerKeys(headers),
        {},
        0,
        capturedAxiosSource || 'axios',
        error ? error.message : 'axios request failed'
      );
      pushHistory(meta);
      throw new Error(meta.error || 'axios request failed');
    });
  }

  function getPatchedFetch() {
    // 优先使用 RAP-patched fetch（能生成 x-s-common），回退 nativeFetch
    if (typeof window.fetch === 'function') {
      var f = window.fetch;
      var isRap = false;
      try { isRap = f.toString().indexOf('_sabo') >= 0; } catch(e) {}
      if (isRap) return f;
    }
    return nativeFetch;
  }

  function requestWithFetch(cfg) {
    var activeFetch = getPatchedFetch();
    if (!activeFetch) throw new Error('fetch unavailable');

    // 检测当前 fetch 是否被 RAP 签名过
    var isRapFetch = activeFetch !== nativeFetch;
    
    var requestConfig = {
      method: cfg.method || 'GET',
      credentials: 'include'
    };
    
    if (isRapFetch) {
      // 用 RAP-patched fetch（会生成 x-rap-param）+ 我们自己补齐签名头
      var headers = cfg.headers || {};
      if (!lowerKeys(headers)['x-s']) {
        headers = ensureSigningHeaders(headers, cfg.method || 'GET', cfg.url, cfg.body);
      }
      var requestHeaders = lowerKeys(headers);
      console.error('[xhs-bridge] requestWithFetch RAP+sign: headers=' + Object.keys(headers).join(',') + ' hasXS=' + !!requestHeaders['x-s'] + ' hasCommon=' + !!requestHeaders['x-s-common']);
      requestConfig.headers = headers;
      if (cfg.body !== undefined) {
        requestConfig.body = typeof cfg.body === 'string' ? cfg.body : JSON.stringify(cfg.body);
      }
    } else {
      // 原生 fetch：需要自己加签名头
      var _headers = cfg.headers || {};
      var requestHeaders = lowerKeys(_headers);
      if (!requestHeaders['x-s']) {
        _headers = ensureSigningHeaders(_headers, cfg.method || 'GET', cfg.url, cfg.body);
        requestHeaders = lowerKeys(_headers);
      }
      requestConfig.headers = _headers;
      if (cfg.body !== undefined) {
        requestConfig.body = normalizeBody(cfg.body, requestHeaders);
      }
    }

    return activeFetch(cfg.url, requestConfig).then(function (response) {
      return response.text().then(function (text) {
        var responseBody = parseJSON(text);
        if (responseBody === text && text) {
          responseBody = {
            code: response.status,
            msg: response.statusText || 'HTTP ' + response.status,
            raw: text
          };
        }
        var responseHeaders = {};
        if (response.headers && typeof response.headers.forEach === 'function') {
          response.headers.forEach(function (value, key) {
            responseHeaders[String(key).toLowerCase()] = String(value);
          });
        }
        var meta = buildMeta('fetch', requestConfig.method, cfg.url, requestHeaders, responseHeaders, response.status || 0, 'fetch', '');
        pushHistory(meta);
        return attachMeta(responseBody, meta);
      });
    }).catch(function (error) {
      var meta = buildMeta('fetch', requestConfig.method, cfg.url, requestHeaders, {}, 0, 'fetch', error ? error.message : 'fetch failed');
      pushHistory(meta);
      throw new Error(meta.error || 'fetch failed');
    });
  }

  function requestWithXhr(cfg) {
    var XHRClass = window.XMLHttpRequest || NativeXHR;
    if (!XHRClass) throw new Error('XMLHttpRequest unavailable');

    var headers = cfg.headers || {};
    if (!lowerKeys(headers)['x-s']) {
      headers = ensureSigningHeaders(headers, cfg.method || 'GET', cfg.url, cfg.body);
    }
    var requestHeaders = lowerKeys(headers);
    var body = normalizeBody(cfg.body, requestHeaders);

    return new Promise(function(resolve, reject) {
      var xhr = new XHRClass();
      xhr.open(cfg.method || 'GET', cfg.url, true);
      xhr.withCredentials = true;
      for (var key in requestHeaders) {
        if (!Object.prototype.hasOwnProperty.call(requestHeaders, key)) continue;
        try { xhr.setRequestHeader(key, requestHeaders[key]); } catch (e) {}
      }
      xhr.onload = function() {
        var responseHeaders = {};
        try {
          var rawHeaders = xhr.getAllResponseHeaders ? xhr.getAllResponseHeaders() : '';
          if (rawHeaders) {
            var lines = rawHeaders.trim().split(/[\r\n]+/);
            for (var i = 0; i < lines.length; i++) {
              var line = lines[i];
              var index = line.indexOf(':');
              if (index > 0) {
                responseHeaders[String(line.slice(0, index)).toLowerCase()] = String(line.slice(index + 1).trim());
              }
            }
          }
        } catch (e) {}
        var responseText = xhr.responseText || '';
        var responseBody = parseJSON(responseText);
        if (responseBody === responseText && responseText) {
          responseBody = { code: xhr.status || 0, msg: xhr.statusText || '', raw: responseText };
        }
        var meta = buildMeta('xhr', cfg.method || 'GET', cfg.url, requestHeaders, responseHeaders, xhr.status || 0, 'xhr', '');
        pushHistory(meta);
        resolve(attachMeta(responseBody, meta));
      };
      xhr.onerror = function() {
        var meta = buildMeta('xhr', cfg.method || 'GET', cfg.url, requestHeaders, {}, 0, 'xhr', 'xhr error');
        pushHistory(meta);
        reject(new Error('xhr error'));
      };
      xhr.ontimeout = function() {
        var meta = buildMeta('xhr', cfg.method || 'GET', cfg.url, requestHeaders, {}, 0, 'xhr', 'timeout');
        pushHistory(meta);
        reject(new Error('xhr timeout'));
      };
      xhr.send(body);
    });
  }

  function pickTransport(hint) {
    var preferred = String(hint || state.transport || 'auto').toLowerCase();
    var order = [];
    if (preferred === 'axios') order = ['axios', 'fetch', 'xhr'];
    else if (preferred === 'fetch') order = ['fetch', 'axios', 'xhr'];
    else if (preferred === 'xhr') order = ['xhr', 'axios', 'fetch'];
    else order = ['xhr', 'axios', 'fetch'];  // XHR 优先（RAP 的 _sabo 生成 x-rap-param）
    return order;
  }

  async function request(cfg) {
    cfg = cfg || {};
    var transports = pickTransport(cfg.transport);
    var lastError = null;
    for (var i = 0; i < transports.length; i++) {
      var transport = transports[i];
      try {
        if (transport === 'axios' && findAxios()) {
          console.error('[xhs-bridge] transport: axios');
          return await requestWithAxios(cfg);
        }
        if (transport === 'fetch' && (getPatchedFetch() || nativeFetch)) {
          console.error('[xhs-bridge] transport: fetch');
          return await requestWithFetch(cfg);
        }
        if (transport === 'xhr' && NativeXHR) {
          console.error('[xhs-bridge] transport: xhr');
          return await requestWithXhr(cfg);
        }
      } catch (error) {
        console.error('[xhs-bridge] transport ' + transport + ' error: ' + error.message);
        lastError = error;
      }
    }
    var meta = {
      transport: 'none',
      method: cfg.method || 'GET',
      url: cfg.url || '',
      status: 0,
      source: 'bridge',
      requestHeaders: lowerKeys(cfg.headers),
      responseHeaders: {},
      missingHeaders: missingHeaders(cfg.headers),
      completeSignature: missingHeaders(cfg.headers).length === 0,
      error: lastError ? lastError.message : 'no transport available'
    };
    pushHistory(meta);
    throw new Error(meta.error);
  }

  function apiRequest(method, path, options) {
    options = options || {};
    return request({
      method: method,
      url: buildUrl(path, options.query),
      headers: options.headers,
      body: options.body,
      transport: options.transport
    });
  }

  function sid() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = Math.random() * 16 | 0;
      var v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

  function queryHeaders(method) {
    var h = {
      'accept': 'application/json, text/plain, */*'
    };
    if (method && method.toUpperCase() !== 'GET') {
      h['content-type'] = 'application/json;charset=UTF-8';
    }
    return h;
  }

  function commentQuery(noteId, cursor, rootCommentId) {
    return {
      note_id: noteId,
      cursor: cursor || '',
      root_comment_id: rootCommentId || '',
      top_comment_id: '',
      image_formats: 'jpg,webp,avif'
    };
  }

  function normalizePayload(value) {
    if (value && typeof value === 'object' && value.__xhs_meta) return value;
    return value;
  }

  window.__xhs = {
    __installed: true,
    BASE: BASE,
    state: state,

    inspect: function () {
      return JSON.parse(JSON.stringify(state));
    },

    _signRequest: function (method, url, body) {
      return generateSigningHeaders(method, url, body);
    },

    setTransport: function (name) {
      state.transport = String(name || 'auto');
      return state.transport;
    },

    refreshCapture: function () {
      installWebpackHook();
      installFetchHook();
      installXhrHook();
      findAxios();
      return this.inspect();
    },

    request: async function (method, path, options) {
      return await apiRequest(method, path, options);
    },

    getMe: async function () {
      return await apiRequest('GET', '/api/sns/web/v2/user/me', {
        headers: queryHeaders('GET'),
        transport: 'auto'
      });
    },

    search: async function (kw, page, pageSize) {
      return await apiRequest('POST', '/api/sns/web/v1/search/notes', {
        headers: queryHeaders('POST'),
        body: {
          keyword: kw,
          page: page || 1,
          page_size: pageSize || 20,
          search_id: sid(),
          sort: 'general',
          note_type: 0
        },
        transport: 'auto'
      });
    },

    getNote: async function (noteId) {
      return await apiRequest('POST', '/api/sns/web/v1/feed', {
        headers: queryHeaders('POST'),
        body: {
          source_note_id: noteId,
          image_formats: 'jpg,webp,avif',
          extra: '{"need_body_topic":1}'
        },
        transport: 'auto'
      });
    },

    getComments: async function (noteId, cursor, count) {
      return await apiRequest('GET', '/api/sns/web/v2/comment/page', {
        headers: queryHeaders('GET'),
        query: {
          note_id: noteId,
          cursor: cursor || '',
          count: count || 20,
          top_comment_id: '',
          image_formats: 'jpg,webp,avif'
        },
        transport: 'auto'
      });
    },

    getSubComments: async function (noteId, rootCommentId, cursor, count) {
      return await apiRequest('GET', '/api/sns/web/v2/comment/sub/page', {
        headers: queryHeaders('GET'),
        query: {
          note_id: noteId,
          root_comment_id: rootCommentId,
          cursor: cursor || '',
          count: count || 20,
          image_formats: 'jpg,webp,avif'
        },
        transport: 'auto'
      });
    },

    publish: async function (noteId, content, replyTo, atUsers) {
      var body = {
        note_id: noteId,
        content: content,
        at_users: atUsers || []
      };
      if (replyTo) body.comment_id = replyTo;
      return await apiRequest('POST', '/api/sns/web/v1/comment/post', {
        headers: queryHeaders('POST'),
        body: body,
        transport: 'auto'
      });
    },

    deleteComment: async function (noteId, commentId) {
      return await apiRequest('POST', '/api/sns/web/v1/comment/delete', {
        headers: queryHeaders('POST'),
        body: {
          note_id: noteId,
          comment_id: commentId
        },
        transport: 'auto'
      });
    },

    likeComment: async function (noteId, commentId) {
      return await apiRequest('POST', '/api/sns/web/v1/comment/like', {
        headers: queryHeaders('POST'),
        body: {
          note_id: noteId,
          comment_id: commentId
        },
        transport: 'auto'
      });
    },

    myNotes: async function (cursor, count) {
      var me = await this.getMe();
      var userId = (me.data || {}).user_id || '';
      if (!userId) return { code: -1, msg: 'Not logged in' };
      return await apiRequest('GET', '/api/sns/web/v1/user_posted', {
        headers: queryHeaders('GET'),
        query: {
          num: count || 30,
          cursor: cursor || '',
          user_id: userId,
          image_formats: 'jpg,webp,avif',
          xsec_token: '',
          xsec_source: ''
        },
        transport: 'auto'
      });
    },

    userNotes: async function (userId, cursor, count) {
      return await apiRequest('GET', '/api/sns/web/v1/user_posted', {
        headers: queryHeaders('GET'),
        query: {
          num: count || 30,
          cursor: cursor || '',
          user_id: userId,
          image_formats: 'jpg,webp,avif',
          xsec_token: '',
          xsec_source: ''
        },
        transport: 'auto'
      });
    },

    userInfo: async function (userId) {
      return await apiRequest('GET', '/api/sns/web/v1/user/otherinfo', {
        headers: queryHeaders('GET'),
        query: {
          target_user_id: userId
        },
        transport: 'auto'
      });
    }
  };

  function hookAxiosInstance(axiosInstance) {
    if (!axiosInstance || axiosInstance.__xhsHooked) return;
    try {
      var origRequest = axiosInstance.request.bind(axiosInstance);
      axiosInstance.request = function (config) {
        if (config && config.headers) {
          var h = lowerKeys(config.headers);
          var url = config.url || '';
          if (url.indexOf(TARGET_HOST) >= 0 && !h['x-s']) {
            try {
              var signFn = getSignFn();
              if (signFn) {
                var signed = generateSigningHeaders(config.method || 'GET', url, config.data);
                if (signed) {
                  for (var k in signed) {
                    if (signed.hasOwnProperty(k)) config.headers[k] = signed[k];
                  }
                } else {
                  console.error('[xhs-bridge] hookAxios: generateSigningHeaders returned null');
                }
              } else {
                console.error('[xhs-bridge] hookAxios: getSignFn returned null');
              }
            } catch (e) {
              console.error('[xhs-bridge] hookAxios sign error: ' + e.message);
            }
          }
        }
        return origRequest(config);
      };
      axiosInstance.__xhsHooked = true;
      state.capture.prototypeHooked = true;
    } catch (e) {
      console.error('[xhs-bridge] hookAxiosInstance error: ' + e.message);
    }
  }

  // 初始尝试
  installWebpackHook();
  installFetchHook();
  installXhrHook();
  findAxios();

  // webpack 可能尚未加载，重试直到成功
  var _retryCount = 0;
  var _retryTimer = setInterval(function () {
    _retryCount++;
    if (state.capture.webpack && state.capture.axios && state.capture.signFn) {
      clearInterval(_retryTimer);
      console.error('[xhs-bridge] All captures complete after ' + _retryCount + ' retries');
      return;
    }
    if (_retryCount > 50) { clearInterval(_retryTimer); return; }
    installWebpackHook();
    findAxios();
    if (!state.capture.signFn) getSignFn();
  }, 200);

  console.log('[CLI] XHS Bridge ready (' + state.transport + ')');
})();`;
}

module.exports = { buildXhsBridgeSource };
