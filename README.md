# claude-lark-channel

Feishu/Lark channel plugin for Claude Code. Bridges IM messages into Claude via the MCP channel mechanism with per-scope tmux isolation (each chat or thread runs in its own Claude session).

## Features
- **Strict per-scope isolation** via tmux + Claude `--resume` — each chat / thread has its own Claude process with independent context
- **Channel mechanism** — inbound IM messages arrive as `notifications/claude/channel` events in the spawned Claude session
- **Multimodal**:
  - Current-message images auto-downloaded to local `inbox/`
  - Thread-root images auto-downloaded and injected into first-turn background (so Claude sees attachments posted in the thread's opener)
  - Quote-reply (`parent_id`) fetches the parent message's text + images into `parent_content` / `parent_image_path(s)` meta
  - Files / audio / video lazy-downloaded via `download_attachment` MCP tool
- **First-turn background injection**: thread root (thread mode) / chat history (chat mode)
- **Tmux preservation across master restarts** — `/reload-plugins` or closing host Claude Code keeps all per-scope tmux sessions alive; next master start adopts them. You can `tmux attach -t lark-<id>` at any time to inspect a scope's conversation.
- **LRU + idle TTL reap** (defaults: 50 scopes, 4h idle; configurable)
- **Single-switch debug logging** — `"debug": true` in config.json → unified `logs/debug.log` across master and child processes; `false` → completely silent

## Requirements
- macOS (Linux best-effort; Windows unsupported)
- Node ≥ 20
- tmux ≥ 3.2 (`brew install tmux`) — needed for `new-session -e KEY=VAL`
- jq (`brew install jq`) — needed by `SessionStart` hook
- Claude Code ≥ 2.1.80 with claude.ai login (channel mechanism requires claude.ai; API-key auth not supported)
- A Feishu/Lark self-built app with bot: permissions `im:message`, `im:message:send_as_bot`, `im:message:readonly`

## Install
```
/plugin marketplace add https://github.com/mcdyzg/claude-lark-channel.git
/plugin install lark-channel@claude-lark-channel
/reload-plugins
/lark-channel:configure setup
```

## Start

After installing and configuring, **open a new terminal window** and launch a dedicated long-running host:

```bash
claude --dangerously-load-development-channels "plugin:lark-channel@claude-lark-channel" --dangerously-skip-permissions
```

**Leave this window open** — it is the master process hosting the Feishu WebSocket connection. Per-scope Claude sessions are spawned into their own tmux sessions under this master. Closing this window stops the bridge (tmux sessions are preserved and adopted when you restart the master).

Confirm the startup warning by pressing **Enter** when the `"WARNING: Loading development channels"` prompt appears (the `--dangerously-load-development-channels` flag is required because custom plugins are not on Anthropic's allowlist during the channels research preview).

## Configuration

Config lives at `~/.claude/channels/lark-channel/config.json`. Manage via the skill:

```
/lark-channel:configure                  # show current (sensitive values masked)
/lark-channel:configure cli_xxx <secret> # quick-set credentials
/lark-channel:configure setup            # full interactive wizard
/lark-channel:configure debug on|off     # toggle verbose logging
/lark-channel:configure clear            # delete config after confirmation
```

Changes take effect after `/reload-plugins`.

## Using as a Q&A bot

To make every spawned child claude adopt a specific persona (e.g. "you are a Q&A assistant for project X, always answer in Chinese, never modify files"), point the plugin at a prompt file:

```json
{
  "appendSystemPromptFile": "/absolute/path/to/persona.md"
}
```

The file is passed to each spawned child claude via `--append-system-prompt-file`; claude reads it and appends the content to its default system prompt. Keep it focused on **persona / always-on constraints** — project-specific knowledge belongs in the target repo's `CLAUDE.md` / `.claude/skills/`, not in this file.

**Reload semantics:** changing the prompt file does not retroactively affect running tmux sessions. To pick up new content for a scope: `tmux kill-session -t lark-<scopeId>` (next inbound message will respawn with the new prompt), or wait for the idle-TTL sweep.

**Caveats:** the path must be absolute (relative paths are ignored, not rejected as an error); missing / wrong-type / empty (size 0) files are also ignored with a logger warn/error. In all failure modes the child still spawns — just without the flag — and master stays up. Persona size ~1-2 KB is a reasonable target; larger files are accepted but eat context budget on every turn.

## Layout
```
~/.claude/channels/lark-channel/
├── config.json                    # credentials + runtime options (debug, scope mode, whitelists, pool limits, timeouts)
├── sessions/
│   ├── by-id/<scopeId>.json       # primary session store (SessionStart hook writes here)
│   └── by-scope/<safe>.json       # symlink → by-id
├── inbox/                         # downloaded images / attachments
├── bridge.sock                    # master ↔ child Unix socket
├── master-<appId>.lock            # single-master PID lock
└── logs/
    └── debug.log                  # only when debug=true
```

## Troubleshooting

- **Bot acked (emoji reaction) but never replied**: the child Claude may have failed to start, or channel notifications were dropped before MCP handshake completed. Enable debug: `/lark-channel:configure debug on` → `/reload-plugins`, re-send the message, then `cat ~/.claude/channels/lark-channel/logs/debug.log` to see the full trace (Feishu ingress → pool.ensure → bridge hello → channel_push → RPC back).
- **Inspect a scope's Claude session**: `tmux ls | grep lark-` then `tmux attach -t lark-<uuid>`. Safe — the scope continues even if you detach.
- **Force-reset a scope's Claude session**: `tmux kill-session -t lark-<id>` AND delete the matching `sessions/by-id/<scopeId>.json`. Next message to that chat/thread spawns a brand-new Claude session.
- **"No conversation found with session ID"**: a previously-stored `claudeSessionId` was never persisted by Claude (e.g. crash before first turn). Master auto-retries as a fresh session — transparent to you.
- **Bot silently not replying / no logs appearing after plugin upgrade**: usually means an old-version master is still holding the lock. From v0.1.2 onward the new master auto-takes-over on startup — you should see `[lark-channel] replacing old master pid=X — SIGTERM` followed by `[lark-channel] master vY.Z ready` in whatever terminal launched the new master. If instead you see `[lark-channel] ✗ cannot acquire lock ...`, the takeover refused (typically because the lock file points at a PID that is not a lark-channel process). Inspect manually:
  ```bash
  cat ~/.claude/channels/lark-channel/master-*.lock      # 持有者 PID
  ps -p <pid>                                            # 确认身份
  ```
  如果它是 lark-channel master 但 takeover 没生效，`kill <pid>` 后 `/reload-plugins`。如果它不是 lark-channel 进程（PID 被复用或 lock 文件损坏），删除锁文件再 `/reload-plugins`。

## Design
- Original architecture: `docs/superpowers/specs/2026-04-21-claude-lark-channel-design.md`
- Thread / parent context images enhancement: `docs/superpowers/specs/2026-04-22-thread-context-images-design.md`

## License
Apache-2.0
