# 📕 Xiaohongshu Comment CLI

> 小红书评论管理 CLI 工具。基于 Bridge Server + 油猴脚本方案，支持笔记搜索、评论爬取、AI 智能分析、运营仪表盘。

**功能**：笔记搜索 / 评论获取（含嵌套回复） / 发表/删除/点赞评论 / AI 智能分析 / 回复语料库 / 去重护栏 / 运营仪表盘

## 快速开始

```bash
npm install

# 1. 启动 Bridge Server
node server.js

# 2. Chrome 安装油猴脚本 scripts/xiaohongshu.user.js，打开 xiaohongshu.com 并登录

# 3. 验证连接
node cli.js status

# 4. 开始使用
node cli.js my
node cli.js search "关键词"
node cli.js get <note_id> --page 1 --depth 1
node cli.js post <note_id> "内容"
```

## 命令清单

### 核心操作

| 命令 | 用途 | 示例 |
|------|------|------|
| `my` | 我的笔记列表 | `node cli.js my --count 20` |
| `search` | 搜索笔记 | `node cli.js search "关键词" --page 1 --count 20` |
| `note` | 笔记详情 | `node cli.js note <note_id>` |
| `get` | 获取评论（含嵌套回复） | `node cli.js get <note_id> --page 1 --depth 1` |
| `replies` | 单条评论的回复列表 | `node cli.js replies <note_id> <cid>` |
| `post` | 发表/回复评论 | `node cli.js post <note_id> "内容" --reply-to <cid>` |
| `delete` | 删除评论 | `node cli.js delete <note_id> <cid>` |
| `like` | 点赞评论 | `node cli.js like <note_id> <cid>` |

### AI 分析

| 命令 | 用途 | 示例 |
|------|------|------|
| `analyze` | AI 分析评论情感/优先级 | `node cli.js analyze <note_id>` |
| `suggest` | AI 生成回复建议 | `node cli.js suggest <note_id> --auto --min-priority 3` |

### 反馈闭环（基于 SQLite 记忆层）

| 命令 | 用途 | 示例 |
|------|------|------|
| `replied` | 已回复 cid 列表（去重用） | `node cli.js replied [--json] [--note <id>] [--count]` |
| `corpus search` | 搜索历史成功回复语料 | `node cli.js corpus search <keyword>` |
| `corpus recent` | 最近发布过的回复 | `node cli.js corpus recent --limit 20` |
| `corpus stats` | 语料统计 | `node cli.js corpus stats` |
| `failures` | 失败模式 top 10 | `node cli.js failures [--recent]` |
| `dedup` | 查重护栏：文本是否曾发过 | `node cli.js dedup "<候选文本>"` |

### 运维

| 命令 | 用途 | 示例 |
|------|------|------|
| `dashboard` | 生成运营仪表盘 HTML | `node cli.js dashboard --note <note_id> --days 14` |
| `profile` | 用户交互历史 | `node cli.js profile <user_id>` |
| `events` | 原始事件流（调试用） | `node cli.js events --cmd post --json` |
| `log` | 操作日志 | `node cli.js log --tail 20 [--note <id>] [--failed]` |
| `status` | Bridge 连接状态 | `node cli.js status` |

## 通用选项

| 选项 | 作用 |
|------|------|
| `--raw` | 输出完整 API 原始 JSON |
| `--no-log` | 本次执行不写入审计日志 |
| `--count N` | 返回条数（上限 20，风控安全） |
| `--page N` | 翻页（get/search） |
| `--all` | 获取全部评论（谨慎使用） |
| `--depth N` | 嵌套回复深度 |
| `--new` | 增量拉取（自上次 fetch 后的新评论） |
| `--since <ts>` | 指定时间戳增量 |
| `--reply-to <cid>` | 回复目标评论 |

## 配置

复制 `config.example.json` 为 `config.json` 并按需修改：

```json
{
  "bridge": {
    "host": "127.0.0.1",
    "port": 19424,
    "token": "",
    "heartbeatInterval": 30000,
    "heartbeatTimeout": 10000,
    "heartbeatMaxFailures": 3,
    "requestTimeout": 30000
  },
  "llm": {
    "api_key": "sk-...",
    "base_url": "https://api.openai.com/v1",
    "model": "gpt-4o-mini",
    "max_tokens": 4096,
    "timeout_ms": 60000,
    "max_retries": 3
  }
}
```

LLM API Key 也可用环境变量 `OPENAI_API_KEY`，Bridge token 可用 `XHS_BRIDGE_TOKEN`。

## 架构

```
xiaohongshu-cli/
├── cli.js                    # CLI 入口
├── server.js                 # Bridge Server 入口
├── config.json               # 配置（从 config.example.json 复制）
├── lib/
│   ├── commands/             # 命令模块
│   │   ├── get.js            # 获取评论
│   │   ├── post.js           # 发表评论
│   │   ├── search.js         # 搜索笔记
│   │   ├── my.js             # 我的笔记
│   │   ├── analyze.js        # LLM 分析
│   │   ├── suggest.js        # LLM 回复建议
│   │   ├── dashboard.js      # 运营仪表盘
│   │   ├── corpus.js         # 回复语料库
│   │   ├── failures.js       # 失败模式分析
│   │   ├── dedup.js          # 文本去重护栏
│   │   ├── replied.js        # 已回复追踪
│   │   ├── events.js         # 原始事件流
│   │   ├── whois.js          # 用户查询
│   │   └── helpers.js        # 共享辅助函数
│   ├── memory/               # SQLite 持久化记忆层
│   │   ├── db.js             # 数据库单例 + schema 迁移
│   │   ├── events.js         # 事件流读写
│   │   ├── comments.js       # 评论实体（含 replied 追踪）
│   │   ├── notes.js          # 笔记实体（含 token 缓存）
│   │   ├── users.js          # 用户实体
│   │   ├── corpus.js         # 回复语料
│   │   └── failures.js       # 失败模式
│   ├── server/               # Bridge Server 组件
│   ├── client/               # Bridge Client
│   ├── shared/               # 共享工具（protocol, caseConvert）
│   ├── audit.js              # 审计日志
│   └── llm.js                # LLM 封装
├── scripts/
│   └── xiaohongshu.user.js   # 油猴脚本
├── storage/
│   └── xiaohongshu.db        # SQLite 数据库（记忆层）
├── logs/
│   ├── audit.json            # 审计日志
│   └── results/              # 命令结果落盘
├── docs/
│   └── superpowers/specs/    # 设计文档
├── SKILL.md                  # Agent 技能文档
└── package.json
```

## 签名链路

- 油猴脚本注入 `window.__bridge` 到页面上下文，获取 webpack 中的 axios 实例
- **所有签名（x-s/x-s-common/x-t/x-rap-param）由页面 axios 拦截器自动注入**
- CLI 通过 Bridge Server HTTP API 发送 eval 表达式，油猴脚本在页面上下文中执行并返回结果

## 持久化记忆层

v3 起所有命令在写 `logs/audit.json` 的同时旁路写入 `storage/xiaohongshu.db`（SQLite），提供：

- **评论去重**：`comments.replied` 追踪所有已回复 cid，跨日跨轮生效
- **回复语料**：`reply_corpus` 累积成功回复，支持搜索和查重
- **失败模式**：`failure_patterns` 记录风控/错误签名，辅助避雷
- **增量拉取**：`events` 表索引覆盖 `--new` / `--since`，O(log N) 查询

## 故障排查

| 症状 | 原因 | 解法 |
|------|------|------|
| `Bridge Server 未启动` | server.js 未运行 | 启动 `node server.js` |
| `Unauthorized` | token 不匹配 | 检查 `config.json` 中的 `bridge.token` |
| `axios not captured` | 页面 webpack 未加载 | 刷新 xiaohongshu.com 页面，等待完全加载 |
| 搜索/获取返回空 `[]` | 未登录或油猴未连接 | 确认已登录；检查 `node cli.js status` |
| `Request timeout` | 油猴脚本未响应 | 刷新页面，确认油猴脚本已激活 |
| `getNote` / `get` 报错 | 缺 `xsec_token` | 先执行 `search` 或 `my` 写入 token 缓存 |
| 评论发布失败 | 风控拦截 | 换内容重试、降低频率（≥ 40s 间隔） |

## 依赖

- Node.js 18+
- `ws` — WebSocket 客户端
- `better-sqlite3` — SQLite 持久化记忆层
- Chrome 浏览器（安装 Tampermonkey 扩展 + 油猴脚本）
- （可选）OpenAI API key — `analyze` / `suggest` 命令
