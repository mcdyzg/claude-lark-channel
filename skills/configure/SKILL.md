---
name: configure
description: Configure claude-lark-channel by managing ~/.claude/channels/lark-channel/.env. Use when user asks to configure, setup, or change Lark/Feishu credentials or options.
user-invocable: true
argument-hint: "[<app_id> <app_secret>] | [setup] | [clear]"
allowed-tools:
  - Read
  - Write
  - Bash(ls *)
  - Bash(mkdir *)
  - AskUserQuestion
---

# /lark-channel:configure

Manage configuration stored in `~/.claude/channels/lark-channel/.env`.

Arguments passed: `$ARGUMENTS`

---

## No args — Show current status

1. Read `~/.claude/channels/lark-channel/.env` if present.
2. Display recognized keys grouped and with sensitive values masked.

Mask rules:
- `LARK_APP_ID`: show the first 6 chars, mask the rest with `***`
- `LARK_APP_SECRET`: show first 3 + last 2, mask middle with `***`

Layout:
```
=== Credentials ===
LARK_APP_ID:                cli_a1****
LARK_APP_SECRET:            abc***xy
LARK_DOMAIN:                feishu

=== Scope ===
LARK_CHANNEL_SCOPE_MODE:    thread
LARK_CHANNEL_DEFAULT_WORKDIR: /Users/me/work

=== Whitelist ===
LARK_ALLOWED_USER_IDS:      (not set)
LARK_ALLOWED_CHAT_IDS:      (not set)

=== Pool ===
LARK_CHANNEL_MAX_SCOPES:    50
LARK_CHANNEL_IDLE_TTL_MS:   14400000
LARK_CHANNEL_SWEEP_MS:      300000

=== Timeouts ===
LARK_CHANNEL_HELLO_TIMEOUT_MS: 15000
LARK_CHANNEL_RPC_TIMEOUT_MS:   60000
LARK_CHANNEL_DEDUP_TTL_MS:     60000

=== Acknowledgement ===
LARK_ACK_EMOJI:             MeMeMe

=== Runtime ===
LARK_CHANNEL_LOG_LEVEL:     info
```

Next-step hints:
- If credentials are missing: "Run `/lark-channel:configure <app_id> <app_secret>` to set credentials, or `/lark-channel:configure setup` for full wizard."
- If credentials exist: "Configuration looks good. `/reload-plugins` to apply changes."

---

## Two positional args — Set credentials

`$1 = app_id`, `$2 = app_secret`

1. Create `~/.claude/channels/lark-channel/` if missing.
2. Read existing `.env` (if any) and preserve all other keys.
3. Overwrite only `LARK_APP_ID` and `LARK_APP_SECRET`.
4. Write back atomically.
5. Print masked confirmation + remind `/reload-plugins`.

---

## `setup` — Interactive wizard

Ask in this order via `AskUserQuestion`:

1. `LARK_APP_ID` (required, string)
2. `LARK_APP_SECRET` (required, string)
3. `LARK_DOMAIN` — choose feishu / lark (default: feishu)
4. `LARK_CHANNEL_SCOPE_MODE` — choose chat / thread (default: thread)
5. `LARK_CHANNEL_DEFAULT_WORKDIR` (string, default: `$HOME`)
6. `LARK_ALLOWED_USER_IDS` (optional CSV, default: empty)
7. `LARK_ALLOWED_CHAT_IDS` (optional CSV, default: empty)
8. `LARK_CHANNEL_MAX_SCOPES` (int, default: 50)
9. `LARK_CHANNEL_IDLE_TTL_MS` (int, default: 14400000)

Write `.env` atomically, then print "Configuration saved. Run `/reload-plugins` to apply."

---

## `clear` — Remove configuration

1. Confirm twice via `AskUserQuestion`.
2. If confirmed, delete `~/.claude/channels/lark-channel/.env`.
3. Print "Configuration cleared."
