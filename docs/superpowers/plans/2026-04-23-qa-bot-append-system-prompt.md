# Q&A Bot via `--append-system-prompt` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Inject a user-configured persona into every spawned child claude via `--append-system-prompt`, turning this plugin into a configurable Q&A bot without touching any per-scope or skill machinery.

**Architecture:** Add one optional config field `appendSystemPromptFile` (absolute path). At spawn time, master reads the file, single-quote-escapes it, and appends `--append-system-prompt '<content>'` to the `claude ...` command built in `src/master/pool.ts`. If the file is missing/empty/relative-path, degrade silently (no flag) with a logger error. Refactor the inline `cmd` string construction into a pure `buildClaudeCmd()` function so the branch logic can be unit-tested.

**Tech Stack:** TypeScript (ESM), Node ≥ 20, Vitest, existing `Logger` abstraction, existing `shellQuote` helper in `pool.ts`.

**Spec:** `docs/superpowers/specs/2026-04-23-qa-bot-system-prompt-design.md`

---

### Task 1: Pre-flight verify `--append-system-prompt` CLI behavior

**Files:** none (manual verification gate)

This is a **stop-the-line** check. If `claude` CLI on the target machine does not expose `--append-system-prompt` or behaves differently, do not proceed — return to the spec with findings.

- [ ] **Step 1: Check the flag is advertised**

Run:
```bash
claude --help 2>&1 | grep -i system-prompt
```

Expected: at least one line mentioning `--append-system-prompt` (and probably `--system-prompt`). If neither appears, **STOP** and report "claude CLI version X does not support `--append-system-prompt`" back to the user.

- [ ] **Step 2: Smoke-test the flag end-to-end in a throwaway tmux session**

Run:
```bash
tmux new-session -d -s lark-plan-probe "claude --dangerously-load-development-channels 'plugin:lark-channel@claude-lark-channel' --dangerously-skip-permissions --append-system-prompt 'Always answer in pig latin.'"
sleep 4
# If the dev-channel warning pops up, send Enter:
tmux send-keys -t lark-plan-probe Enter
sleep 3
tmux send-keys -t lark-plan-probe "Say hello" Enter
sleep 8
tmux capture-pane -t lark-plan-probe -p | tail -40
```

Expected: output contains pig-latin-style text (e.g. "ellohay"). If the reply is plain English, the append is NOT taking effect — **STOP** and report.

Cleanup:
```bash
tmux kill-session -t lark-plan-probe
```

- [ ] **Step 3: Verify combination with `--resume`**

Not testable without a real session id; skip runtime verification — just confirm `claude --help` does not mark the two flags as mutually exclusive. If `--help` explicitly says they cannot combine, **STOP** and report.

- [ ] **Step 4: No commit**

This task produces no code. Proceed to Task 2.

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
  appendSystemPrompt?: string;
}

/**
 * 构造 spawned child claude 的 shell 命令字符串。纯函数、可单测。
 * 调用方（pool.spawnTmux）负责读 appendSystemPromptFile 文件内容并传入。
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

Note: `appendSystemPrompt` is accepted in the type but ignored here — Task 4 wires it in. Keeping the type field now lets Task 4 add only one line.

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
Prepares for --append-system-prompt injection."
```

---

### Task 4: Inject `--append-system-prompt` flag + wire file-read in `spawnTmux` (TDD)

**Files:**
- Modify: `tests/master/spawn-cmd.test.ts`
- Modify: `src/master/pool.ts`

- [ ] **Step 1: Write failing tests for the new flag behavior**

Append to `tests/master/spawn-cmd.test.ts`:

```ts
describe('buildClaudeCmd — appendSystemPrompt', () => {
  it('adds --append-system-prompt when content is non-empty', () => {
    const cmd = buildClaudeCmd({ appendSystemPrompt: 'You are a QA bot.' });
    expect(cmd).toContain("--append-system-prompt 'You are a QA bot.'");
  });

  it('single-quote-escapes content with embedded single quotes', () => {
    const cmd = buildClaudeCmd({ appendSystemPrompt: "don't be generic" });
    // shellQuote escapes ' as '\'' — so the arg becomes 'don'\''t be generic'
    expect(cmd).toContain(`--append-system-prompt 'don'\\''t be generic'`);
  });

  it('preserves multi-line content inside single quotes', () => {
    const cmd = buildClaudeCmd({ appendSystemPrompt: 'line one\nline two' });
    expect(cmd).toContain("--append-system-prompt 'line one\nline two'");
  });

  it('omits the flag when content is empty string', () => {
    const cmd = buildClaudeCmd({ appendSystemPrompt: '' });
    expect(cmd).not.toContain('--append-system-prompt');
  });

  it('omits the flag when content is undefined', () => {
    const cmd = buildClaudeCmd({});
    expect(cmd).not.toContain('--append-system-prompt');
  });

  it('combines with --resume (append before resume)', () => {
    const cmd = buildClaudeCmd({
      resumeSessionId: 'sid-1',
      appendSystemPrompt: 'persona',
    });
    expect(cmd).toContain("--append-system-prompt 'persona'");
    expect(cmd).toContain("--resume 'sid-1'");
    // Ordering: append-system-prompt should come before --resume for readability
    expect(cmd.indexOf('--append-system-prompt')).toBeLessThan(cmd.indexOf('--resume'));
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

Run:
```bash
npx vitest run tests/master/spawn-cmd.test.ts
```

Expected: the new 6 tests FAIL (old 2 still pass).

- [ ] **Step 3: Implement the flag in `buildClaudeCmd`**

Edit `src/master/pool.ts`. In the `buildClaudeCmd` function added in Task 3, insert the append-system-prompt branch **before** the `--resume` branch:

```ts
export function buildClaudeCmd(opts: BuildClaudeCmdOpts): string {
  const channelArg = '--dangerously-load-development-channels plugin:lark-channel@claude-lark-channel';
  const permArg = '--dangerously-skip-permissions';
  const parts: string[] = ['claude', channelArg, permArg];
  if (opts.appendSystemPrompt && opts.appendSystemPrompt.length > 0) {
    parts.push(`--append-system-prompt ${shellQuote(opts.appendSystemPrompt)}`);
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

Expected: all 8 tests PASS.

- [ ] **Step 5: Wire the file read into `spawnTmux`**

Edit `src/master/pool.ts`. At the top of the file, the `import path from 'node:path'` already exists. Ensure `fs` is also imported (`import fs from 'node:fs';` — already present at line 2).

In `spawnTmux`, the `const cmd = buildClaudeCmd({...})` line from Task 3 needs to gain a second opt. Replace it with:

```ts
const appendSystemPrompt = this.readAppendSystemPrompt();
const cmd = buildClaudeCmd({
  resumeSessionId: session.claudeSessionId || undefined,
  appendSystemPrompt,
});
```

Then add a new private method on the `TmuxPool` class, placed next to other helpers (e.g. right above `killEntry`):

```ts
/**
 * 读取 config.appendSystemPromptFile 对应的文件。
 * 任何失败路径都降级为 undefined（spawn 会继续，不加 flag），并 log error。
 * 不抛异常，不阻塞 master。
 */
private readAppendSystemPrompt(): string | undefined {
  const file = this.deps.config.appendSystemPromptFile;
  if (!file) return undefined;
  if (!path.isAbsolute(file)) {
    this.deps.logger.error(`appendSystemPromptFile must be absolute, got: ${file}; ignoring`);
    return undefined;
  }
  let content: string;
  try {
    content = fs.readFileSync(file, 'utf-8');
  } catch (err: any) {
    this.deps.logger.error(`appendSystemPromptFile read failed path=${file} err=${err?.message ?? err}; ignoring`);
    return undefined;
  }
  if (content.trim().length === 0) {
    this.deps.logger.warn(`appendSystemPromptFile is empty/whitespace-only path=${file}; ignoring`);
    return undefined;
  }
  this.deps.logger.debug(`appendSystemPromptFile loaded path=${file} bytes=${content.length}`);
  return content;
}
```

- [ ] **Step 6: Run full test suite**

Run:
```bash
npm test
```

Expected: all tests PASS (8 in spawn-cmd.test.ts + 4 in config.test.ts + existing 58 = ~70 total).

- [ ] **Step 7: Typecheck**

Run:
```bash
npm run typecheck
```

Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add src/master/pool.ts tests/master/spawn-cmd.test.ts
git commit -m "feat(pool): inject --append-system-prompt from config file

spawnTmux now reads config.appendSystemPromptFile at spawn time and
passes the content to buildClaudeCmd. Missing/unreadable/empty/
non-absolute-path all degrade silently (logger error, no flag).

Effect: operators can point the config at a persona .md and every
spawned child claude will receive that persona on top of its default
system prompt. Turns the plugin into a configurable Q&A bot.

Prompt changes take effect on next spawn of an affected scope; running
tmux sessions are not hot-reloaded."
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
- Config lives at `~/.claude/channels/lark-channel/config.json` (JSON, not .env). See `config.json.example` and `src/shared/config.ts` for shape. `appendSystemPromptFile` (optional absolute path) gets read at **each spawn** and injected into the child claude via `--append-system-prompt`; changing the file does **not** affect running tmux sessions — kill the affected `lark-<id>` session (or wait for idle sweep) to pick up new content.
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

The file content is appended to claude's default system prompt via `--append-system-prompt` when each per-scope tmux session is spawned. Keep it focused on **persona / always-on constraints** — project-specific knowledge belongs in the target repo's `CLAUDE.md` / `.claude/skills/`, not in this file.

**Reload semantics:** changing the prompt file does not retroactively affect running tmux sessions. To pick up new content for a scope: `tmux kill-session -t lark-<scopeId>` (next inbound message will respawn with the new prompt), or wait for the idle-TTL sweep.

**Caveats:** the path must be absolute; missing / unreadable / empty files are ignored with a logger error (master stays up).
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
- [ ] **Missing file degrades silently**: set `appendSystemPromptFile` to `/tmp/does-not-exist.md`. `/reload-plugins`, kill any `lark-*` sessions. DM the bot. Expect: reply is normal (no persona). `grep appendSystemPromptFile ~/.claude/channels/lark-channel/logs/debug.log` (requires `debug: true`) shows an error line; master is still up.
- [ ] **Relative path rejected**: set `appendSystemPromptFile` to `persona.md` (no leading `/`). DM the bot. Expect: normal reply + logger error `appendSystemPromptFile must be absolute`.
- [ ] **Empty file treated as unset**: `touch /tmp/empty-persona.md`; point config at it. DM the bot. Expect: normal reply + logger warn `is empty/whitespace-only`.
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

- All vitest tests pass (baseline 58 + ~10 new)
- `npm run typecheck` clean
- Five commits landed: config field, refactor, flag injection, docs, smoke-test (plus pre-flight verify which is no-commit)
- Manual smoke: persona visible in bot replies after setting `appendSystemPromptFile`

## Out of scope reminders (from spec)

Do **not** add in this plan — save for future if needed:
- Per-scope prompts (different persona per chat/thread)
- Hot-reload into running tmux sessions
- Built-in default persona template
- Prompt template variables (e.g. `{{workDir}}`)
