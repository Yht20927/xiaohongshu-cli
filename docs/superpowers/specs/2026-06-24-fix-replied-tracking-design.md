# Fix: 已回复笔记和评论的记录追踪

**日期**: 2026-06-24  
**状态**: 待实现  
**关联**: `init_replied_cids` 机制完全失效

## 问题诊断

SQLite `comments` 表正确存储了 `replied = 1`（165 条记录），但 Skill 文档中的 shell 去重机制有 3 重 bug：

1. **错误的 CLI flag**：`events --type post` → events 命令只支持 `--cmd`，不支持 `--type`
2. **缺少 `--json`**：默认文本输出格式 grep 永远匹配不到 `"reply_to":"..."` 模式
3. **错误的数据源**：events 表 `cid` 列对 post 命令永远是 NULL（`startOperation` 传的是 `reply_to` 而非 `cid`）

### 正确数据 vs Skill 查询

```
Skill 查询：events 表 → cid=NULL → 永远空集
正确数据：comments 表 → replied=1 → 165 条
```

## 方案

新增 `node cli.js replied` 命令直接查 `comments` 表，修正 3 个 Skill 文档中的 `init_replied_cids`。

## 文件变更

| 文件 | 动作 | 说明 |
|------|------|------|
| `lib/commands/replied.js` | **新增** | replied 命令实现 |
| `lib/commands/index.js` | 修改 | 注册 replied 命令 |
| `lib/memory/comments.js` | 修改 | 新增 `listReplied(filters)` |
| `cli.js` | 修改 | help 文本 |
| `SKILL.md` | 修改 | §规则2 修正 init_replied_cids |
| `全局规则.md` | 修改 | §2 修正 init_replied_cids |
| `执行模板.md` | 修改 | `init_replied_cids()` 函数体替换 |

## CLI 命令规格

```
node cli.js replied                  → 纯文本，每行一个 cid
node cli.js replied --json           → JSON 数组：[{cid, note_id, reply_cid}]
node cli.js replied --note <note_id> → 按笔记过滤
node cli.js replied --count          → 只输出数量
```

## 数据库查询

```sql
SELECT cid, note_id, reply_cid
FROM comments
WHERE platform = 'xhs' AND replied = 1
ORDER BY last_seen DESC
```

## 修正后的 init_replied_cids

```bash
init_replied_cids() {
  echo "🔄 初始化 REPLIED_CIDS 集合..."
  node cli.js replied > /tmp/replied_cids.txt
  local count=$(wc -l < /tmp/replied_cids.txt)
  echo "✓ 已加载 $count 个已回复的 cid"
}
```
