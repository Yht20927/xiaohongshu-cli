# 📕 Xiaohongshu Comment CLI

> 小红书评论管理 CLI 工具。基于 Bridge Server + 油猴脚本方案，支持笔记搜索、评论爬取、AI 智能分析、运营仪表盘。

**功能**：笔记搜索 / 评论获取（含嵌套回复） / 发表/删除/点赞评论 / AI 智能分析 / 运营仪表盘

## 快速开始

```bash
npm install

# 1. 启动 Bridge Server
node server.js

# 2. 在 Chrome 中安装油猴脚本 scripts/xiaohongshu.user.js，打开 xiaohongshu.com 并登录

# 3. 开始使用
node cli.js my
node cli.js search "关键词"
node cli.js get <note_id> --all --depth 1
node cli.js post <note_id> "内容"
```

## 命令清单

| 命令 | 用途 | 示例 |
|------|------|------|
| `my` | 我的笔记列表 | `node cli.js my --count 30` |
| `search` | 搜索笔记 | `node cli.js search "关键词" --page 1` |
| `note` | 笔记详情 | `node cli.js note <note_id>` |
| `get` | 获取评论 | `node cli.js get <note_id> --all --depth 1` |
| `replies` | 单条评论的回复 | `node cli.js replies <note_id> <cid>` |
| `post` | 发表/回复评论 | `node cli.js post <note_id> "内容" --reply-to <cid>` |
| `delete` | 删除评论 | `node cli.js delete <note_id> <comment_id>` |
| `like` | 点赞评论 | `node cli.js like <note_id> <comment_id>` |
| `analyze` | AI 分析评论 | `node cli.js analyze <note_id>` |
| `suggest` | AI 回复建议 | `node cli.js suggest <note_id> --auto --min-priority 3` |
| `dashboard` | 生成仪表盘 | `node cli.js dashboard --note <note_id> --days 14` |
| `profile` | 用户画像 | `node cli.js profile <user_id>` |
| `log` | 查看操作日志 | `node cli.js log --tail 20` |
| `status` | 查看 Bridge 连接 | `node cli.js status` |

## 通用选项

| 选项 | 作用 |
|------|------|
| `--raw` | 输出完整 API 原始 JSON |
| `--no-log` | 本次执行不写入审计日志 |

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
xiaohongshu/
├── cli.js                    # CLI 入口
├── server.js                 # Bridge Server 入口
├── config.json               # 配置（从 config.example.json 复制）
├── lib/
│   ├── commands/             # 命令模块（get, post, search, ...）
│   ├── server/               # Bridge Server 组件（registry, ws-hub, router）
│   ├── client/               # Bridge Client（HTTP 请求封装）
│   ├── shared/               # 共享工具（protocol, caseConvert, parseResponse）
│   ├── audit.js              # 审计日志
│   ├── token-cache.js        # xsec_token 缓存
│   └── llm.js                # LLM 封装
├── scripts/
│   └── xiaohongshu.user.js   # 油猴脚本
├── logs/
│   ├── audit.json            # 审计日志
│   └── results/              # 命令结果
├── test/                     # 单元测试
├── SKILL.md                  # Agent 技能文档
└── package.json
```

## 签名链路

- 油猴脚本注入 `window.__bridge` 到页面上下文，获取 webpack 中的 axios 实例
- **所有签名（x-s/x-s-common/x-t/x-rap-param）由页面 axios 拦截器自动注入**
- CLI 通过 Bridge Server HTTP API 发送 eval 表达式，油猴脚本在页面上下文中执行并返回结果

## 审计日志

所有 CLI 操作自动记录到 `logs/audit.json`，大结果落地为独立 JSON 文件。支持增量拉取（`--new` / `--since`）。

## 故障排查

| 症状 | 原因 | 解法 |
|------|------|------|
| `Bridge Server 未启动` | server.js 未运行 | 启动 `node server.js` |
| `Unauthorized` | token 不匹配 | 检查 `config.json` 中的 `bridge.token` |
| `axios not captured` | 页面 webpack 未加载或 axios 找不到 | 刷新 xiaohongshu.com 页面，等待完全加载 |
| 搜索/获取返回空数组 `[]` | 未登录或油猴未连接 | 确认在 xiaohongshu.com 已登录；检查 `node cli.js status` |
| `Request timeout` | 油猴脚本未响应 | 刷新 xiaohongshu.com 页面，确认油猴脚本已激活 |
| `getNote` 报错 / 取不到 note | 缺 `xsec_token` | 先执行 `search` 或 `my` 写入 token 缓存 |
| 评论发布失败 | 风控拦截 | 换内容重试（更长/更自然）、降低频率 |

## 依赖

- Node.js 18+
- `ws` — WebSocket 客户端
- Chrome 浏览器（安装 Tampermonkey 扩展 + 油猴脚本）
- （可选）OpenAI API key — `analyze` / `suggest` 命令
