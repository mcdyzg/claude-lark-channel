# CLAUDE.md

Guidance for Claude Code when working on this repo.

## Architecture (one paragraph)
Single TypeScript plugin, two roles (master/child) selected by `LARK_CHANNEL_SCOPE_ID` env. Master (in host Claude Code) owns the Feishu WS, dedup/whitelist/attachment/reply logic, and a tmux pool that spawns per-scope interactive `claude` processes launched with `--dangerously-load-development-channels plugin:lark-channel@claude-lark-channel --dangerously-skip-permissions --resume <sid>`. Child (in each tmux claude) exposes `reply` and `download_attachment` MCP tools that RPC back to master via a Unix socket; it also converts incoming socket `channel_push` envelopes into `notifications/claude/channel`. Child waits for MCP `oninitialized` before connecting to master's socket to avoid channel notifications being dropped pre-handshake.

## Core modules
- `src/shared/` — pure logic: scope resolver, session store, socket protocol, config (JSON), PID lock, logger
- `src/master/` — Feishu ingress, parser (extractPlainText / extractAttachments / extractImageKeys), dedup, whitelist, reply, attachment, bridge-server, tmux pool, bootstrap, orchestrator
- `src/child/` — bridge-client (with `oninitialized` gate), MCP tools, entry
- `src/index.ts` — role dispatcher (SCOPE_ID env → child; else → master)
- `hooks/on-session-start.sh` — writes `claudeSessionId` into `sessions/by-id/<scopeId>.json`

## Conventions
- ESM only (`type: module`); use `.js` extensions in imports
- Stdout is sacred (MCP JSON-RPC); all user-visible logging goes through the `Logger` abstraction in `src/shared/logger.ts`. When `config.debug=false` the logger is a complete no-op (no stderr, no file); when `true` it writes to `<storeDir>/logs/debug.log` AND stderr
- Keep per-file responsibility narrow; any file growing past ~300 lines is a candidate for split
- Prefer pure logic in `src/shared/` + thin wiring in `master/index.ts` for testability
- Config lives at `~/.claude/channels/lark-channel/config.json` (JSON, not .env). See `config.json.example` and `src/shared/config.ts` for shape

## Testing
- Vitest for pure modules under `tests/`
- Integration test for bridge loopback: `tests/bridge/loopback.test.ts`
- tmux + real claude paths verified manually via `scripts/smoke-test.md` (no CI E2E)
- Current test count: 58 across 8 files

## Common pitfalls
- **Don't use `--print` + channel notifications**: `--print` does not support the `claude/channel` experimental capability and uses incompatible auth mode (API key vs claude.ai login)
- **Spawned `claude` MUST get the dev-channel flag**: plain `claude` (without `--dangerously-load-development-channels plugin:<name>@<marketplace>`) silently drops `notifications/claude/channel`. The flag pops an interactive warning; `pool.autoConfirmDevChannel()` polls the tmux pane and auto-presses Enter
- **Tmux preservation**: on master shutdown, tmux sessions are INTENTIONALLY not killed. On next startup, `pool.start()` enumerates `lark-*` sessions and adopts the ones whose scopeId is in `SessionStore` (unknown scopeIds are killed as orphans)
- **Child defers `bridge.start()` until MCP `oninitialized`**: otherwise `server.notification()` called before the MCP client sends `initialized` is silently dropped per MCP spec, and Claude sits idle without processing the channel push
- **SessionStart hook writes the session_id**: but if Claude exits before persisting its `.jsonl` (e.g. spawn → hello timeout → kill), the stored id is stale. Pool handles this: on hello timeout with a non-empty `claudeSessionId`, it clears the id and retries a fresh spawn once
- **Plugin hooks depend on `jq`**: if jq is missing, the session_id capture silently no-ops and `--resume` won't kick in next cold start
- **tmux `new-session -e KEY=VAL` requires tmux ≥ 3.2**
- **Three copies of the code**: workspace (`/Users/bytedance/haha/x/agent/claude-about/claude-lark-channel`), marketplace clone (`~/.claude/plugins/marketplaces/claude-lark-channel`), and runtime cache (`~/.claude/plugins/cache/claude-lark-channel/lark-channel/0.1.0`). They all must stay in sync during development — after editing source, copy changed files to cache + marketplace so `/reload-plugins` picks them up

## Meta schema (channel_push params.meta fields)
- **Background frame** (`kind: "background"`): `scope_key`; optionally `image_path` / `image_paths` (root images)
- **Main frame**: `chat_id`, `message_id`, `user_id`, `chat_type`, `scope_key`, `ts`; optionally `thread_id`, `image_path` / `image_paths` (own images), `attachment_kind` / `attachment_file_id` / `attachment_name` (file/audio/video), `parent_message_id` / `parent_content` / `parent_image_path` / `parent_image_paths` (when inbound event has `parent_id`)
