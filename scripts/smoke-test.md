# claude-lark-channel E2E smoke checklist

Manual checks. Use a test Feishu app with a dedicated bot.

## Prerequisites
- [ ] `tmux -V` ≥ 3.2
- [ ] `jq --version` present
- [ ] `claude --version` works and claude.ai login is active
- [ ] Feishu bot has scopes: `im:message`, `im:message:send_as_bot`, `im:message:readonly`

## Setup
1. Install: `/plugin marketplace add <repo>` + `/plugin install lark-channel@claude-lark-channel`
2. `/lark-channel:configure setup` — fill in credentials
3. `/reload-plugins` — master starts

## Checks
- [ ] **P2P text**: DM the bot "hello" — receive a reply within 30s on first scope (cold start)
- [ ] **Group @mention**: `@bot ping` in a group — reply lands in group
- [ ] **Group no-@mention**: send a plain group message with no mention — bot ignores it
- [ ] **Image**: `@bot 这张图什么` + image — reply references image content (Claude used Read on image_path)
- [ ] **File attachment**: `@bot 读一下这个` + file — Claude should use download_attachment and reply
- [ ] **Thread isolation**: open two threads in same chat, chat independent topics — no cross-contamination
- [ ] **Thread root background**: in a thread whose root was not the current message, verify first reply references the root topic
- [ ] **LRU resume**: idle 4h+ (or temporarily lower `LARK_CHANNEL_IDLE_TTL_MS` to 60s) — after reap, send new message; continuation should feel seamless
- [ ] **Dedup**: copy-paste same message quickly twice — only one reply
- [ ] **Whitelist**: add a restricted user list; message from a non-listed user is silently ignored
- [ ] **Host quit**: close host Claude Code — `tmux ls` shows no `lark-*` sessions left

## Cleanup
- `tmux kill-server` (or just `tmux ls | grep ^lark- | awk -F: '{print $1}' | xargs -I {} tmux kill-session -t {}`)
- Delete `~/.claude/channels/lark-channel/sessions/` to reset all scope state
