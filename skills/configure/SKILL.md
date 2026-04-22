---
name: configure
description: Configure claude-lark-channel by managing ~/.claude/channels/lark-channel/config.json. Use when user asks to configure, setup, or change Lark/Feishu credentials or options.
user-invocable: true
argument-hint: "[<app_id> <app_secret>] | [setup] | [debug on|off] | [clear]"
allowed-tools:
  - Read
  - Write
  - Bash(ls *)
  - Bash(mkdir *)
  - Bash(rm *)
  - AskUserQuestion
---

# /lark-channel:configure

Manage configuration stored in `~/.claude/channels/lark-channel/config.json`.

Arguments passed: `$ARGUMENTS`

The config file is a single JSON object with this shape (all fields optional; unlisted fields use defaults):

```json
{
  "debug": false,
  "feishu": {
    "appId": "cli_xxxxx",
    "appSecret": "xxxxx",
    "domain": "feishu"
  },
  "whitelist": {
    "users": [],
    "chats": []
  },
  "scope": {
    "mode": "thread",
    "defaultWorkDir": "/Users/me/work"
  },
  "pool": {
    "maxScopes": 50,
    "idleTtlMs": 14400000,
    "sweepMs": 300000
  },
  "timeouts": {
    "helloMs": 15000,
    "rpcMs": 60000,
    "dedupMs": 60000
  },
  "ackEmoji": "MeMeMe"
}
```

Always write atomically: write to `<path>.tmp` then rename to `<path>`.

---

## No args — Show current status

1. Read `~/.claude/channels/lark-channel/config.json` if present. If absent, treat as empty `{}`.
2. Display the effective config (merging file values over defaults) with sensitive fields masked.

Mask rules:
- `feishu.appId`: show first 6 chars, mask the rest with `***`
- `feishu.appSecret`: show first 3 + last 2, mask middle with `***`

Layout:
```
=== Runtime ===
debug:                   false

=== Credentials ===
feishu.appId:            cli_a1****
feishu.appSecret:        abc***xy
feishu.domain:           feishu

=== Scope ===
scope.mode:              thread
scope.defaultWorkDir:    /Users/me/work

=== Whitelist ===
whitelist.users:         (empty — accept all)
whitelist.chats:         (empty — accept all)

=== Pool ===
pool.maxScopes:          50
pool.idleTtlMs:          14400000
pool.sweepMs:            300000

=== Timeouts ===
timeouts.helloMs:        15000
timeouts.rpcMs:          60000
timeouts.dedupMs:        60000

=== Acknowledgement ===
ackEmoji:                MeMeMe
```

Next-step hints:
- If credentials are missing: "Run `/lark-channel:configure <app_id> <app_secret>` to set credentials, or `/lark-channel:configure setup` for full wizard."
- If credentials exist: "Configuration looks good. `/reload-plugins` to apply changes."

---

## Two positional args — Set credentials

`$1 = app_id`, `$2 = app_secret`

1. Create `~/.claude/channels/lark-channel/` if missing.
2. Read existing `config.json` (if any) and preserve all other fields.
3. Update only `feishu.appId` and `feishu.appSecret`.
4. Write back atomically.
5. Print masked confirmation + remind `/reload-plugins`.

---

## `debug on|off` — Toggle log output

`$1 = "debug"`, `$2 = "on" | "off"`

1. Read existing `config.json` (create empty `{}` if absent).
2. Set `debug = true` (on) or `debug = false` (off).
3. Write atomically.
4. Print `debug=<new value>. Run /reload-plugins to apply.`

Remind user that when `debug=on`, verbose logs write to `~/.claude/channels/lark-channel/logs/debug.log`.

---

## `setup` — Interactive wizard

Ask in this order via `AskUserQuestion`. Skip questions whose answer is blank or chooses the default.

1. `feishu.appId` (required, string)
2. `feishu.appSecret` (required, string)
3. `feishu.domain` — choose `feishu` / `lark` (default: `feishu`)
4. `scope.mode` — choose `chat` / `thread` (default: `thread`)
5. `scope.defaultWorkDir` (string, default: `$HOME`)
6. `whitelist.users` (optional CSV; convert to array; default: empty array)
7. `whitelist.chats` (optional CSV; convert to array; default: empty array)
8. `pool.maxScopes` (int, default: 50)
9. `pool.idleTtlMs` (int, default: 14400000)
10. `debug` — choose `off` / `on` (default: `off`)

Assemble into the JSON shape at the top of this skill, write atomically, then print
"Configuration saved to ~/.claude/channels/lark-channel/config.json. Run `/reload-plugins` to apply."

---

## `clear` — Remove configuration

1. Confirm twice via `AskUserQuestion`.
2. If confirmed, delete `~/.claude/channels/lark-channel/config.json`.
3. Print "Configuration cleared."
