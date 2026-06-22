# REASONIX — 架构决策记录

## 1. Bridge Server + 油猴脚本方案

**决策**: 不逆向小红书签名算法，而是通过油猴脚本 hook 页面内部 axios 实例，让页面的拦截器自动完成签名。

**原因**:
- 小红书签名算法频繁更新，逆向成本高
- 页面 axios 拦截器是最权威的签名实现
- 油猴脚本可随页面更新而更新，维护成本低

**权衡**:
- 需要用户安装油猴脚本
- 依赖浏览器环境，无法纯命令行运行

## 2. 双通道通信（WebSocket + HTTP 轮询）

**决策**: Bridge Server 同时支持 WebSocket 和 HTTP 长轮询，油猴脚本使用 HTTP 轮询。

**原因**:
- GM_xmlhttpRequest 无法直接用 WebSocket（Chrome PNA 限制）
- HTTP 轮询兼容性最好，WebSocket 延迟最低
- 双通道自动 fallback，用户无感知

**权衡**:
- 代码复杂度略高
- 需要维护连接注册表和心跳机制

## 3. 写操作 noRetry

**决策**: 所有写操作（post/like/delete）使用 `noRetry: true`，不自动重试。

**原因**:
- 写操作超时不代表失败，可能已写入
- 自动重试会导致重复发布
- 用户手动重试更安全

**权衡**:
- 网络抖动时需要用户手动重试

## 4. SQLite 双写过渡

**决策**: audit.json 作为"真实之源"，SQLite 作为"查询副本"，双写并行。

**原因**:
- 旧版用户已有 audit.json 数据
- SQLite 写失败不影响主流程
- 渐进迁移，不强制用户一次性升级

**权衡**:
- 两份数据需要同步
- 查询时需要判断优先走哪条路径

## 5. 实体表 upsert 合并语义

**决策**: users/comments/notes 表使用 ON CONFLICT DO UPDATE，智能合并字段。

**原因**:
- 同一实体可能被多次观察（翻页、增量拉取）
- first_seen 取早，last_seen 取晚，计数累加
- is_mine 一旦置 1 不回退（"once mine, always mine"）

**权衡**:
- 合并逻辑需要仔细设计，避免数据覆盖

## 6. 失败模式 signature 归一化

**决策**: 把各种错误归一化为稳定 signature（如 `xhs_code=461`、`risk_control`）。

**原因**:
- 同一类错误可能有不同 message，但 signature 相同
- 按 signature UPSERT 累加 hit_count，自动统计高频错误
- 生成"避雷清单"注入 LLM prompt

**权衡**:
- classify 函数需要持续维护，适配新错误类型

## 7. 去重护栏三层防御

**决策**: suggest 命令实现三层去重：
1. prompt 注入 avoid 列表
2. 发布前 corpus.findByText 检查
3. 命中后 LLM 重写一次，二次命中则跳过

**原因**:
- LLM 可能生成重复内容
- 重复回复会被平台风控
- 三层防御确保万无一失

**权衡**:
- 增加一次 LLM 调用开销

## 8. 测试隔离模式

**决策**: 每个测试用例使用独立临时目录 + 清除 require.cache。

**原因**:
- better-sqlite3 模块缓存了数据库路径
- 不清除缓存会导致测试间数据污染
- 临时目录确保测试可并行运行

**权衡**:
- 测试代码略显冗长
