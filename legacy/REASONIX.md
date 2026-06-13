# REASONIX.md — xiaohongshu-comment-cli

## Stack
- **Node.js** — vanilla, no framework; single-file application
- **`ws`** (^8.16.0) — WebSocket client for Chrome DevTools Protocol
- **Chrome DevTools Protocol** — browser automation via `--remote-debugging-port`
- **Target platform**: 小红书 (Xiaohongshu) web, Windows

## Layout
- `cli.js` — entry point: daemon lifecycle, transport-adaptive bridge injection, command routing
- `lib/daemon.js` — daemon robustness: PID JSON lock, ReconnectManager, PageMonitor, HeartbeatMonitor
- `lib/cdp.js` — CDP WebSocket client wrapper
- `lib/llm.js` — OpenAI-compatible LLM client for comment analysis & reply suggestion
- `templates/` — future HTML templates
- `config.json` — LLM + daemon configuration (optional, has defaults)
- `package.json` — manifest; use `node cli.js` directly, not npm scripts
- `SKILL.md` — agent-facing playbook
- `reply-strategy.md` — strategy template for automated comment reply decisions
- `.xhs_daemon.pid` — runtime PID JSON lock; present only when daemon is alive

## Commands
All commands use `node cli.js`.

| Command | Purpose |
|---------|---------|
| `node cli.js daemon` | Start background daemon (CDP → Chrome) |
| `node cli.js ping` | Daemon health check (expect `pong`) |
| `node cli.js stop` | Graceful daemon shutdown |
| `node cli.js my [--cursor N] [--count N]` | List own notes |
| `node cli.js search <kw> [--page N] [--count N]` | Search notes |
| `node cli.js note <note_id>` | Get note detail |
| `node cli.js get <id> [--pages N\|--all] [--depth N] [--raw]` | Fetch comments |
| `node cli.js replies <cid> <note_id>` | Fetch replies to one comment |
| `node cli.js post <id> "<text>" [--reply-to <cid>]` | Publish comment |
| `node cli.js delete <note_id> <comment_id>` | Delete comment |
| `node cli.js like <note_id> <comment_id>` | Like a comment |
| `node cli.js analyze <id>` | LLM analyze comments (sentiment/category/priority) |
| `node cli.js suggest <id> [--auto]` | LLM reply suggestions |
| `node cli.js dashboard [--note <id>]` | Generate HTML dashboard |
| `node cli.js profile <user_id>` | User profile |
| `node cli.js log [--tail N] [--note <id>] [--failed]` | View operation log |

## Conventions
- **Single-file architecture** — no `src/`, no modules; core logic in `cli.js`
- **Daemon/client split**: daemon holds a persistent CDP WebSocket and exposes an HTTP server (`POST /eval`); CLI commands send `Runtime.evaluate` expressions over HTTP to the daemon
- **Bridge injection**: `window.__xhs.*` API functions are built as a transport-adaptive bridge, injected early with `Page.addScriptToEvaluateOnNewDocument`, and re-evaluated into the current document with `Runtime.evaluate`
- **Output format**: clean JSON by default (normalized field subset); pass `--raw` for full API response
- **Arg style**: positional commands + `--flag value` (not `--flag=value`)
- **Daemon port**: hardcoded `19423` on `127.0.0.1` (offset from Douyin's 19422)
- **PID file**: `.xhs_daemon.pid` prevents duplicate daemons; deleted on shutdown

## Watch out for
- **Chrome prerequisites**: browser must be open to `xiaohongshu.com` (logged in) with `--remote-debugging-port=9222`. First daemon connection triggers a Chrome "Allow debugging" dialog — user must click once.
- **Daemon auto-expiry**: exits after 20 min of inactivity. Always run `node cli.js stop` when done.
- **Anti-crawling**: XHS uses `x-s`/`x-t`/`x-s-common` headers for API auth. The bridge (v4) calls `window._webmsxyw()` (the page's global signing function) to generate signing headers for all requests. CDP `Fetch.requestPaused` injects headers as fallback. If API calls return 401/403, refresh the XHS page to get fresh cookies/session.
- **Stale bridge after navigation**: if the user navigates away in Chrome, `window.__xhs` is lost. The daemon detects navigation and auto-recovers, or restart it (`stop` → `daemon`).
- **Port conflict**: XHS daemon uses port 19423. If Douyin daemon is running on 19422, the two can coexist.
