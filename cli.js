#!/usr/bin/env node
// cli.js — 小红书评论 CLI（Bridge Framework 版）
//
// 依赖 Bridge Server (server.js) 运行中，
// 且浏览器已安装油猴脚本 scripts/xiaohongshu.user.js 并打开 xiaohongshu.com 页面。

const fs = require('fs');
const path = require('path');
const { AuditLogger } = require('./lib/audit');
const { BridgeClient } = require('./lib/client/bridge-client');
const { convertKeys } = require('./lib/shared/caseConvert');
const commands = require('./lib/commands');
const { SITE } = require('./lib/commands/helpers');

// ── 配置 ──
let config = {};
try { config = require('./config.json'); } catch (e) { /* use defaults */ }

// ── Bridge 客户端 ──
const bridge = new BridgeClient({
  host: config.bridge?.host || '127.0.0.1',
  port: config.bridge?.port || 19424,
  token: config.bridge?.token || '',
});

// ── 审计日志 ──
const audit = new AuditLogger();
let noLog = false;

// ═══════════════════════════════════════════════════════════
// Bridge 通信（通过 BridgeClient）
// ═══════════════════════════════════════════════════════════

async function bridgeCall(expression, awaitPromise = true) {
  const resp = await bridge.call({ site: SITE, expression, awaitPromise });
  if (!resp.ok) throw new Error(resp.error || 'Bridge Server 返回未知错误');
  const v = convertKeys(resp.value);
  // xhs envelope 检测：{ code, msg, data }；code !== 0 视为业务错误
  if (v && typeof v === 'object' && 'code' in v && v.code !== 0 && v.code !== '0') {
    const http = v._http_status;
    const tag = v.code === 461 ? 'NO_PERMISSION'
      : v.code === 300012 ? 'NOTE_NOT_FOUND'
      : v.code === -100 ? 'NOT_LOGGED_IN'
      : v.code === 10001 ? 'INVALID_PARAM'
      : v.code === -10000 ? 'RISK_CONTROL'
      : v.code === 406 || http === 406 ? 'SIGNATURE_INVALID'
      : v.code === 471 || http === 471 ? 'SIGNATURE_REJECTED'
      : http ? `HTTP_${http}`
      : null;
    const msg = v.msg || v.message || 'unknown';
    const err = new Error(`xhs[${v.code}${tag ? ' ' + tag : ''}] ${msg}`);
    err.code = v.code;
    err.httpStatus = http || null;
    err.envelope = v;
    throw err;
  }
  // 正常包：返回 data 字段（若有），否则返回整个 v（向后兼容旧调用）
  if (v && typeof v === 'object' && 'code' in v && 'data' in v) return v.data;
  return v;
}

async function loggedCall(endpoint, params, expression) {
  const t0 = Date.now();
  try {
    const result = await bridgeCall(expression);
    const ms = Date.now() - t0;
    const sum = {};
    if (result) {
      if (result.comments) sum.count = result.comments.length;
      if (result.has_more !== undefined) sum.has_more = result.has_more;
      if (result.notes) sum.count = result.notes.length;
      if (result.items) sum.count = result.items.length;
      if (result.comment || result.data) { sum.cid = (result.comment || result.data || {}).cid || (result.comment || result.data || {}).id; sum.status_code = 0; }
      if (result.code !== undefined && !sum.status_code) sum.status_code = result.code;
    }
    audit.logApiCall(endpoint, params, ms, 'success', sum);
    // DEBUG: 把原始 data 落盘，便于诊断字段路径
    if (process.env.XHS_DUMP === '1') {
      try {
        const fp = path.join(__dirname, 'logs', 'raw-' + endpoint + '-' + Date.now() + '.json');
        fs.writeFileSync(fp, JSON.stringify(result, null, 2));
        console.error('[XHS_DUMP] ' + fp);
      } catch(e) {}
    }
    return result;
  } catch (e) {
    audit.logApiCall(endpoint, params, Date.now() - t0, 'error', { error: e.message });
    throw e;
  }
}

// ═══════════════════════════════════════════════════════════
// 命令上下文（注入到各命令模块）
// ═══════════════════════════════════════════════════════════

const ctx = {
  bridge,
  audit,
  config,
  bridgeCall,
  loggedCall,
  // 命令间互相调用的引用（延迟绑定）
  cmdGet: null,
  cmdPost: null,
  cmdAnalyze: null,
};

// 绑定命令（注入上下文）
ctx.cmdGet = (args) => commands.get(ctx, args);
ctx.cmdPost = (args) => commands.post(ctx, args);
ctx.cmdAnalyze = (args) => commands.analyze(ctx, args);

// ═══════════════════════════════════════════════════════════
// 帮助
// ═══════════════════════════════════════════════════════════

function printHelp() {
  console.log(`
Xiaohongshu Comment CLI (Bridge Framework)

  node cli.js search <keyword>                搜索笔记
  node cli.js get <note_id>                  获取评论 (--all --depth N --new --since <ts>)
  node cli.js replies <note_id> <cid>        获取回复列表
  node cli.js note <note_id>                  笔记详情
  node cli.js my                              我的笔记
  node cli.js delete <note_id> <cid>          删除评论
  node cli.js like <note_id> <cid>            点赞评论
  node cli.js post <note_id> "内容"            发表评论
  node cli.js post <note_id> "回复" --reply-to <cid>
  node cli.js post <note_id> "@1179139456380456 内容" --reply-to <cid> --at <uid> <sec_uid>
  node cli.js analyze <note_id>              LLM 分析（情感/分类/优先级）
  node cli.js suggest <note_id>              LLM 回复建议（--auto 自动发布）
  node cli.js dashboard                       仪表盘 HTML
  node cli.js dashboard --note <note_id> --days 14
  node cli.js log [--tail N] [--note <id>] [--failed]
  node cli.js profile <user_id>                   用户交互历史

  反馈闭环（基于 SQLite 记忆层）：
  node cli.js corpus search <keyword>        搜索历史成功回复语料
  node cli.js corpus recent [--limit N]      最近发布过的回复
  node cli.js corpus stats                    语料统计
  node cli.js failures                        失败模式 top 10（按 hit_count）
  node cli.js failures --recent               最近失败模式
  node cli.js failures --mitigate <sig> "<缓解措施>"
  node cli.js dedup "<候选文本>"              查重护栏：是否曾经发过

  node cli.js status                              查看 Bridge 连接状态

  通用选项： --raw（原始输出） --no-log（本次不记录日志）

  前置条件：
  1. Bridge Server 运行中: node server.js
  2. 浏览器已安装油猴脚本 scripts/xiaohongshu.user.js
  3. 浏览器已打开 xiaohongshu.com 任意页面（需登录）
`);
}

// ═══════════════════════════════════════════════════════════
// 入口
// ═══════════════════════════════════════════════════════════

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const rawMode = args.includes('--raw');
  noLog = args.includes('--no-log');
  audit.setNoLog(noLog);

  if (!cmd || cmd === 'help' || cmd === '--help') {
    printHelp();
    return;
  }

  // 内建命令
  if (cmd === 'status') {
    try {
      const st = await bridge.status();
      console.log(JSON.stringify(st, null, 2));
    } catch (e) {
      console.error(`错误: ${e.message}`);
      process.exit(1);
    }
    return;
  }

  const handler = commands[cmd];
  if (!handler) {
    console.error(`未知命令: ${cmd}`);
    console.error('运行 "node cli.js help" 查看用法。');
    process.exit(1);
  }

  try {
    const result = await handler(ctx, args.slice(1));
    // dashboard / log 自己已打印；其它命令返回值统一 JSON 输出。
    const SILENT = new Set(['dashboard', 'log']);
    if (result !== undefined && !SILENT.has(cmd)) {
      console.log(JSON.stringify(result, null, 2));
    }
  } catch (e) {
    if (!noLog && audit._currentOp) {
      audit.endOperation('error', {}, null, e.message);
    }
    // ECONNREFUSED 友好提示
    if (e.message.includes('ECONNREFUSED') || e.message.includes('Bridge Server 未启动')) {
      console.error('错误: Bridge Server 未启动，请先运行:');
      console.error('  node server.js');
    } else if (e.message.includes('Unauthorized')) {
      console.error('错误: 认证失败 — 请检查 config.json 中的 bridge.token');
    } else if (/HTML 页面|非 JSON|空响应/.test(e.message)) {
      // 油猴端 bridgeFetchJson 抛出的友好错误，原样输出（已含 hint）
      console.error(`错误: ${e.message}`);
      console.error('提示: 若反复出现，请刷新 xiaohongshu.com 页面并确认仍处于登录态；写操作短时间内频繁失败通常是触发了风控，建议间隔 30 分钟后再试。');
    } else {
      console.error(`错误: ${e.message}`);
    }
    process.exit(1);
  }
}

main();
