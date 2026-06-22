# v3 Roadmap — 小红书评论 CLI

## 概述

v3 的核心目标是**从 JSON 文件全表扫迁移到 SQLite 索引化查询**，同时引入反馈闭环让 AI 回复建议可以自我成长。

## 阶段划分

### P0: SQLite 基础设施 ✅
**目标**: 双写审计日志到 SQLite events 表，为后续阶段打基础

- [x] `lib/memory/db.js` — 单例 + WAL + 迁移
- [x] `lib/memory/events.js` — 事件流读写
- [x] `lib/audit.js` — 双写（audit.json + events）
- [x] `findLastFetchTime` 优先走 SQL
- [x] `tests/memory.test.js` — P0 回归测试

### P1: 命令切 SQL ✅
**目标**: 核心命令优先走 SQLite，audit.json 作为兜底

- [x] `cmdLog` — 支持 --note / --failed / --command 过滤
- [x] `cmdProfile` — 按 uid 精确匹配
- [x] `cmdEvents` — 原始事件流调试入口
- [x] `scripts/bench-p1.js` — 性能基线
- [x] `tests/p1-commands.test.js` — P1 回归测试

### P2: 实体表 ✅
**目标**: 用户/评论/笔记实体持久化，支持跨笔记查询

- [x] `lib/memory/users.js` — 用户实体（upsert 合并）
- [x] `lib/memory/comments.js` — 评论实体（text_hash 去重）
- [x] `lib/memory/notes.js` — 笔记实体（is_mine 一旦置 1 不回退）
- [x] `cmdGet.persist` — 旁路写实体表
- [x] `cmdWhois` — 用户全量画像
- [x] `tests/p2-entities.test.js` — P2 回归测试

### P3: 反馈闭环 ✅
**目标**: 成功语料 + 失败模式 → LLM 上下文注入

- [x] `lib/memory/corpus.js` — 回复语料库（去重 hash）
- [x] `lib/memory/failures.js` — 失败模式归类（signature UPSERT）
- [x] `cmdSuggest` — 注入 corpus/failures/avoid/userTags
- [x] 去重护栏：发布前 corpus.findByText → LLM 重写 → 二次命中跳过
- [x] `cmdCorpus` / `cmdFailures` / `cmdDedup` — 管理命令
- [x] `tests/p3-corpus.test.js` — P3 回归测试

### P4: 自适应风控（规划中）
**目标**: 根据失败模式自动调整发布策略

- [ ] 冷却期：同一 signature 连续失败 N 次后暂停发布
- [ ] 时间窗口：高频失败时段自动降速
- [ ] 关键词黑名单：从 failure_patterns.example_text 提取高频触发词

### P5: 跨平台共享（规划中）
**目标**: 复用 corpus/failures 到抖音平台

- [ ] 所有实体表已有 `platform` 字段
- [ ] 命令层按 platform 过滤
- [ ] 共享 LLM prompt 模板

## 设计原则

1. **双写过渡**: SQLite 写失败不影响主流程，audit.json 仍是"真实之源"
2. **渐进迁移**: 每个阶段独立可发布，不依赖后续阶段
3. **向后兼容**: 旧版 audit.json 数据通过回灌脚本导入 SQLite
4. **性能优先**: 关键查询走索引覆盖，bench-p1.js 验证 < 5ms
