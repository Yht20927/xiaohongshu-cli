// lib/token-cache.js — note_id → { xsec_token, xsec_source } 缓存
// search/my/userNotes 命中时写入，note/get/replies 调用时读取。
// 落盘到 logs/xsec-tokens.json 跨进程持久；带 TTL（默认 6 小时），过期自动清理。
const fs = require('fs');
const path = require('path');

const LOG_DIR = process.env.XHS_LOG_DIR
  ? path.resolve(process.env.XHS_LOG_DIR)
  : path.join(__dirname, '..', 'logs');
const FILE = path.join(LOG_DIR, 'xsec-tokens.json');

// 默认 TTL：6 小时（小红书 xsec_token 实测可用数小时；保守取 6h）
const DEFAULT_TTL_S = 6 * 3600;
const TTL_S = Number(process.env.XHS_TOKEN_TTL_S) > 0 ? Number(process.env.XHS_TOKEN_TTL_S) : DEFAULT_TTL_S;

function load() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { return {}; }
}
function save(map) {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(map, null, 2));
  } catch (e) { /* ignore */ }
}

let mem = null;
function _mem() { if (!mem) mem = load(); return mem; }

function _expired(entry) {
  if (!entry || !entry.t) return true;
  return (Math.floor(Date.now() / 1000) - Number(entry.t)) > TTL_S;
}

function set(noteId, token, source) {
  if (!noteId || !token) return;
  const m = _mem();
  m[noteId] = { xsec_token: token, xsec_source: source || 'pc_search', t: Math.floor(Date.now() / 1000) };
  save(m);
}

function get(noteId) {
  if (!noteId) return null;
  const m = _mem();
  const e = m[noteId];
  if (!e) return null;
  if (_expired(e)) {
    delete m[noteId];
    save(m);
    return null;
  }
  return e;
}

// 主动清理过期条目，返回清掉的条数
function purge() {
  const m = _mem();
  let n = 0;
  for (const k of Object.keys(m)) {
    if (_expired(m[k])) { delete m[k]; n++; }
  }
  if (n > 0) save(m);
  return n;
}

// 批量记入：从 items 数组里抽 xsec_token 字段
function ingest(items, source) {
  if (!Array.isArray(items)) return 0;
  let n = 0;
  for (const it of items) {
    const nid = it.id || it.note_id || (it.note_card || {}).note_id;
    const tok = it.xsec_token || (it.note_card || {}).xsec_token;
    if (nid && tok) { set(nid, tok, source); n++; }
  }
  return n;
}

// 测试用：清空整个缓存
function _resetForTests() {
  mem = {};
  try { fs.unlinkSync(FILE); } catch (e) {}
}

module.exports = { set, get, ingest, purge, _resetForTests };
