# claude-lark-channel

Feishu/Lark channel plugin for Claude Code. Bridges IM messages into Claude via the MCP channel mechanism with per-scope tmux isolation (each chat or thread runs in its own Claude session).

## Features
- Strict per-scope isolation via tmux + Claude `--resume`
- Channel mechanism: inbound messages arrive as `notifications/claude/channel`
- Multimodal: auto-download images; lazy-download files/audio/video via `download_attachment` tool
- First-turn background: thread root (thread mode) / chat history (chat mode)
- LRU + idle TTL reap (defaults: 50 scopes, 4h idle)

## Requirements
- macOS (Linux best-effort; Windows unsupported)
- Node ≥ 20
- tmux ≥ 3.2 (`brew install tmux`)
- jq (`brew install jq`)
- Claude Code ≥ 2.1.80 with claude.ai login
- A Feishu/Lark self-built app with bot: permissions `im:message`, `im:message:send_as_bot`, `im:message:readonly`

## Install
```
/plugin marketplace add https://github.com/loujiahao/claude-lark-channel.git
/plugin install lark-channel@claude-lark-channel
/reload-plugins
/lark-channel:configure setup
```

## Layout
- Config: `~/.claude/channels/lark-channel/.env`
- Sessions: `~/.claude/channels/lark-channel/sessions/by-id,by-scope/`
- Downloaded media: `~/.claude/channels/lark-channel/inbox/`
- Socket: `~/.claude/channels/lark-channel/bridge.sock`

## Design
See `docs/superpowers/specs/2026-04-21-claude-lark-channel-design.md`.

## License
Apache-2.0
