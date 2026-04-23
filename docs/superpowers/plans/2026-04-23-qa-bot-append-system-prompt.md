# Q&A Bot via `--append-system-prompt-file` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Revised 2026-04-23** after Task 1 pre-flight confirmed the CLI exposes `--append-system-prompt-file <path>`. We now delegate file reading to claude itself and master only passes a validated path. See spec for rationale.

**Goal:** Inject a user-configured persona into every spawned child claude via `--append-system-prompt-file`, turning this plugin into a configurable Q&A bot without touching any per-scope or skill machinery.

**Architecture:** Add one optional config field `appendSystemPromptFile` (absolute path). At spawn time, master runs a small pre-check (abs path + `fs.statSync` + `size > 0`) and, if it passes, appends `--append-system-prompt-file '<path>'` to the `claude ...` command built in `src/master/pool.ts`. If any check fails, degrade silently (no flag) with a logger warn/error. Refactor the inline `cmd` string construction into a pure `buildClaudeCmd()` function so the branch logic can be unit-tested. No file reading in master.

**Tech Stack:** TypeScript (ESM), Node ≥ 20, Vitest, existing `Logger` abstraction, existing `shellQuote` helper in `pool.ts`.

**Spec:** `docs/superpowers/specs/2026-04-23-qa-bot-system-prompt-design.md`

---

### Task 1: Pre-flight verify `--append-system-prompt-file` CLI behavior ✅ COMPLETED 2026-04-23

Outcome: `claude --help` shows `--append-system-prompt <prompt>` AND `--append-system-prompt-file <path>`. tmux probe with a persona file ("ALWAYS answer in ALL CAPS, under 10 words") confirmed the flag takes effect end-to-end ("what is two plus two" → "FOUR."). This finding triggered the spec revision to use the `-file` variant — see updated Architecture section above and spec §3.

No commit from this task.

---

### Task 2: Add `appendSystemPromptFile` config field (TDD)

**Files:**
- Create: `tests/shared/config.test.ts`
- Modify: `src/shared/config.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/shared/config.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../../src/shared/config.js';

describe('loadConfig — appendSystemPromptFile', () => {
  let tmpDir: string;
  let cfgPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-cfg-'));
    cfgPath = path.join(tmpDir, 'config.json');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns undefined when no config file exists', () => {
    const cfg = loadConfig(cfgPath);
    expect(cfg.appendSystemPromptFile).toBeUndefined();
  });

  it('returns undefined when field is omitted', () => {
    fs.writeFileSync(cfgPath, JSON.stringify({ debug: false }));
    const cfg = loadConfig(cfgPath);
    expect(cfg.appendSystemPromptFile).toBeUndefined();
  });

  it('returns the configured path when set', () => {
    fs.writeFileSync(cfgPath, JSON.stringify({
      appendSystemPromptFile: '/abs/path/persona.md',
    }));
    const cfg = loadConfig(cfgPath);
    expect(cfg.appendSystemPromptFile).toBe('/abs/path/persona.md');
  });

  it('returns undefined when set to empty string', () => {
    fs.writeFileSync(cfgPath, JSON.stringify({
      appendSystemPromptFile: '',
    }));
    const cfg = loadConfig(cfgPath);
    expect(cfg.appendSystemPromptFile).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

Run:
```bash
npx vitest run tests/shared/config.test.ts
```

Expected: FAIL — `appendSystemPromptFile` is not a property on the returned `AppConfig` (TS compile error or `undefined` on all four cases; the "returns the configured path" case will fail).

- [ ] **Step 3: Extend `ConfigFile` interface**

Edit `src/shared/config.ts`. Find the `ConfigFile` interface (lines 11-37) and add the new optional field immediately before `ackEmoji`:

```ts
export interface ConfigFile {
  debug?: boolean;
  feishu?: {
    appId?: string;
    appSecret?: string;
    domain?: 'feishu' | 'lark';
  };
  whitelist?: {
    users?: string[];
    chats?: string[];
  };
  scope?: {
    mode?: SessionScope;
    defaultWorkDir?: string;
  };
  pool?: {
    maxScopes?: number;
    idleTtlMs?: number;
    sweepMs?: number;
  };
  timeouts?: {
    helloMs?: number;
    rpcMs?: number;
    dedupMs?: number;
  };
  appendSystemPromptFile?: string;
  ackEmoji?: string;
}
```

- [ ] **Step 4: Extend `AppConfig` interface**

In the same file, find `AppConfig` (lines 39-69) and add the field in the "运行时开关" block:

```ts
export interface AppConfig {
  // 运行时开关
  debug: boolean;
  appendSystemPromptFile: string | undefined;
  // Feishu 凭据
  appId: string;
  // ... rest unchanged
```

- [ ] **Step 5: Wire it in `loadConfig`**

In `loadConfig` (returned object, around line 110-132), add the new field right after `debug: file.debug === true,`:

```ts
return {
  debug: file.debug === true,
  appendSystemPromptFile:
    typeof file.appendSystemPromptFile === 'string' && file.appendSystemPromptFile.length > 0
      ? file.appendSystemPromptFile
      : undefined,
  appId: feishu.appId ?? '',
  // ... rest unchanged
```

Rationale: empty string should be indistinguishable from unset, matching the spec's "文件为空 / 只含空白 → 等同于未配置" rule at the config layer too.

- [ ] **Step 6: Run tests to confirm pass**

Run:
```bash
npx vitest run tests/shared/config.test.ts
```

Expected: all 4 tests PASS.

- [ ] **Step 7: Typecheck**

Run:
```bash
npm run typecheck
```

Expected: clean (no errors).

- [ ] **Step 8: Commit**

```bash
git add src/shared/config.ts tests/shared/config.test.ts
git commit -m "feat(config): add optional appendSystemPromptFile field

Reads an absolute path from config.json. Empty string is normalized
to undefined. Not yet consumed by the spawn path (follow-up task)."
```

---

### Task 3: Extract `buildClaudeCmd()` pure function from `spawnTmux` (refactor, no behavior change, TDD)

**Files:**
- Create: `tests/master/spawn-cmd.test.ts`
- Modify: `src/master/pool.ts`

- [ ] **Step 1: Write failing tests pinning current behavior**

Create `tests/master/spawn-cmd.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildClaudeCmd } from '../../src/master/pool.js';

describe('buildClaudeCmd', () => {
  it('base command without resume, without prompt', () => {
    expect(buildClaudeCmd({})).toBe(
      "claude --dangerously-load-development-channels plugin:lark-channel@claude-lark-channel --dangerously-skip-permissions"
    );
  });

  it('includes --resume when resumeSessionId is set', () => {
    expect(buildClaudeCmd({ resumeSessionId: 'abc-123' })).toBe(
      "claude --dangerously-load-development-channels plugin:lark-channel@claude-lark-channel --dangerously-skip-permissions --resume 'abc-123'"
    );
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

Run:
```bash
npx vitest run tests/master/spawn-cmd.test.ts
```

Expected: FAIL — `buildClaudeCmd` does not exist.

- [ ] **Step 3: Add the pure function to `pool.ts`**

Edit `src/master/pool.ts`. At the very bottom of the file, **after** the existing `shellQuote` function (around line 363), add:

```ts
export interface BuildClaudeCmdOpts {
  resumeSessionId?: string;
}

/**
 * 构造 spawned child claude 的 shell 命令字符串。纯函数、可单测。
 * Task 4 会在此基础上加 appendSystemPromptFile 分支。
 */
export function buildClaudeCmd(opts: BuildClaudeCmdOpts): string {
  const channelArg = '--dangerously-load-development-channels plugin:lark-channel@claude-lark-channel';
  const permArg = '--dangerously-skip-permissions';
  const parts: string[] = ['claude', channelArg, permArg];
  if (opts.resumeSessionId) {
    parts.push(`--resume ${shellQuote(opts.resumeSessionId)}`);
  }
  return parts.join(' ');
}
```

- [ ] **Step 4: Replace inline cmd construction in `spawnTmux`**

Find `spawnTmux` (lines 224-267). Replace the block from `const resumeArg = ...` through `const cmd = ...` (lines 226-241) with:

```ts
const cmd = buildClaudeCmd({
  resumeSessionId: session.claudeSessionId || undefined,
});
```

Also delete the now-unused comment block that described `channelArg` / `permArg` — it's been absorbed into `buildClaudeCmd`.

- [ ] **Step 5: Run unit tests to confirm pass**

Run:
```bash
npx vitest run tests/master/spawn-cmd.test.ts
```

Expected: both tests PASS.

- [ ] **Step 6: Run full test suite to verify no regression**

Run:
```bash
npm test
```

Expected: all previously-green tests still PASS (baseline was 58 across 8 files; now ~62 across ~10 files after Tasks 2 and 3).

- [ ] **Step 7: Typecheck**

Run:
```bash
npm run typecheck
```

Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add src/master/pool.ts tests/master/spawn-cmd.test.ts
git commit -m "refactor(pool): extract buildClaudeCmd pure function

No behavior change. The spawn command string is now built by a
small exported function so the flag composition can be unit-tested.
Prepares for --append-system-prompt-file injection."
```

---

### Task 4: Inject `--append-system-prompt-file` flag + path pre-check in `spawnTmux` (TDD)

**Files:**
- Modify: `tests/master/spawn-cmd.test.ts`
- Modify: `src/master/pool.ts`

- [ ] **Step 1: Write failing tests for the new flag behavior**

Append to `tests/master/spawn-cmd.test.ts`:

```ts
describe('buildClaudeCmd — appendSystemPromptFile', () => {
  it('adds --append-system-prompt-file when path is provided', () => {
    const cmd = buildClaudeCmd({ appendSystemPromptFile: '/abs/path/persona.md' });
    expect(cmd).toContain("--append-system-prompt-file '/abs/path/persona.md'");
  });

  it('single-quote-escapes paths with special characters', () => {
    const cmd = buildClaudeCmd({ appendSystemPromptFile: "/tmp/it's here.md" });
    // shellQuote escapes ' as '\'' — so the arg becomes '/tmp/it'\''s here.md'
    expect(cmd).toContain(`--append-system-prompt-file '/tmp/it'\\''s here.md'`);
  });

  it('omits the flag when path is empty string', () => {
    const cmd = buildClaudeCmd({ appendSystemPromptFile: '' });
    expect(cmd).not.toContain('--append-system-prompt');
  });

  it('omits the flag when path is undefined', () => {
    const cmd = buildClaudeCmd({});
    expect(cmd).not.toContain('--append-system-prompt');
  });

  it('combines with --resume (append before resume)', () => {
    const cmd = buildClaudeCmd({
      resumeSessionId: 'sid-1',
      appendSystemPromptFile: '/abs/persona.md',
    });
    expect(cmd).toContain("--append-system-prompt-file '/abs/persona.md'");
    expect(cmd).toContain("--resume 'sid-1'");
    // Ordering: append-system-prompt-file should come before --resume for readability
    expect(cmd.indexOf('--append-system-prompt-file')).toBeLessThan(cmd.indexOf('--resume'));
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

Run:
```bash
npx vitest run tests/master/spawn-cmd.test.ts
```

Expected: the new 5 tests FAIL (old 2 still pass).

- [ ] **Step 3: Implement the flag in `buildClaudeCmd`**

Edit `src/master/pool.ts`. Extend the `BuildClaudeCmdOpts` interface and the function body:

```ts
export interface BuildClaudeCmdOpts {
  resumeSessionId?: string;
  appendSystemPromptFile?: string;
}

export function buildClaudeCmd(opts: BuildClaudeCmdOpts): string {
  const channelArg = '--dangerously-load-development-channels plugin:lark-channel@claude-lark-channel';
  const permArg = '--dangerously-skip-permissions';
  const parts: string[] = ['claude', channelArg, permArg];
  if (opts.appendSystemPromptFile && opts.appendSystemPromptFile.length > 0) {
    parts.push(`--append-system-prompt-file ${shellQuote(opts.appendSystemPromptFile)}`);
  }
  if (opts.resumeSessionId) {
    parts.push(`--resume ${shellQuote(opts.resumeSessionId)}`);
  }
  return parts.join(' ');
}
```

- [ ] **Step 4: Run unit tests to confirm pass**

Run:
```bash
npx vitest run tests/master/spawn-cmd.test.ts
```

Expected: all 7 tests PASS.

- [ ] **Step 5: Wire the path pre-check into `spawnTmux`**

Edit `src/master/pool.ts`. `fs` and `path` are already imported at the top. In `spawnTmux`, the `const cmd = buildClaudeCmd({...})` line from Task 3 needs to gain a second opt. Replace it with:

```ts
const appendSystemPromptFile = this.resolveAppendSystemPromptFile();
const cmd = buildClaudeCmd({
  resumeSessionId: session.claudeSessionId || undefined,
  appendSystemPromptFile,
});
```

Then add a new private method on the `TmuxPool` class, placed next to other helpers (e.g. right above `killEntry`):

```ts
/**
 * 校验 config.appendSystemPromptFile 是否能作为 --append-system-prompt-file
 * 的值传给 child claude。任何检查失败都降级为 undefined（spawn 继续、不加 flag），
 * 避免 child 启动时因为 bad 路径立即退出 → 触发 hello-timeout 重试死循环。
 *
 * 不读取文件内容，只做存在性与大小检查；内容解析由 claude 进程自己完成。
 */
private resolveAppendSystemPromptFile(): string | undefined {
  const file = this.deps.config.appendSystemPromptFile;
  if (!file) return undefined;
  if (!path.isAbsolute(file)) {
    this.deps.logger.error(`appendSystemPromptFile must be absolute, got: ${file}; ignoring`);
    return undefined;
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch (err: any) {
    this.deps.logger.error(`appendSystemPromptFile stat failed path=${file} err=${err?.message ?? err}; ignoring`);
    return undefined;
  }
  if (!stat.isFile()) {
    this.deps.logger.error(`appendSystemPromptFile is not a regular file path=${file}; ignoring`);
    return undefined;
  }
  if (stat.size === 0) {
    this.deps.logger.warn(`appendSystemPromptFile is empty path=${file}; ignoring`);
    return undefined;
  }
  this.deps.logger.debug(`appendSystemPromptFile OK path=${file} bytes=${stat.size}`);
  return file;
}
```

- [ ] **Step 6: Run full test suite**

Run:
```bash
npm test
```

Expected: all tests PASS (7 in spawn-cmd.test.ts + 4 in config.test.ts + existing 58 = ~69 total).

- [ ] **Step 7: Typecheck**

Run:
```bash
npm run typecheck
```

Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add src/master/pool.ts tests/master/spawn-cmd.test.ts
git commit -m "feat(pool): inject --append-system-prompt-file from config

spawnTmux now validates config.appendSystemPromptFile (abs path +
stat + size>0) and passes the path to buildClaudeCmd. Non-absolute /
missing / wrong-type / empty all degrade silently (logger warn/error,
no flag), preventing a bad config from trapping the child in a
startup-failure retry loop.

Master does not read file content — that is delegated to claude via
--append-system-prompt-file <path>. Turns the plugin into a
configurable Q&A bot.

Persona changes take effect on next spawn of an affected scope;
running tmux sessions are not hot-reloaded."
```

---

### Task 5: Update `config.json.example` and docs

**Files:**
- Modify: `config.json.example`
- Modify: `CLAUDE.md`
- Modify: `README.md`

- [ ] **Step 1: Add field to config example**

Edit `config.json.example`. Add the new field between `timeouts` and `ackEmoji`:

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
    "defaultWorkDir": ""
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
  "appendSystemPromptFile": "",
  "ackEmoji": "MeMeMe"
}
```

Empty string is the documented "unset" value (handled by `loadConfig` as undefined).

- [ ] **Step 2: Add a note to `CLAUDE.md`**

Edit `CLAUDE.md`. Find the "Conventions" bullet:

```
- Config lives at `~/.claude/channels/lark-channel/config.json` (JSON, not .env). See `config.json.example` and `src/shared/config.ts` for shape
```

Replace that line with:

```
- Config lives at `~/.claude/channels/lark-channel/config.json` (JSON, not .env). See `config.json.example` and `src/shared/config.ts` for shape. `appendSystemPromptFile` (optional absolute path) is validated at **each spawn** and passed to the child claude via `--append-system-prompt-file`; claude reads the file itself on startup. Changing the file does **not** affect running tmux sessions — kill the affected `lark-<id>` session (or wait for idle sweep) to pick up new content.
```

- [ ] **Step 3: Add a "Using as a Q&A bot" section to `README.md`**

Edit `README.md`. After the existing "## Configuration" section (which ends at line 58 — the `Changes take effect after /reload-plugins.` line), insert a new section:

```markdown
## Using as a Q&A bot

To make every spawned child claude adopt a specific persona (e.g. "you are a Q&A assistant for project X, always answer in Chinese, never modify files"), point the plugin at a prompt file:

```json
{
  "appendSystemPromptFile": "/absolute/path/to/persona.md"
}
```

The file is passed to each spawned child claude via `--append-system-prompt-file`; claude reads it and appends the content to its default system prompt. Keep it focused on **persona / always-on constraints** — project-specific knowledge belongs in the target repo's `CLAUDE.md` / `.claude/skills/`, not in this file.

**Reload semantics:** changing the prompt file does not retroactively affect running tmux sessions. To pick up new content for a scope: `tmux kill-session -t lark-<scopeId>` (next inbound message will respawn with the new prompt), or wait for the idle-TTL sweep.

**Caveats:** the path must be absolute; missing / wrong-type / empty (size 0) files are ignored with a logger warn/error (master stays up). Persona size ~1-2 KB is a reasonable target; larger files are accepted but eat context budget on every turn.
```

- [ ] **Step 4: Verify files render / no markdown breakage**

Run:
```bash
npm run typecheck
```

Expected: clean (typecheck is a cheap smoke that nothing else got broken).

- [ ] **Step 5: Commit**

```bash
git add config.json.example CLAUDE.md README.md
git commit -m "docs: document appendSystemPromptFile + Q&A bot usage

Adds the field to config.json.example, notes reload semantics in
CLAUDE.md, and adds a new 'Using as a Q&A bot' section to README
covering configuration, scope (persona vs knowledge), and reload
behavior."
```

---

### Task 6: Add smoke-test scenario

**Files:**
- Modify: `scripts/smoke-test.md`

- [ ] **Step 1: Append a new E2E scenario**

Edit `scripts/smoke-test.md`. At the bottom of the file (after line 40, the last regression scenario), append:

```markdown

## Append system prompt (spec 2026-04-23)

- [ ] **Persona injection**: create `/tmp/lark-persona-probe.md` with content `Always answer in pig latin. Do not modify files.` Set `appendSystemPromptFile` to that path in `~/.claude/channels/lark-channel/config.json`. Kill any existing `lark-*` tmux sessions. `/reload-plugins`. DM the bot `What is 2 + 2?`. Expect: reply is in pig-latin-ish English (e.g. "ourfay"). `tmux attach -t lark-<id>` and inspect the pane — the inbound user message should be plain text (no leaked system prompt content).
- [ ] **Reload requires scope restart**: with the persona still configured, edit `/tmp/lark-persona-probe.md` to say `Always answer in ALL CAPS.` Without killing tmux, DM the bot again. Expect: reply is STILL pig-latin (proving the running session did not reload). Now `tmux kill-session -t lark-<id>`, DM again → new reply is all caps.
- [ ] **Missing file degrades silently**: set `appendSystemPromptFile` to `/tmp/does-not-exist.md`. `/reload-plugins`, kill any `lark-*` sessions. DM the bot. Expect: reply is normal (no persona). `grep appendSystemPromptFile ~/.claude/channels/lark-channel/logs/debug.log` (requires `debug: true`) shows a `stat failed` error line; master is still up; child claude DID start (proving pre-check prevented bad path reaching CLI).
- [ ] **Relative path rejected**: set `appendSystemPromptFile` to `persona.md` (no leading `/`). DM the bot. Expect: normal reply + logger error `appendSystemPromptFile must be absolute`.
- [ ] **Empty file treated as unset**: `touch /tmp/empty-persona.md`; point config at it. DM the bot. Expect: normal reply + logger warn `appendSystemPromptFile is empty`.
- [ ] **Directory rejected**: point `appendSystemPromptFile` at a directory path (e.g. `/tmp`). Expect: normal reply + logger error `is not a regular file`.
```

- [ ] **Step 2: Commit**

```bash
git add scripts/smoke-test.md
git commit -m "docs(smoke): add appendSystemPromptFile scenarios

Covers persona injection, reload-requires-restart semantics, and the
three degrade paths (missing file, relative path, empty file)."
```

---

## Done criteria

- All vitest tests pass (baseline 58 + 4 config + 7 spawn-cmd = 69)
- `npm run typecheck` clean
- Five commits landed: config field, refactor, flag injection, docs, smoke-test (plus pre-flight verify which is no-commit)
- Manual smoke: persona visible in bot replies after setting `appendSystemPromptFile`

## Out of scope reminders (from spec)

Do **not** add in this plan — save for future if needed:
- Per-scope prompts (different persona per chat/thread)
- Hot-reload into running tmux sessions
- Built-in default persona template
- Prompt template variables (e.g. `{{workDir}}`)
