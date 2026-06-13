// lib/token-cache.js — note_id → { xsec_token, xsec_source } 缓存
// search/my/userNotes 命中时写入，note/get/replies 调用时读取
// 落盘到 logs/xsec-tokens.json，跨进程持久
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'logs', 'xsec-tokens.json');

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

function set(noteId, token, source) {
  if (!noteId || !token) return;
  const m = _mem();
  m[noteId] = { xsec_token: token, xsec_source: source || 'pc_search', t: Math.floor(Date.now() / 1000) };
  save(m);
}

function get(noteId) {
  if (!noteId) return null;
  const m = _mem();
  return m[noteId] || null;
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

module.exports = { set, get, ingest };
