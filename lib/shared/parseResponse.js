// lib/shared/parseResponse.js — API 响应解析的纯函数
//
// 调用顺序：
//   1. fetch → 拿到 Response（含 status / content-type）
//   2. await r.text() → 拿到响应体字符串
//   3. parseResponseText(label, status, contentType, text) → 返回 {ok, value, error}
//
// 测试时直接构造 (status, ct, text) 三元组验证错误生成正确。

/**
 * 解析 API 响应字符串。
 *
 * @param {string} label - 调用点标识（如 'search' / 'publish' / 'getComments'）
 * @param {number} status - HTTP 状态码
 * @param {string} contentType - response 的 content-type header（可空字符串）
 * @param {string} text - response 文本
 * @returns {{ok: true, value: any} | {ok: false, error: string, retryable: boolean}}
 *   retryable=true 表示该错误对幂等读操作可重试一次（空响应、HTML 风控页等）。
 */
function parseResponseText(label, status, contentType, text) {
  const ct = contentType || '';
  // 非 2xx
  if (status < 200 || status >= 300) {
    const snippet = snip(text);
    return {
      ok: false,
      retryable: false,
      error: `[${label}] HTTP ${status} (${ct}): ${snippet}`,
    };
  }
  // 空响应
  if (!text || !text.trim()) {
    return {
      ok: false,
      retryable: true,
      error: `[${label}] 服务器返回空响应 (HTTP 200, content-type: ${ct}) — 可能被限流或登录态失效`,
    };
  }
  // JSON 解析
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (_) {
    const snippet = snip(text);
    const isHtml = /^\s*</.test(text) || /text\/html/i.test(ct);
    const hint = isHtml
      ? '返回了 HTML 页面（可能登录态失效/被风控/账号校验中），请刷新页面并重新登录'
      : '响应不是合法 JSON';
    return {
      ok: false,
      retryable: true,
      error: `[${label}] ${hint} (content-type: ${ct}): ${snippet}`,
    };
  }
}

function snip(text) {
  if (typeof text !== 'string') return String(text);
  return text.length > 200 ? text.substring(0, 200) + '...' : text;
}

module.exports = { parseResponseText };
