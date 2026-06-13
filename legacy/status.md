# 小红书 Skill 开发状态

## 当前进度

| 项目 | 状态 |
|------|------|
| Daemon (CDP连接、Bridge注入、reload、重连) | ✅ |
| Bridge 签名：`x-s` (XYS_格式, seccoreSign) | ✅ |
| Bridge 签名：`x-t` | ✅ |
| Bridge 签名：`x-s-common` (复用页面值, session级) | ✅ |
| Bridge 签名：`x-b3-traceid` / `x-xray-traceid` | ✅ |
| CLI 命令：`getMe()` (user/me) | ✅ **200 成功** |
| CLI 命令：`my` (user_posted) | ⚠️ **406** |
| CLI 命令：`search` | ❓ 未测 |
| Transport: async XHR (RAP-patched) | ✅ |
| Transport: fetch (RAP-patched) | ✅ |

## 当前阻塞

**`user_posted` 端点返回 406**，即使所有签名头齐全（x-s/x-s-common/x-t/trace）。

### 对比分析

| 维度 | `user/me` (200✅) | `user_posted` (406❌) |
|------|-------------------|----------------------|
| 需要签名 | 否（或容忍缺失） | **是** |
| x-s-common | 不需要 | 需要（已有✅） |
| x-rap-param | 不需要 | **需要**（从成功.txt可见） |

### 根因推测

`x-rap-param` 由 RAP WASM 模块的 `_sabo_d156d` 函数生成，只在页面自己的 axios 拦截器链中产生。我们的 bridge 虽然使用了 RAP-patched 的 `window.XMLHttpRequest`，但 RAP 的 XHR monkey-patch 似乎不生成 `x-rap-param`（只做指纹采集）。

## 已验证的 vendor-dynamic.js 逆向成果

- `seccore_signv2(url, body)` → `"XYS_" + K.xE(K.lz(JSON.stringify(P)))` — 生成 x-s
- `xsCommon(e, a)` → `K.xE(K.lz(JSON.stringify(ef)))` — 生成 x-s-common (M/U 永远为空)
- K 模块 (webpack id=26594): Pu=MD5, tb=CRC32, xE=base64, lz=string-to-bytes
- `ef` 对象字段: s0,s1,x0(localStorage b1b1),x1(R.i8),x2(platform),x3,x4,x5(cookie a1),x6(空),x7(空),x8(localStorage b1或fingerprint),x9(K.tb(x8)),x10(sigCount),x11,x12(localStorage dsllt+_dsl)

## 下一步

需要在页面导航到用户主页时，拦截 `user_posted` 的真实请求，捕获其完整 headers（特别是 `x-rap-param`），然后复用到我们的 bridge 请求中。
