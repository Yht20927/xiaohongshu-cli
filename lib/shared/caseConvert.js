// lib/shared/caseConvert.js — 递归把对象 key 从 camelCase 转回 snake_case
// 用途：xhs 页面 axios 响应拦截器会把 API 字段全部驼峰化（noteCard / xsecToken / likedCount...）
// CLI 解析按 raw HTTP 的 snake_case 写，所以收到后统一转回来，所有 commands/* 不用动。
//
// 规则：
//  - 普通对象、数组深度遍历
//  - 单字符 key（'a'/'b'）、纯小写 key（已经是 snake/无需转）原样
//  - 仅转 keys；不动 value（即使 value 是 "AB1cDef..."，那是 token）
//  - 同名冲突时（驼峰版和下划线版同时存在），下划线版优先保留

function camelToSnake(s) {
  if (typeof s !== 'string' || s.length < 2) return s;
  // 已经包含下划线则原样
  if (s.indexOf('_') !== -1) return s;
  // 全小写或全大写也原样
  if (s === s.toLowerCase() || s === s.toUpperCase()) return s;
  return s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

function convertKeys(value, seen) {
  if (value === null || typeof value !== 'object') return value;
  if (!seen) seen = new WeakSet();
  if (seen.has(value)) return value;
  seen.add(value);

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) value[i] = convertKeys(value[i], seen);
    return value;
  }

  // 普通对象：原地改键
  const keys = Object.keys(value);
  for (const k of keys) {
    const sk = camelToSnake(k);
    const v = convertKeys(value[k], seen);
    if (sk !== k) {
      // 已有同名 snake key，优先保留 snake（不覆盖），并删掉 camel
      if (!(sk in value)) value[sk] = v;
      delete value[k];
    } else {
      value[k] = v;
    }
  }
  return value;
}

module.exports = { convertKeys, camelToSnake };
