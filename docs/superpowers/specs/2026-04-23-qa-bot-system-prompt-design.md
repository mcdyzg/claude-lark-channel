# Q&A Bot via `--append-system-prompt` at Spawn

Date: 2026-04-23
Status: Draft (approved by user, pending review of written spec)

## 背景

当前 `claude-lark-channel` 的 master 在 `src/master/pool.ts#spawnTmux` 里用如下命令拉起 child claude：

```
claude --dangerously-load-development-channels plugin:lark-channel@claude-lark-channel \
       --dangerously-skip-permissions \
       [--resume <claudeSessionId>]
```

没有注入任何 system prompt。每个 spawned claude 已经 `cd` 到 `session.workDir`（= config 的 `defaultWorkDir`），因此目标项目里的 `CLAUDE.md` / `AGENTS.md` / `.claude/skills/` 会被 claude 自动发现。

用户希望用这个项目做**纯答疑机器人**——每一条 Feishu 入站消息都是用户在问问题，bot 的唯一职责是回答。知识来源以目标仓库文件为主，偶尔需要外部 MCP。架构上先做一个目标项目，未来要能扩展到多项目。

## 方案选择

比较过三个方向：

- **A. 只用 `--append-system-prompt` 注入 persona**
- **B. 只在目标项目里写一个答疑 skill**
- **C. 薄 system prompt + 仓库内知识文件/skill，分工**

用户选择 **A**。采纳理由记录在对话里，不重复。本文档只描述 A 的实现设计。

## 设计

### 1. 改动范围

- 只改 `src/master/pool.ts` 的 spawn 命令构建
- 新增 `shared/config.ts` 的一个可选字段
- 不新建 skill，不改 child 端，不引入 per-scope 逻辑

### 2. Config 字段

在 `~/.claude/channels/lark-channel/config.json` 新增可选字段：

```json
{
  "qaSystemPromptFile": "/absolute/path/to/prompt.md"
}
```

约束与语义：

- **绝对路径**（避免 cwd 歧义；master 的 cwd 无保证）
- 字段缺省 / 文件不存在 / 文件为空 → 不加 flag，行为与今天完全一致（向后兼容）
- 文件内容是任意文本 / markdown，作为 `--append-system-prompt` 的 value
- 文件内容在**每次 spawn 时**读取；运行中的 claude 进程不会感知文件改动（见"Reload 语义"）

选择文件而不是内联字符串的原因：

- persona 通常是多行 markdown，塞 JSON 里转义痛苦
- 用户改 prompt 不需要重启 master daemon（虽然要重启被影响的 tmux session）
- 内容和 daemon config 解耦，便于版本控制/审查

### 3. Spawn 命令改动

在 `pool.ts#spawnTmux` 构建 `cmd` 时，若 `config.qaSystemPromptFile` 配置且可读且非空，追加 flag：

```
claude --dangerously-load-development-channels plugin:lark-channel@claude-lark-channel \
       --dangerously-skip-permissions \
       --append-system-prompt '<shell-quoted file 内容>' \
       [--resume <id>]
```

关键选择：

- **`--append-system-prompt` 而非 `--system-prompt`**：后者**覆盖** claude 默认 system prompt，会丢掉工具调用、MCP 发现、skill 自动加载等能力。append 只是追加一段 persona，不影响其他能力
- 文件内容在 master 进程里 `fs.readFileSync` 读取
- 用现成的 `shellQuote`（`pool.ts:360`）做单引号转义
- 拼好的 flag 放进 `cmd` 字符串，走现有的 tmux shell 执行路径
- `--append-system-prompt` 与 `--resume` 可共存：resume 恢复对话上下文，append 追加到每一轮的 system 段

**前置验证**（实现的第 1 步）：跑 `claude --help | grep -i system-prompt` 确认：

- flag 名确实是 `--append-system-prompt`
- 能接受多行字符串（通过单引号传入）
- 和 `--resume` 没有互斥

如果验证失败（例如当前版本 claude CLI 不支持），在实施计划里停下来找用户讨论。

### 4. Reload 语义

system prompt 内容在 claude 进程启动时烤进去——**修改 prompt 文件不会影响已运行的 tmux session**。

用户生效新 prompt 的方式：

- **手动**：`tmux kill-session -t lark-<scopeId>` → 下一条入站消息会触发 pool 重新 spawn，届时读到新内容
- **自动**：等 `config.idleTtlMs` 过了，sweep 自动清理，下次消息触发重 spawn

v1 **不做** hot reload（不向运行中的 claude 注入新 prompt）。文档里明确这个语义，避免用户"改了 prompt 文件但行为没变"的困惑。

### 5. 错误处理

- 配置了 `qaSystemPromptFile` 但文件不存在 / 读不出来 → master logger 输出 `error`，**降级为不加 flag 继续 spawn**，不让 master 因此起不来
- 文件存在但内容为空 / 只含空白 → 等同于未配置
- 内容含特殊字符 → 单引号转义处理；不做内容白名单校验（信任用户）

### 6. 测试

**单元测试**：

- `tests/shared/config.test.ts` 扩展：新字段为可选、缺省为 `undefined`、设置为字符串时保留
- 新增 `tests/master/spawn-cmd.test.ts`（若当前无此文件）：把 `cmd` 构建抽成一个可测的纯函数 `buildClaudeCmd(opts)`，覆盖：
  - 未配置 prompt file → 不含 `--append-system-prompt`
  - 配置了 prompt file 且文件非空 → 含 flag 且内容正确单引号转义
  - 配置了 prompt file 但读取失败 → 不含 flag（回退路径）
  - 与 `--resume` 组合 → 两个 flag 都存在

**重构前提**：为了让 cmd 构建可测，需要把现在内联在 `spawnTmux` 里的 `cmd` 字符串构建逻辑提成一个小函数。保持改动最小，不顺手重构其他部分。

**手动 smoke**：`scripts/smoke-test.md` 新增场景：

1. 写一个测试用 prompt file（"你只用拼音回答"这类明显可观察行为）
2. 在 config 里配上，重启 master
3. 从 Feishu 发消息
4. `tmux attach -t lark-<id>` 观察 claude 是否按 persona 回答

### 7. 文档更新

- `config.json.example`：加 `qaSystemPromptFile` 的注释示例
- `CLAUDE.md`："Config lives at ..." 附近补一句 reload 语义
- `README.md`：新增 "Using as a Q&A bot" 小节（3-5 行配置说明 + 指向 example prompt）

### 8. 明确 YAGNI

以下**不在 v1 范围**，避免 scope creep：

- **per-scope 不同 prompt**：将来要时扩成 `Map<scopeKey, promptFile>` 或用函数返回，现在 spec 只支持全局一份
- **hot reload**：不尝试向 running claude 注入新 prompt；重启 tmux 即可
- **内置默认 prompt 模板**：用户自己写；我们只提供 example
- **prompt 模板变量注入**（比如 `{{workDir}}`）：不做。需要动态内容时再议

## 风险与未决项

- `--append-system-prompt` 在当前 claude CLI 版本的确切行为需实施第 1 步验证。若行为与预期不符，需回到设计讨论
- 若 prompt 文件很大（几 KB 以上），tmux/shell 命令行长度可能有限制。初步判断 persona 应该在 1-2 KB 量级以内，不触发限制；如果用户写得特别长，实施时观察一下并在文档里写个"建议大小"

## 实施顺序（将进入 writing-plans）

1. 验证 `--append-system-prompt` flag 存在且行为符合预期
2. 扩展 `shared/config.ts` 的 schema
3. 把 `spawnTmux` 里的 `cmd` 构建抽成纯函数，加单元测试
4. 接入新字段，加 flag 注入逻辑 + 错误降级
5. 文档更新
6. smoke-test 手动验证
