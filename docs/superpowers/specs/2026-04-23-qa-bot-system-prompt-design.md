# Q&A Bot via `--append-system-prompt-file` at Spawn

Date: 2026-04-23
Status: Approved. Revised 2026-04-23 during Task 1 pre-flight — switched from `--append-system-prompt <content>` to `--append-system-prompt-file <path>` after confirming the `-file` variant exists on the CLI.

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
  "appendSystemPromptFile": "/absolute/path/to/prompt.md"
}
```

约束与语义：

- **绝对路径**（避免 cwd 歧义；master 的 cwd 无保证）
- 字段缺省 / 文件不存在 / 文件为空（size 0）/ 不是绝对路径 → 不加 flag，行为与今天完全一致（向后兼容）
- 文件内容是任意文本 / markdown。claude 进程启动时自己读这个文件
- 文件内容在**每次 spawn 时**由 claude 进程读取；已在运行的 claude 进程不会感知文件改动（见"Reload 语义"）

选择文件而不是内联字符串的原因：

- persona 通常是多行 markdown，塞 JSON 里转义痛苦
- 用户改 prompt 不需要重启 master daemon（虽然要重启被影响的 tmux session）
- 内容和 daemon config 解耦，便于版本控制/审查

### 3. Spawn 命令改动

在 `pool.ts#spawnTmux` 构建 `cmd` 时，若 `config.appendSystemPromptFile` 配置且通过 master-side 预检查（下面第 5 节列出），追加 flag：

```
claude --dangerously-load-development-channels plugin:lark-channel@claude-lark-channel \
       --dangerously-skip-permissions \
       --append-system-prompt-file '<shell-quoted path>' \
       [--resume <id>]
```

关键选择：

- **使用 `--append-system-prompt-file <path>`**（Task 1 pre-flight 确认该 flag 存在），而不是 `--append-system-prompt <content>`。前者把文件读取委托给 claude CLI，master 端不需要 `fs.readFileSync` / 多行内容 shell-quote，persona 内容也不会出现在 `ps` 输出里
- **append 而非 `--system-prompt`**：后者**覆盖** claude 默认 system prompt，会丢掉工具调用、MCP 发现、skill 自动加载等能力。append 只是追加一段 persona，不影响其他能力
- 用现成的 `shellQuote`（`pool.ts:360`）对**路径字符串**做单引号转义（只转义路径，不是内容——内容本身 claude 进程自己从文件读）
- 拼好的 flag 放进 `cmd` 字符串，走现有的 tmux shell 执行路径
- `--append-system-prompt-file` 与 `--resume` 可共存：resume 恢复对话上下文，append-file 追加到每一轮的 system 段

**前置验证**（已在 Task 1 完成）：

- 跑 `claude --help | grep append-system-prompt` → 确认 `--append-system-prompt-file <path>` 存在 ✓
- 起一个 throwaway tmux 会话跑 `claude --append-system-prompt-file <testfile> --dangerously-skip-permissions` 并发问题，观察 persona 是否生效 ✓（验证时 persona 文件内容为 "ALWAYS answer in ALL CAPS"，回答得到 "FOUR."）

实施中若遇到与上面假设不一致的行为，停下来找用户讨论。

### 4. Reload 语义

system prompt 内容在 claude 进程启动时烤进去——**修改 prompt 文件不会影响已运行的 tmux session**。

用户生效新 prompt 的方式：

- **手动**：`tmux kill-session -t lark-<scopeId>` → 下一条入站消息会触发 pool 重新 spawn，届时读到新内容
- **自动**：等 `config.idleTtlMs` 过了，sweep 自动清理，下次消息触发重 spawn

v1 **不做** hot reload（不向运行中的 claude 注入新 prompt）。文档里明确这个语义，避免用户"改了 prompt 文件但行为没变"的困惑。

### 5. 错误处理（master-side 预检查）

为什么要预检查：用 `--append-system-prompt-file` 把读取委托给 claude 进程很方便，但如果路径无效，claude 进程会启动时报错退出，触发我们现有的 "hello timeout → 清 resumeId 重试" 路径，重试时 bad 路径还在，会一直失败。所以 master 必须在拼 flag 前自己先验证路径。

检查顺序（任何一项失败都降级为"不加 flag"，log 一行 warn/error 后继续 spawn）：

1. `config.appendSystemPromptFile` 缺省 / 空字符串 → 静默跳过
2. 不是绝对路径（`!path.isAbsolute(file)`) → logger.error，跳过
3. `fs.statSync` 失败（文件不存在 / 无权限） → logger.error，跳过
4. stat 结果不是 regular file 或 `size === 0` → logger.warn，跳过
5. 通过 → 把路径作为 `--append-system-prompt-file` 的值传入

不做**文件内容校验**（不读文件、不检查 whitespace-only、不限制大小）——这些交给 claude 自己处理；whitespace-only 作为 persona 等效于"没 persona"，不会破坏 bot。

### 6. 测试

**单元测试**：

- `tests/shared/config.test.ts` 新增：新字段为可选、缺省为 `undefined`、设置为字符串时保留、空字符串归一为 `undefined`
- 新增 `tests/master/spawn-cmd.test.ts`：把 `cmd` 构建抽成一个可测的纯函数 `buildClaudeCmd(opts)`，`opts.appendSystemPromptFile` 接受**路径**（不是内容），覆盖：
  - 没传 path → 不含 `--append-system-prompt-file`
  - 传了 path → 含 `--append-system-prompt-file '<quoted path>'`
  - path 含空格等特殊字符 → 单引号转义
  - 与 `--resume` 组合 → 两个 flag 都存在
- `spawnTmux` 的路径预检查（abs / stat / size）不做单测——逻辑线性、手动 smoke 覆盖各降级路径

**重构前提**：为了让 cmd 构建可测，需要把现在内联在 `spawnTmux` 里的 `cmd` 字符串构建逻辑提成一个小函数。保持改动最小，不顺手重构其他部分。

**手动 smoke**：`scripts/smoke-test.md` 新增场景：

1. 写一个测试用 prompt file（"你只用拼音回答"这类明显可观察行为）
2. 在 config 里配上，重启 master
3. 从 Feishu 发消息
4. `tmux attach -t lark-<id>` 观察 claude 是否按 persona 回答

### 7. 文档更新

- `config.json.example`：加 `appendSystemPromptFile` 的注释示例
- `CLAUDE.md`："Config lives at ..." 附近补一句 reload 语义
- `README.md`：新增 "Using as a Q&A bot" 小节（3-5 行配置说明 + 指向 example prompt）

### 8. 明确 YAGNI

以下**不在 v1 范围**，避免 scope creep：

- **per-scope 不同 prompt**：将来要时扩成 `Map<scopeKey, promptFile>` 或用函数返回，现在 spec 只支持全局一份
- **hot reload**：不尝试向 running claude 注入新 prompt；重启 tmux 即可
- **内置默认 prompt 模板**：用户自己写；我们只提供 example
- **prompt 模板变量注入**（比如 `{{workDir}}`）：不做。需要动态内容时再议

## 风险与未决项

- Task 1 pre-flight 已确认 `--append-system-prompt-file` flag 存在并生效（claude v2.1.118）。若将来 CLI 版本移除该 flag，master 传参会导致 child 启动失败；这会触发现有 hello-timeout 重试路径但仍失败。缓解：文档写清最低 claude CLI 版本依赖
- 文件大小不再是命令行长度问题（只传路径），但 persona 过大仍会吃上下文；建议在文档里给"persona 建议 1-2 KB"的非强制指引

## 实施顺序（已进入 writing-plans，见 plan 文档）

1. ✅ 验证 `--append-system-prompt-file` flag 存在且行为符合预期
2. 扩展 `shared/config.ts` 的 schema
3. 把 `spawnTmux` 里的 `cmd` 构建抽成纯函数 `buildClaudeCmd(opts)`，加单元测试
4. 加 spawn 前路径预检查 + flag 注入
5. 文档更新
6. smoke-test 手动验证
