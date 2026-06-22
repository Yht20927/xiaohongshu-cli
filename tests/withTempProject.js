// tests/withTempProject.js — 测试隔离夹具
//
// 用法：
//   const { withTempProject } = require('./withTempProject');
//   await withTempProject(({ tmpDir }) => {
//     // env XHS_STORAGE_DIR / XHS_LOG_DIR 已重定向到 tmpDir
//     // 加载 lib/memory/db、lib/audit 等模块都会落到 tmp 目录
//   });

const fs = require('fs');
const os = require('os');
const path = require('path');

async function withTempProject(fn) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xhs-test-'));
  const storageDir = path.join(tmpRoot, 'storage');
  const logDir = path.join(tmpRoot, 'logs');
  fs.mkdirSync(storageDir, { recursive: true });
  fs.mkdirSync(logDir, { recursive: true });

  const prevStorage = process.env.XHS_STORAGE_DIR;
  const prevLog = process.env.XHS_LOG_DIR;
  const prevDebug = process.env.XHS_DEBUG;
  process.env.XHS_STORAGE_DIR = storageDir;
  process.env.XHS_LOG_DIR = logDir;

  // 清掉缓存了路径的模块（包括 memory 模块和依赖它们的命令模块）
  const purge = [
    '../lib/memory/db', '../lib/memory/events', '../lib/memory/users',
    '../lib/memory/notes', '../lib/memory/comments', '../lib/memory/corpus',
    '../lib/memory/failures', '../lib/audit', '../lib/token-cache',
    '../lib/commands/post', '../lib/commands/suggest',
    '../lib/commands/corpus', '../lib/commands/failures', '../lib/commands/dedup',
    '../lib/commands/whois', '../lib/commands/events',
  ];
  for (const m of purge) {
    try { delete require.cache[require.resolve(m)]; } catch (_) {}
  }

  try {
    await fn({ tmpDir: tmpRoot, storageDir, logDir });
  } finally {
    try { require('../lib/memory/db').closeDb(); } catch (_) {}
    if (prevStorage === undefined) delete process.env.XHS_STORAGE_DIR;
    else process.env.XHS_STORAGE_DIR = prevStorage;
    if (prevLog === undefined) delete process.env.XHS_LOG_DIR;
    else process.env.XHS_LOG_DIR = prevLog;
    if (prevDebug === undefined) delete process.env.XHS_DEBUG;
    else process.env.XHS_DEBUG = prevDebug;
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) {}
    for (const m of purge) {
      try { delete require.cache[require.resolve(m)]; } catch (_) {}
    }
  }
}

module.exports = { withTempProject };
