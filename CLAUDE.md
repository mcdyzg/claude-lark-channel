# CLAUDE.md

Guidance for Claude Code when working on this repo.

## Architecture (one paragraph)
Single TypeScript plugin, two roles (master/child) selected by `LARK_CHANNEL_SCOPE_ID` env. Master (in host Claude Code) owns the Feishu WS, dedup/whitelist/attachment/reply logic, and a tmux pool that spawns a per-scope interactive `claude` with `--resume`. Child (in each tmux claude) exposes `reply` and `download_attachment` MCP tools that RPC back to master via a Unix socket; it also converts incoming socket `channel_push` envelopes into `notifications/claude/channel`.

## Core modules
- `src/shared/` — pure logic: scope resolver, session store, socket protocol, config, PID lock
- `src/master/` — Feishu ingress, parser, dedup, whitelist, reply, attachment, bridge-server, tmux pool, bootstrap, orchestrator
- `src/child/` — bridge-client, MCP tools, entry
- `src/index.ts` — role dispatcher (SCOPE_ID env → child; else → master)
- `hooks/on-session-start.sh` — writes `claudeSessionId` into `sessions/by-id/<scopeId>.json`

## Conventions
- ESM only (`type: module`); use `.js` extensions in imports
- Stdout is sacred (MCP JSON-RPC); all logging goes to `console.error`
- Keep per-file responsibility narrow; any file growing past ~300 lines is a candidate for split
- Prefer pure logic in `src/shared/` + thin wiring in `master/index.ts` for testability

## Testing
- Vitest for pure modules under `tests/`
- Integration test for bridge loopback: `tests/bridge/loopback.test.ts`
- tmux + real claude paths verified manually via `scripts/smoke-test.md` (no CI E2E)

## Common pitfalls
- Do not use `--print` + channel notifications: `--print` does not support the experimental `claude/channel` capability and uses incompatible auth mode
- Plugin's hooks depend on `jq`; if jq not installed the session_id capture silently fails and `--resume` won't kick in next cold start
- tmux `new-session -e KEY=VAL` requires tmux ≥ 3.2
