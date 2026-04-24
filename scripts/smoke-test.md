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

**Prerequisites for this section:**
- `debug: true` in config.json (scenarios 3–6 depend on `logs/debug.log` — the logger is a complete no-op when `debug:false`)
- Between each scenario: update config, then `/reload-plugins` (restarts master) AND kill any leftover `lark-*` tmux sessions (`tmux ls | grep ^lark- | awk -F: '{print $1}' | xargs -I {} tmux kill-session -t {}`). Otherwise a stale child spawned with the previous config will keep replying and the new config is never exercised.
- Find `<id>` in commands below via `tmux ls | grep ^lark-`

Scenarios:

- [ ] **Persona injection**: create `/tmp/lark-persona-probe.md` with content `Always answer in pig latin.` Set `appendSystemPromptFile` to that path in `~/.claude/channels/lark-channel/config.json`. Kill any existing `lark-*` tmux sessions. `/reload-plugins`. DM the bot `What is 2 + 2?`. Expect: reply is in pig-latin-ish English (e.g. "ourfay"). `tmux attach -t lark-<id>` and inspect the pane — the inbound user message should be plain text (no leaked system prompt content).
- [ ] **Reload requires scope restart**: with the persona still configured, edit `/tmp/lark-persona-probe.md` to say `Always answer in ALL CAPS.` Without killing tmux, DM the bot again. Expect: reply is STILL pig-latin (proving the running session did not reload). Now `tmux kill-session -t lark-<id>`, DM again → new reply is all caps.
- [ ] **Missing file degrades silently**: set `appendSystemPromptFile` to `/tmp/does-not-exist.md`. `/reload-plugins`, kill any `lark-*` sessions. DM the bot. Expect: reply is normal (no persona). Verify pre-check actually prevented the bad path from reaching the CLI: (a) `tmux ls | grep ^lark-` shows a live session, (b) `tmux attach -t lark-<id>` shows an active claude prompt (not a crashed pane / exit message), (c) `grep appendSystemPromptFile ~/.claude/channels/lark-channel/logs/debug.log` shows a `stat failed` error line.
- [ ] **Relative path rejected**: set `appendSystemPromptFile` to `persona.md` (no leading `/`). `/reload-plugins`, kill any `lark-*` sessions. DM the bot. Expect: normal reply + `grep appendSystemPromptFile logs/debug.log` shows `appendSystemPromptFile must be absolute`.
- [ ] **Empty file treated as unset**: `touch /tmp/empty-persona.md`; point config at it. `/reload-plugins`, kill any `lark-*` sessions. DM the bot. Expect: normal reply + `grep appendSystemPromptFile logs/debug.log` shows `appendSystemPromptFile is empty`.
- [ ] **Directory rejected**: point `appendSystemPromptFile` at a directory path (e.g. `/tmp`). `/reload-plugins`, kill any `lark-*` sessions. DM the bot. Expect: normal reply + `grep appendSystemPromptFile logs/debug.log` shows `is not a regular file`.

**Cleanup for this section:** `rm -f /tmp/lark-persona-probe.md /tmp/empty-persona.md`; unset `appendSystemPromptFile` in `~/.claude/channels/lark-channel/config.json` (set to `""` or delete the key); `/reload-plugins`.

## Auto-takeover on master startup (spec 2026-04-24)

**Prerequisites for this section:**
- `debug: true` in config.json (ensures handoff progress lines also land in debug.log, not just stderr)
- You can start masters via `npm run start` from either the workspace or the plugin cache dir

Scenarios:

- [ ] **Happy path — automatic takeover between two v0.1.2+ masters**: start a master (terminal 1: `cd /path/to/workspace && npm run start`). Confirm stderr shows `[lark-channel] master vX ready (pid=P1)`. Now start a second master (terminal 2: same command). Expect: terminal 2 prints `[lark-channel] replacing old master pid=P1 — SIGTERM` then `[lark-channel] master vX ready (pid=P2)` within 2 seconds, and terminal 1 prints `shutdown complete` and exits 0. `tmux ls | grep lark-` children (if any) persist unharmed.
- [ ] **Non-our-master refusal**: with no master running, write a fake lock pointing at your shell (`echo $$ > ~/.claude/channels/lark-channel/master-*.lock`). Start a master: `npm run start`. Expect: stderr shows the multi-line `[lark-channel] ✗ cannot acquire lock ...` error recipe, exit code 1, and your shell's PID is **not** killed. Clean up: `rm ~/.claude/channels/lark-channel/master-*.lock`.
- [ ] **Stale-lock self-heal** (not new behavior, regression check): write a lock with a dead PID (`echo 99999 > ~/.claude/channels/lark-channel/master-*.lock` — assuming PID 99999 is not in use; verify with `ps -p 99999`). Start a master. Expect: normal startup (lock is stolen by existing `lock.ts` logic), no takeover attempt, no `[lark-channel] replacing ...` line in stderr.
- [ ] **Error visibility with debug=false**: set `"debug": false` in config.json. Trigger a known error (e.g. point `appendSystemPromptFile` at a directory like `/tmp`). Start master. Expect: terminal stderr shows the `resolveAppendSystemPromptFile ... is not a regular file` error line on first spawn (not silent); `~/.claude/channels/lark-channel/logs/debug.log` file is **NOT** created.
- [ ] **Version banner accuracy**: `cat package.json | grep version` noting the value `vX.Y.Z`. Start master. Expect: stderr shows `[lark-channel] master v<X.Y.Z> ready (pid=...)` with the exact string from package.json (not a hardcoded number).
