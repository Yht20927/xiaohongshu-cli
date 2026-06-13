// lib/audit.js — 审计日志模块（从 cli.js 提取）
const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, '..', 'logs');
const AUDIT_FILE = path.join(LOG_DIR, 'audit.json');
const RESULTS_DIR = path.join(LOG_DIR, 'results');

let _cache = null;

class AuditLogger {
  constructor() {
    this._audit = null;
    this._currentOp = null;
    this._noLog = false;
  }

  setNoLog(v) { this._noLog = v; }

  ensureDirs() {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR, { recursive: true });
  }

  load() {
    if (_cache !== null) return _cache;
    if (!fs.existsSync(AUDIT_FILE)) {
      _cache = { version: '2.0', updated: new Date().toISOString(), sessions: [] };
      return _cache;
    }
    try {
      _cache = JSON.parse(fs.readFileSync(AUDIT_FILE, 'utf8'));
      return _cache;
    } catch (e) {
      _cache = { version: '2.0', updated: new Date().toISOString(), sessions: [] };
      return _cache;
    }
  }

  save() {
    if (this._noLog) return;
    this._audit.updated = new Date().toISOString();
    _cache = this._audit;
    try {
      const tmp = AUDIT_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this._audit, null, 2));
      fs.renameSync(tmp, AUDIT_FILE);
    } catch (e) {
      // 清理可能的 .tmp 文件
      try { fs.unlinkSync(AUDIT_FILE + '.tmp'); } catch (_) {}
    }
  }

  newSession() {
    const last = this._audit.sessions[this._audit.sessions.length - 1];
    if (last && !last.ended) return last;
    const s = {
      sessionId: Date.now().toString(36) + '-' + Math.random().toString(36).substring(2, 6),
      started: new Date().toISOString(),
      ended: null,
      operations: [],
    };
    this._audit.sessions.push(s);
    if (this._audit.sessions.length > 100) this._audit.sessions = this._audit.sessions.slice(-100);
    return s;
  }

  startOperation(cmd, args) {
    if (this._noLog) return;
    this.ensureDirs();
    this._audit = this.load();
    const s = this.newSession();
    this._currentOp = {
      index: s.operations.length + 1,
      command: cmd,
      args,
      started: new Date().toISOString(),
      ended: null,
      durationMs: null,
      status: 'running',
      summary: {},
      apiCalls: [],
    };
    s.operations.push(this._currentOp);
    this.save();
  }

  logApiCall(endpoint, params, durationMs, status, summary) {
    if (this._noLog || !this._currentOp) return;
    this._currentOp.apiCalls.push({
      seq: this._currentOp.apiCalls.length + 1,
      endpoint,
      params,
      durationMs,
      status,
      summary: summary || {},
    });
  }

  endOperation(status, summary, resultData, error) {
    if (this._noLog || !this._currentOp) return;
    this._currentOp.ended = new Date().toISOString();
    this._currentOp.durationMs = Date.now() - new Date(this._currentOp.started).getTime();
    this._currentOp.status = status;
    if (summary) this._currentOp.summary = summary;
    if (error) this._currentOp.error = error;

    const largeResults = ['get', 'search', 'my', 'replies'];
    if (resultData && largeResults.includes(this._currentOp.command) && status === 'success') {
      const ts = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
      let label = this._currentOp.command;
      if (this._currentOp.args.note_id) label += '-' + sanitize(this._currentOp.args.note_id);
      else if (this._currentOp.args.keyword) label += '-' + sanitize(this._currentOp.args.keyword);
      else if (this._currentOp.args.cid) label += '-' + sanitize(this._currentOp.args.cid);
      const fp = path.join(RESULTS_DIR, label + '-' + ts + '.json');
      fs.writeFileSync(fp, JSON.stringify({
        command: this._currentOp.command,
        args: this._currentOp.args,
        started: this._currentOp.started,
        ...resultData,
      }, null, 2));
      this._currentOp.resultFile = 'logs/results/' + path.basename(fp);
    } else if (resultData && status === 'success') {
      this._currentOp.result = resultData;
    }
    this.save();
    this._currentOp = null;
  }

  /**
   * 查找某笔记上次成功拉取的时间（Unix 秒），用于 --new 增量
   */
  findLastFetchTime(noteId) {
    const a = this.load();
    let latest = null;
    for (const s of (a.sessions || [])) {
      for (const op of (s.operations || [])) {
        if (op.command === 'get' && op.args && op.args.note_id === noteId && op.status === 'success' && op.ended) {
          const t = new Date(op.ended).getTime() / 1000;
          if (latest === null || t > latest) latest = t;
        }
      }
    }
    return latest;
  }
}

function sanitize(s) {
  return (s || '').replace(/[<>:"/\\|?*'\s]/g, '_').substring(0, 20);
}

module.exports = { AuditLogger };
