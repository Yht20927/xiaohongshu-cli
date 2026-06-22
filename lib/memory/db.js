// lib/memory/db.js — SQLite 单例（小红书版本）
//
// 设计原则：
// 1. 单例 + lazy 打开：首次调用 getDb() 时才打开数据库。
// 2. WAL 模式 + busy_timeout，支持多进程并发读写（CLI + 调度器同时跑）。
// 3. PRAGMA user_version 管理 schema 版本；每个 migration 幂等。
// 4. 自愈：删除 storage/xiaohongshu.db 后下次调用自动重建。
// 5. 失败不抛：上层用 try/catch 包住，SQLite 异常降级为 console.warn，不影响主流程。
//
// 跨平台 platform 列预留 'xhs'（小红书 / xiaohongshu），便于未来跨平台共享 corpus / failures。

const fs = require('fs');
const path = require('path');

const STORAGE_DIR = process.env.XHS_STORAGE_DIR
  ? path.resolve(process.env.XHS_STORAGE_DIR)
  : path.join(__dirname, '..', '..', 'storage');
const DB_FILE = path.join(STORAGE_DIR, 'xiaohongshu.db');

// 当前 schema 版本（每次新增 migration → 自增）
const SCHEMA_VERSION = 3;

let _db = null;
let _Database = null;

function ensureStorageDir() {
  if (!fs.existsSync(STORAGE_DIR)) fs.mkdirSync(STORAGE_DIR, { recursive: true });
}

function loadDriver() {
  if (_Database) return _Database;
  try {
    _Database = require('better-sqlite3');
  } catch (e) {
    throw new Error(
      'better-sqlite3 未安装或编译失败 — 请在项目根目录运行 `npm install` 或 `npm rebuild better-sqlite3`。\n原因: ' + e.message
    );
  }
  return _Database;
}

/**
 * 获取数据库单例。返回 better-sqlite3 Database 实例。
 */
function getDb() {
  if (_db) return _db;
  ensureStorageDir();
  const Database = loadDriver();
  _db = new Database(DB_FILE);
  _db.pragma('journal_mode = WAL');
  _db.pragma('synchronous = NORMAL');
  _db.pragma('busy_timeout = 5000');
  _db.pragma('foreign_keys = ON');
  migrate(_db);
  return _db;
}

function migrate(db) {
  const current = db.pragma('user_version', { simple: true });
  if (current >= SCHEMA_VERSION) return;

  const migrations = [
    // v0 → v1：events 表
    () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS events (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          ts           INTEGER NOT NULL,
          session_id   TEXT,
          command      TEXT NOT NULL,
          status       TEXT NOT NULL,
          duration_ms  INTEGER,
          note_id      TEXT,
          uid          TEXT,
          cid          TEXT,
          args_json    TEXT,
          summary_json TEXT,
          error        TEXT,
          result_path  TEXT,
          platform     TEXT NOT NULL DEFAULT 'xhs'
        );
        CREATE INDEX IF NOT EXISTS idx_events_note    ON events(note_id, ts);
        CREATE INDEX IF NOT EXISTS idx_events_uid     ON events(uid, ts);
        CREATE INDEX IF NOT EXISTS idx_events_command ON events(command, ts);
        CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
      `);
    },
    // v1 → v2：实体表 users / notes / comments
    () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS users (
          uid             TEXT NOT NULL,
          platform        TEXT NOT NULL DEFAULT 'xhs',
          sec_uid         TEXT,
          nickname        TEXT,
          first_seen      INTEGER,
          last_seen       INTEGER,
          comment_count   INTEGER NOT NULL DEFAULT 0,
          reply_count     INTEGER NOT NULL DEFAULT 0,
          tier            TEXT,
          tags_json       TEXT,
          notes           TEXT,
          PRIMARY KEY (platform, uid)
        );
        CREATE INDEX IF NOT EXISTS idx_users_tier     ON users(tier);
        CREATE INDEX IF NOT EXISTS idx_users_nickname ON users(nickname);

        CREATE TABLE IF NOT EXISTS notes (
          note_id             TEXT NOT NULL,
          platform            TEXT NOT NULL DEFAULT 'xhs',
          title               TEXT,
          author_uid          TEXT,
          is_mine             INTEGER NOT NULL DEFAULT 0,
          total_comments_seen INTEGER NOT NULL DEFAULT 0,
          last_get_ts         INTEGER,
          last_post_ts        INTEGER,
          xsec_token          TEXT,
          xsec_source         TEXT,
          token_updated_at    INTEGER,
          PRIMARY KEY (platform, note_id)
        );
        CREATE INDEX IF NOT EXISTS idx_notes_author ON notes(author_uid);

        CREATE TABLE IF NOT EXISTS comments (
          cid         TEXT NOT NULL,
          platform    TEXT NOT NULL DEFAULT 'xhs',
          note_id     TEXT NOT NULL,
          uid         TEXT,
          text        TEXT,
          text_hash   TEXT,
          likes       INTEGER,
          created_at  INTEGER,
          pinned      INTEGER NOT NULL DEFAULT 0,
          parent_cid  TEXT,
          sentiment   TEXT,
          priority    INTEGER,
          replied     INTEGER NOT NULL DEFAULT 0,
          reply_cid   TEXT,
          first_seen  INTEGER,
          last_seen   INTEGER,
          PRIMARY KEY (platform, cid)
        );
        CREATE INDEX IF NOT EXISTS idx_comments_note   ON comments(note_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_comments_uid    ON comments(uid, created_at);
        CREATE INDEX IF NOT EXISTS idx_comments_hash   ON comments(text_hash);
        CREATE INDEX IF NOT EXISTS idx_comments_parent ON comments(parent_cid);
      `);
    },
    // v2 → v3：reply_corpus + failure_patterns
    () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS reply_corpus (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          platform      TEXT NOT NULL DEFAULT 'xhs',
          src_cid       TEXT,
          src_text      TEXT,
          reply_text    TEXT NOT NULL,
          reply_hash    TEXT,
          note_id       TEXT,
          posted_at     INTEGER,
          outcome       TEXT,
          effectiveness REAL
        );
        CREATE INDEX IF NOT EXISTS idx_corpus_hash    ON reply_corpus(platform, reply_hash);
        CREATE INDEX IF NOT EXISTS idx_corpus_posted  ON reply_corpus(platform, posted_at);
        CREATE INDEX IF NOT EXISTS idx_corpus_outcome ON reply_corpus(outcome);
        CREATE INDEX IF NOT EXISTS idx_corpus_note    ON reply_corpus(note_id);

        CREATE TABLE IF NOT EXISTS failure_patterns (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          platform     TEXT NOT NULL DEFAULT 'xhs',
          signature    TEXT NOT NULL,
          hit_count    INTEGER NOT NULL DEFAULT 1,
          last_hit     INTEGER,
          example_text TEXT,
          mitigation   TEXT,
          UNIQUE(platform, signature)
        );
        CREATE INDEX IF NOT EXISTS idx_failures_lasthit ON failure_patterns(last_hit DESC);
      `);
    },
  ];

  // 备份再迁移（schema 版本递增前的兜底）
  if (current > 0) {
    try {
      const bak = DB_FILE + '.bak.v' + current;
      fs.copyFileSync(DB_FILE, bak);
    } catch (e) { /* 忽略备份失败 */ }
  }

  const applyAll = db.transaction((from) => {
    for (let v = from; v < SCHEMA_VERSION; v++) {
      const fn = migrations[v];
      if (!fn) throw new Error(`Missing migration step v${v} → v${v + 1}`);
      fn();
      db.pragma(`user_version = ${v + 1}`);
    }
  });
  applyAll(current);
}

/**
 * 关闭数据库（测试用；正常进程退出由 SQLite 自身处理）。
 */
function closeDb() {
  if (_db) {
    try { _db.close(); } catch (e) { /* ignore */ }
    _db = null;
  }
}

function getDbPath() { return DB_FILE; }

module.exports = { getDb, closeDb, getDbPath, SCHEMA_VERSION };
