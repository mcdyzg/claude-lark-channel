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

## Thread / parent context images (spec 2026-04-22)

- [ ] **Thread root image**: in a group chat (whitelisted), create a new thread by posting an image + text caption as the thread root. In the same thread, reply `@bot 分析下这张图` (no quote-reply). Expect: Claude's reply references the image's content (proving it read `image_path` from the background frame).
- [ ] **Quote-reply with image**: in any chat, find a prior message containing an image, quote-reply it and include `@bot 看一下这张图`. Expect: Claude's reply references the parent image.
- [ ] **Quote-reply with text only**: quote-reply a text-only prior message and `@bot`. Expect: Claude reply references the parent's text (via `parent_content`).
- [ ] **Regression — thread without images**: start a new thread with text-only root, `@bot` there. Expect: unchanged behaviour (background frame with text, no `image_path` meta).
- [ ] **Regression — plain P2P, no parent**: DM the bot plain text. Expect: unchanged behaviour (no parent_* meta).

## Append system prompt (spec 2026-04-23)

- [ ] **Persona injection**: create `/tmp/lark-persona-probe.md` with content `Always answer in pig latin. Do not modify files.` Set `appendSystemPromptFile` to that path in `~/.claude/channels/lark-channel/config.json`. Kill any existing `lark-*` tmux sessions. `/reload-plugins`. DM the bot `What is 2 + 2?`. Expect: reply is in pig-latin-ish English (e.g. "ourfay"). `tmux attach -t lark-<id>` and inspect the pane — the inbound user message should be plain text (no leaked system prompt content).
- [ ] **Reload requires scope restart**: with the persona still configured, edit `/tmp/lark-persona-probe.md` to say `Always answer in ALL CAPS.` Without killing tmux, DM the bot again. Expect: reply is STILL pig-latin (proving the running session did not reload). Now `tmux kill-session -t lark-<id>`, DM again → new reply is all caps.
- [ ] **Missing file degrades silently**: set `appendSystemPromptFile` to `/tmp/does-not-exist.md`. `/reload-plugins`, kill any `lark-*` sessions. DM the bot. Expect: reply is normal (no persona). `grep appendSystemPromptFile ~/.claude/channels/lark-channel/logs/debug.log` (requires `debug: true`) shows a `stat failed` error line; master is still up; child claude DID start (proving pre-check prevented bad path reaching CLI).
- [ ] **Relative path rejected**: set `appendSystemPromptFile` to `persona.md` (no leading `/`). DM the bot. Expect: normal reply + logger error `appendSystemPromptFile must be absolute`.
- [ ] **Empty file treated as unset**: `touch /tmp/empty-persona.md`; point config at it. DM the bot. Expect: normal reply + logger warn `appendSystemPromptFile is empty`.
- [ ] **Directory rejected**: point `appendSystemPromptFile` at a directory path (e.g. `/tmp`). Expect: normal reply + logger error `is not a regular file`.
