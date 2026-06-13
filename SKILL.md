---
name: xiaohongshu-comment
description: 小红书评论 CLI — 笔记搜索 / 获取评论(含嵌套回复) / 发表回复评论 / 删除评论 / 点赞。Bridge Server + 油猴脚本方案，页面 axios 自动签名。
---

# 小红书评论 Skill

## 前置条件

- 用户已在 Chrome 中**登录小红书**
- Chrome 已安装 Tampermonkey 扩展
- 已安装油猴脚本 `scripts/xiaohongshu.user.js`（`@match *://*.xiaohongshu.com/*`）
- 依赖已安装：`npm install`

## 通用选项

所有命令均支持以下选项：

| 选项 | 作用 |
|------|------|
| `--raw` | 输出完整 API 原始 JSON（调试用） |
| `--no-log` | 本次执行不写入审计日志 |

## Bridge Server 生命周期（关键）

```
操作顺序: 确保 server 运行 → 确认油猴已连接 → 操作...
```

### 启动 Bridge Server

```bash
node server.js
```

用 `run_background` 运行，等待输出 `[server] Bridge Server ready — http://127.0.0.1:19424`。

首次启动会自动生成 `bridge.token` 并写入 `config.json`。

### 确认油猴连接

```bash
node cli.js status   # 或 curl http://127.0.0.1:19424/api/status
```

确保 `xiaohongshu.com` 下已有活跃连接。

### 操作完毕

```bash
# 按 Ctrl+C 停止 server，或直接关闭终端
```

### 签名链路说明

- 油猴脚本注入 `window.__bridge` 到页面上下文，获取 webpack 中的 axios 实例。
- **所有签名（x-s/x-s-common/x-t/x-rap-param）由页面 axios 拦截器自动注入**，无需手动处理。
- CLI 通过 Bridge Server HTTP API 发送 eval 表达式，油猴脚本在页面上下文中执行并返回结果。

---

## 命令参考

### 我的笔记

```bash
node cli.js my
node cli.js my --count 30
```

输出（清洁模式）：

```json
[{
  "note_id": "6932e0b3000000001e02f4b2",
  "title": "笔记标题",
  "desc": "笔记描述前80字...",
  "time": 1780238354,
  "author": "作者昵称",
  "stats": { "likes": 1234, "comments": 56, "collects": 89, "shares": 3 }
}]
```

### 搜索笔记

```bash
node cli.js search "关键词"
node cli.js search "关键词" --page 2 --count 20
```

输出格式同 `my`。

### 获取笔记详情

```bash
node cli.js note <note_id>
node cli.js note <note_id> --token <xsec_token> --source pc_search
```

- 若先做过 `search` / `my`，会自动复用沉淀在 `logs/xsec-tokens.json` 的 `xsec_token`，**不需要手动传**。
- 没有 token + 触发风控（`code=461` / `code=-10000`）时，自动回退到页面 `__INITIAL_STATE__` 抓取（会 SPA 跳到 `/explore/<id>`，浏览器页面会变）。
- 错误现在会带原始 xhs `code` + `msg`，例如 `xhs[461 NO_PERMISSION]`。

### 获取评论

```bash
node cli.js get 6932e0b3000000001e02f4b2                  # 默认 1 页 20 条
node cli.js get 6932e0b3000000001e02f4b2 --pages 5        # 指定页数
node cli.js get 6932e0b3000000001e02f4b2 --all             # 全部一级评论
node cli.js get 6932e0b3000000001e02f4b2 --all --depth 1   # 含嵌套回复
node cli.js get 6932e0b3000000001e02f4b2 --new             # 增量：只拉上次获取之后的新评论
node cli.js get 6932e0b3000000001e02f4b2 --new --depth 1   # 增量 + 嵌套回复
node cli.js get 6932e0b3000000001e02f4b2 --since 1780238354  # 增量：指定 Unix 时间戳
```

输出（`--depth 1` 时有 `children`）：

```json
[{
  "cid": "6932e0b3000000001e02f4b2",
  "text": "一级评论内容",
  "likes": 1,
  "replies": 3,
  "time": 1780238354,
  "pinned": false,
  "user": { "nickname": "用户", "user_id": "123", "avatar": "https://..." },
  "children": [{
    "cid": "6932e0b3000000001e02f4b3",
    "text": "回复内容",
    "likes": 0,
    "replies": 0,
    "time": 1780239000,
    "user": { "nickname": "回复者", "user_id": "456", "avatar": "https://..." }
  }]
}]
```

- `--depth 1`：拉所有一级评论 + 每条下所有回复
- `--depth 2`：递归两层（回复的回复）

#### 增量获取（`--new` / `--since`）

基于时间戳过滤，只拉取新评论，请求数最少。

**`--new`**：自动从审计日志中找到该笔记上次成功 `get` 的时间，只拉此后的新评论。无历史记录时退化为全量。

**`--since <unix_ts>`**：显式指定 Unix 时间戳（秒），只拉 `create_time > ts` 的评论。

### 单条回复列表

```bash
node cli.js replies <note_id> <cid>
```

输出格式同 `get` 的结果项（无 `children`）。

### 发表评论

```bash
node cli.js post 6932e0b3000000001e02f4b2 "好看！"
node cli.js post 6932e0b3000000001e02f4b2 "说得对" --reply-to 6932e0b3000000001e02f4b3
```

输出：

```json
{ "cid": "6932e0b3000000001e02f4b2", "text": "好看！", "time": 178023..., "status": "published" }
```

失败：

```json
{ "error": "评论发送失败", "code": -1 }
```

> **注意**：小红书 API 有风控机制，频繁操作可能触发验证码。评论内容不宜过短或包含敏感词。

### 删除评论

```bash
node cli.js delete <note_id> <comment_id>
```

### 点赞评论

```bash
node cli.js like <note_id> <comment_id>
```

### 查看操作日志

```bash
node cli.js log                              # 最近 10 条操作
node cli.js log --tail 20                    # 最近 20 条
node cli.js log --note <note_id>             # 指定笔记的所有操作
node cli.js log --failed                     # 只看失败的
```

### LLM 分析

```bash
node cli.js analyze <note_id>
```

调用 LLM 批量分析评论，返回情感/分类/优先级。需配置 `config.json` 中的 `llm.api_key`。

支持环境变量 `OPENAI_API_KEY`。

### LLM 回复建议

```bash
node cli.js suggest <note_id>              # 仅建议
node cli.js suggest <note_id> --auto       # 自动发布
node cli.js suggest <note_id> --min-priority 4
node cli.js suggest <note_id> --interval 45000  # 自定义发布间隔（毫秒）
```

### 运营仪表盘

```bash
node cli.js dashboard
node cli.js dashboard --note <note_id> --days 14
```

生成本地自包含 HTML 仪表盘，含情感分布饼图、评论趋势折线图。

### 用户画像

```bash
node cli.js profile <user_id>
```

### 连接状态

```bash
node cli.js status
```

查看 Bridge Server 连接状态，确认油猴脚本已连接。

---

## 智能回复工作流

配合策略文件 `reply-strategy.md`，agent 可自动判断哪些评论需要回复、生成回复内容并发布。

### 首次执行

```
1. 读取策略文件（reply-strategy.md）
2. node cli.js get <note_id> --all --depth 1
3. 根据策略逐条判断：
     → 跳过 → 记录原因
     → 需回复 → 根据风格指南生成回复内容
              → node cli.js post <note_id> "内容" --reply-to <cid>
4. 输出执行报告
```

### 后续增量执行

```
1. 读取策略文件
2. node cli.js get <note_id> --new --depth 1   # 只拉新评论
3. 对新评论逐条判断并回复
4. 输出执行报告（标注增量模式 + 跳过旧评论数）
```

> `--new` 自动从审计日志中找到上次拉取时间。

---

## 故障排查

| 症状 | 原因 | 解法 |
|------|------|------|
| `Bridge Server 未启动` | server.js 未运行 | 启动 `node server.js` |
| `Unauthorized` | token 不匹配 | 检查 `config.json` 中的 `bridge.token` |
| `axios not captured` | 页面 webpack 未加载或 axios 找不到 | 刷新 xiaohongshu.com 页面，等待完全加载 |
| 搜索/获取返回空数组 `[]` | 未登录或油猴未连接 | 确认在 xiaohongshu.com 已登录；检查 `node cli.js status` |
| 油猴脚本报注册失败 | server 未启动或端口不对 | 确认 server 在 19424 端口运行 |
| `Request timeout` | 油猴脚本未响应 | 刷新 xiaohongshu.com 页面，确认油猴脚本已激活 |
| `--new` 无历史记录仍拉全量 | 该笔记未被拉取过 | 预期行为，首次执行 `--new` 等价于 `--all` |
| API 返回 461 | 无权限访问该笔记 | 可能不是自己的笔记或笔记已删除；新版本会显示 `xhs[461 NO_PERMISSION]` |
| `xhs[-10000 RISK_CONTROL]` | 接口被风控 | note 命令会自动回退到 page；其他命令请降低频率或刷新页面登录态 |
| `getNote` 报错 / 取不到 note | 缺 `xsec_token` | 先执行 `search` 或 `my` 写入 token 缓存；或手动 `--token` 传入 |
| 评论发布失败 | 风控拦截 | 换内容重试（更长/更自然）、降低频率 |

## 审计日志

所有 CLI 操作自动记录到 `logs/audit.json`，便于追踪和增量拉取。

```
logs/
├── audit.json              ← 操作元数据（sessions → operations → apiCalls）
└── results/
    ├── get-<note_id>-<ts>.json    ← 评论获取的完整结果
    ├── search-<kw>-<ts>.json      ← 搜索结果
    └── ...
```

- 每个操作记录：命令、参数、开始/结束时间、耗时、成功/失败、摘要
- 每个 API 调用记录：端点、参数、耗时、返回条数
- 大结果（`get`/`search`/`my`/`replies`）落地为独立 JSON 文件
- 小结果（`post`/`ping`/`stop`）内联在 audit.json
- `--no-log` 可跳过记录

## 配置

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
    "api_key": "",
    "base_url": "https://api.openai.com/v1",
    "model": "gpt-4o-mini",
    "max_tokens": 4096,
    "timeout_ms": 60000,
    "max_retries": 3
  }
}
```

- `bridge.token` 可通过环境变量 `XHS_BRIDGE_TOKEN` 设置
- `llm.api_key` 可通过环境变量 `OPENAI_API_KEY` 设置

## 架构

```
xiaohongshu/
├── cli.js                    # CLI 入口
├── server.js                 # Bridge Server 入口
├── config.json               # 配置
├── lib/
│   ├── commands/             # 命令模块
│   ├── server/               # Bridge Server 组件（registry, ws-hub, router）
│   ├── client/               # Bridge Client（HTTP 请求封装）
│   ├── shared/               # 共享工具
│   ├── audit.js              # 审计日志
│   ├── token-cache.js        # xsec_token 缓存
│   └── llm.js                # LLM 封装
├── scripts/
│   └── xiaohongshu.user.js   # 油猴脚本
├── logs/
│   ├── audit.json
│   └── results/
├── test/                     # 单元测试
├── SKILL.md                  # Agent 技能文档
└── package.json
```

## 与抖音 Skill 的关键差异

| 项目 | 抖音 | 小红书 |
|------|------|--------|
| 内容 ID | `aweme_id` | `note_id` |
| Bridge 端口 | `19422` | `19424` |
| Bridge 命名空间 | `window.__bridge` (fetch) | `window.__bridge` (axios) |
| API 签名 | URL 参数 + Cookie | 页面 axios 拦截器自动注入 |
| 额外功能 | — | `delete`、`like`、`note`（笔记详情） |
