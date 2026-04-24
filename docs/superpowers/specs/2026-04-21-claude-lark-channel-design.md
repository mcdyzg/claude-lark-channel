# claude-lark-channel 设计文档

- **日期**：2026-04-21
- **作者**：--
- **状态**：设计（待实现）
- **参考**：`claude-lark-plugin`（channel 机制 + 多模态）、`cc-channel`（scope 隔离）、`easy-harness`（tmux + SessionStart hook）

---

## 1. 目标与非目标

### 1.1 目标

构建一个 Claude Code plugin，将飞书/Lark IM 与 Claude 对话双向桥接，具备以下特性：

1. **Claude Code channel 机制原生支持**：消息通过 MCP `notifications/claude/channel` 推入 Claude；回复通过 MCP 工具 `reply` 下行
2. **严格的会话/话题隔离**：每个飞书聊天（scope）独立持有 Claude 对话上下文，话题与话题之间、群聊与群聊之间互不污染
3. **多模态**：图片自动下载、文件/音频/视频按需下载（由 Claude 决定）
4. **Plugin marketplace 安装形态**：用户通过 `/plugin marketplace add` + `/plugin install` 即可安装；`/lark-channel:configure` 完成配置
5. **无独立守护进程**：插件生命周期挂在宿主 Claude Code，关窗即退

### 1.2 非目标（刻意不做）

以下 claude-lark-plugin 的高级特性在 v1 MVP 不复刻：

- **Memory / Episodes / Profile / Buffer / Distiller**：不做持久化对话记忆、不做用户画像、不做会话摘要
- **Cron Jobs / Scheduler**：不做定时触发
- **Identity Session / 3-layer privacy rules**：不做服务端身份派生、不做隐私分级（无记忆也就无需隐私）
- **Skills system / `save_memory` / `what_do_you_know` / `forget_memory`**：不做
- **Slash 命令于 IM 侧**（`/cc cd`、`/cc clear` 等）：cc-channel 的 IM 内命令不复刻；用户管理 scope 走 `tmux kill-session` 手动路径
- **端到端自动化测试**：依赖飞书真账号，CI 不覆盖；手动烟测脚本

### 1.3 受众与使用场景

- **单用户**开发者，在本机跑 Claude Code，主力语言/平台 TypeScript + macOS
- 希望**在飞书里和 Claude 对话**，且关心不同话题/群聊之间的严格隔离
- 对进程数（活跃 scope ~10-50）和资源占用不敏感
- 能接受冷启动 2-3 秒延迟

---

## 2. 架构总览

### 2.1 架构演化记录

方案选型经过以下演化，最终落在 **ε'**：

| 方案 | 描述 | 被否决原因 |
|---|---|---|
| α | 单 Claude Code 会话 + scope 标签软隔离 | 隔离太弱，多 scope 上下文混在 Claude 的 history 里 |
| β | plugin 按 scope 跑 `claude --print --resume` 子进程 + channel notification 推消息 | **不可行**：`--print` 模式不支持 `claude/channel` experimental capability；且 channel 要求 claude.ai 登录，`--print` 只支持 API key 鉴权 |
| β' | 同上但用 `stream-json` stdin 推消息 | 违反"使用 channel 机制"的需求 |
| γ | 每 scope 一个独立 daemon + 独立 Claude Code | 资源重、多 WS 连接冲突 |
| ε | 独立 daemon binary (npm global install + launchctl/systemd) + per-scope tmux + Unix socket | 打包不必要 —— Claude Code plugin 机制已提供生命周期 |
| **ε' ✅** | **Plugin 本身兼任 master，通过 Unix socket 调度 tmux 内的 child claude 进程** | 当前方案 |

### 2.2 核心思想

```
一个 plugin 包 → 两种运行角色（靠 env 自检测）：

   master 角色                         child 角色
   ─────────────                      ─────────────
   宿主 Claude Code 加载               tmux 内的 claude 加载
   持 Feishu WS                        连 master socket
   管 scope → tmux pool                收 channel_push → notifications/claude/channel
   管 session store                    暴露 MCP 工具 reply / download_attachment
   管 Unix socket server               RPC 到 master 执行 Feishu API
```

### 2.3 运行拓扑

```
┌───────────────────────────────────────────────────────────────┐
│ 宿主 Claude Code (用户自己开的窗口)                            │
│                                                                │
│  └── plugin MCP server (master 角色)                          │
│        │                                                      │
│        ├── Feishu WSClient  ←─────────── 飞书开放平台          │
│        │                                                      │
│        ├── Unix socket server (bridge.sock)                  │
│        │                                                      │
│        └── tmux pool manager                                  │
│              │                                                │
│              ├── tmux session lark-<uuid-a>                   │
│              │     └── claude --resume <cid-a>                │
│              │           └── plugin MCP server (child 角色)   │
│              │                 ↕ socket                      │
│              │                                                │
│              ├── tmux session lark-<uuid-b>                   │
│              │     └── claude --resume <cid-b>                │
│              │           └── plugin MCP server (child 角色)   │
│              │                 ↕ socket                      │
│              │                                                │
│              └── ... up to LARK_CHANNEL_MAX_SCOPES            │
└───────────────────────────────────────────────────────────────┘
```

---

## 3. 项目结构

### 3.1 仓库布局

```
claude-lark-channel/
├── .claude-plugin/
│   ├── marketplace.json       # /plugin marketplace add 读取
│   └── plugin.json            # /plugin install 读取
├── .mcp.json                  # plugin 激活后 Claude Code 自动加载 MCP server
├── hooks/
│   ├── hooks.json             # SessionStart hook 注册
│   └── on-session-start.sh    # 用 jq 写入 claudeSessionId
├── skills/
│   └── configure/
│       └── SKILL.md           # /lark-channel:configure
├── src/
│   ├── index.ts               # 统一入口：按 env 分派 master / child
│   ├── master/
│   │   ├── index.ts           # master 启动：Feishu + socket + pool
│   │   ├── feishu-client.ts   # WSClient + EventDispatcher（抄 claude-lark-plugin）
│   │   ├── message-parser.ts  # parseMessageContent / extractPlainText / 附件
│   │   ├── attachment.ts      # 图片同步下载；download_attachment RPC 实现
│   │   ├── reply.ts           # Feishu reply / react API 封装
│   │   ├── dedup.ts           # messageId 1 分钟窗口去重
│   │   ├── whitelist.ts       # user / chat allowlist（OR 语义）
│   │   ├── bridge-server.ts   # Unix socket server + RPC 路由
│   │   ├── pool.ts            # tmux 会话池：spawn / resume / LRU+TTL 回收
│   │   └── bootstrap.ts       # 首次注入：话题根帖 / 群历史
│   ├── child/
│   │   ├── index.ts           # child 启动：连 socket + 注册 MCP
│   │   ├── bridge-client.ts   # socket 客户端 + 指数退避重连
│   │   └── tools.ts           # MCP tools: reply / download_attachment
│   ├── shared/
│   │   ├── scope.ts           # resolveScopeKey（沿用 cc-channel）
│   │   ├── session-store.ts   # by-id / by-scope 索引
│   │   ├── protocol.ts        # socket envelope 类型
│   │   ├── config.ts          # .env 加载
│   │   └── lock.ts            # master PID lock
│   └── types.ts               # LarkMessage / ScopeEvent / Session 等
├── scripts/
│   └── start.sh               # npm start 包装（可选）
├── package.json               # type: module, prestart npm install, start tsx src/index.ts
├── tsconfig.json
├── .env.example
├── README.md
├── CLAUDE.md
└── docs/
```

### 3.2 用户运行时文件

```
~/.claude/channels/lark-channel/
├── .env                              # 配置（凭据 + 运行参数）
├── sessions/
│   ├── by-id/
│   │   └── <session.id>.json         # 主存储；SessionStart hook 直接写这里
│   └── by-scope/
│       └── <safe(scopeKey)>.json     # 符号链接 → ../by-id/<session.id>.json
├── inbox/
│   └── <timestamp>-<fileKey>.{png,mp4,...}
├── bridge.sock                       # Unix domain socket (也可能放 /tmp/)
└── logs/
    └── master.log
```

**`safe(scopeKey)` 函数**：`scopeKey.replace(/[^a-zA-Z0-9_-]/g, '_')`，用于安全作为文件名。多对一时靠 symlink target 检查正确性（首次写入带冲突检测）。

---

## 4. Master 与 Child 职责划分

### 4.1 Master 职责

| # | 职责 | 模块 |
|---|---|---|
| 1 | 持有 Feishu WebSocket（单一连接点） | `feishu-client.ts` |
| 2 | 消息预处理：解析、白名单、去重、mention 判定 | `message-parser.ts` + `dedup.ts` + `whitelist.ts` |
| 3 | 图片自动下载到 `inbox/`；文件/音视频仅提取 fileKey | `attachment.ts` |
| 4 | 发送/撤回 ack 反应（Typing / MeMeMe） | `reply.ts` |
| 5 | Scope 解析：`resolveScopeKey(event, mode)` | `shared/scope.ts` |
| 6 | tmux 会话池：按需 spawn / LRU+TTL 回收 / 启动时清理残留 | `pool.ts` |
| 7 | 首次背景注入：话题根帖 或 群历史 | `bootstrap.ts` |
| 8 | Unix socket server：接 child 连接、路由 channel_push / RPC | `bridge-server.ts` |
| 9 | 反向执行 Feishu API（reply / download_attachment） | `reply.ts` + `attachment.ts` |
| 10 | Session store：Session JSON 读/写（双索引） | `shared/session-store.ts` |
| 11 | PID lock：防多 master 并发 | `shared/lock.ts` |
| 12 | 生命周期：stdio close → 清理所有 tmux + socket 文件 | `master/index.ts` |

**Master 不暴露任何 MCP 工具给宿主 Claude Code**。宿主 Claude Code 只是 plugin 的运行容器，不参与消息路由。

### 4.2 Child 职责

| # | 职责 | 模块 |
|---|---|---|
| 1 | 启动：从 env 读 `LARK_CHANNEL_SCOPE_KEY` / `LARK_CHANNEL_SCOPE_ID` / `LARK_CHANNEL_SOCK` | `child/index.ts` |
| 2 | 连 master socket，发送 `hello`；带指数退避重连 | `bridge-client.ts` |
| 3 | 注册 MCP server，声明 `experimental: { 'claude/channel': {} }` capability | `child/index.ts` |
| 4 | 收到 socket `channel_push` → 转 `server.notification('notifications/claude/channel')` | `bridge-client.ts` |
| 5 | 暴露 MCP 工具 `reply`、`download_attachment` | `tools.ts` |
| 6 | Tool 调用 → RPC 封装发给 master，等结果回注到 tool result | `tools.ts` + `bridge-client.ts` |

**Child 不做**：
- 不持有 Feishu 凭据
- 不直接调 Feishu API
- 不读写 session store（由 master 全权 + SessionStart hook 旁路）
- 不感知其它 scope 的存在

### 4.3 Role 自检测（`src/index.ts`）

```ts
async function main() {
  if (process.env.LARK_CHANNEL_SCOPE_ID) {
    // tmux env 注入 → child
    const { startChild } = await import('./child/index.js');
    return startChild();
  }

  // 否则尝试成为 master
  const acquired = await tryAcquireMasterLock();
  if (!acquired) {
    console.error('[lark-channel] another master is running, exiting');
    process.exit(0);                  // 无害退出；该 MCP 子进程终止
  }

  const { startMaster } = await import('./master/index.js');
  return startMaster();
}
```

---

## 5. Unix Socket Bridge 协议

### 5.1 传输层

- Unix Domain Socket，**默认路径 `$LARK_CHANNEL_STORE/bridge.sock`**（= `~/.claude/channels/lark-channel/bridge.sock`）
- Fallback：若 store 目录不可写（极少见），回退到 `/tmp/lark-channel-${uid}.sock`
- Socket 文件权限 `0600`；master 启动时若文件残留则 `unlink` 重建
- **帧格式**：NDJSON（每行一个 JSON envelope，LF 分隔）

### 5.2 Envelope 类型

```ts
type Envelope =
  | { t: 'hello';        scopeKey: string; scopeId: string; pid: number; version: string }
  | { t: 'hello_ack';    ok: true }
  | { t: 'hello_reject'; reason: string }
  | { t: 'channel_push'; pushId: string; content: string; meta: Record<string, unknown> }
  | { t: 'rpc_call';     id: string; method: RpcMethod; params: unknown }
  | { t: 'rpc_result';   id: string; ok: true;  data: unknown }
  | { t: 'rpc_error';    id: string; ok: false; code: string; message: string }
  | { t: 'ping' }
  | { t: 'pong' };

type RpcMethod = 'reply' | 'download_attachment';
```

### 5.3 握手状态机

```
child 启动
  ├─ connect(sock_path)
  │   ├─ 失败 → 指数退避重连
  │   │         退避序列 1s→2s→4s→8s→16s→30s，之后固定 30s 间隔无限重试
  │   │         每 10 次失败输出一次 warn log（避免日志刷屏）
  │   │         不主动退出；若 master 始终不起，Claude 侧调用 reply/download 会以
  │   │         RPC 超时（60s）体现为工具失败，Claude 自行告知用户
  │   └─ 成功
  │       ├─ send { t: 'hello', scopeKey, scopeId, pid, version }
  │       ├─ 2s 等 hello_ack
  │       │     ├─ 收到 ok → ready 状态
  │       │     ├─ 收到 reject → log error, exit(1)（version 不匹配等致命错误）
  │       │     └─ 超时 → disconnect, 重连
  │       └─ ready: 监听 channel_push, 可发 rpc_call
```

### 5.4 消息方向约定

- `channel_push`：master → child，单向，无 ack；`pushId` 仅用于 master 本地日志关联
- `rpc_call` / `rpc_result` / `rpc_error`：child → master 发起；`id` 为 child 生成的 UUID
- `ping` / `pong`：双向心跳，30s 一次；3 次未收 pong 视为断开

### 5.5 RPC 方法

**`reply`**
```ts
// params
{
  chat_id: string;
  text: string;
  card?: string;                  // 原始 Schema 2.0 JSON
  reply_to?: string;              // 缺失时 master 从 latestMessageTracker 自动填充
  thread_id?: string;
  format?: 'text' | 'card';
  footer?: string;
  files?: Array<{ path: string; type: 'image' | 'file' }>;  // v2 扩展，MVP 先仅支持文本+card
}
// result
{
  messageIds: string[];           // 长文分片后可能多条
  durationMs: number;
}
```

**`download_attachment`**
```ts
// params
{
  message_id: string;
  file_key: string;
  kind: 'file' | 'audio' | 'video' | 'image';
}
// result
{
  path: string;                   // 绝对路径，~/.claude/channels/lark-channel/inbox/
  size: number;
  filename: string;
}
```

### 5.6 错误处理

| 情况 | 行为 |
|---|---|
| Socket 断开 | master: 清 `pool.entry.childConn`；in-flight RPC 视为无结果丢弃。child: 重连 |
| RPC 超时（child 侧） | 60s 超时 → tool 返回 error object 给 Claude（Claude 视其为工具失败） |
| 非法 JSON / 未知 `t` | 双方 log warn + 忽略该行；不断连 |
| Version 不兼容 | master 发 `hello_reject`；child 收到后 exit(1) |

### 5.7 示例字节

```
# child → master
{"t":"hello","scopeKey":"thread:oc_xxx:t_abc","scopeId":"a7f3-...","pid":12345,"version":"0.1.1"}
{"t":"rpc_call","id":"r1","method":"reply","params":{"chat_id":"oc_xxx","text":"hi","thread_id":"t_abc"}}

# master → child
{"t":"hello_ack","ok":true}
{"t":"channel_push","pushId":"p_001","content":"帮我看下这张图","meta":{"chat_id":"oc_xxx","message_id":"om_xxx","user":"alice · chat_xxx","thread_id":"t_abc","image_path":"/Users/me/.claude/channels/lark-channel/inbox/1713700000-img_xxx.png","scope_key":"thread:oc_xxx:t_abc","ts":"2026-04-21T12:34:56Z"}}
{"t":"rpc_result","id":"r1","ok":true,"data":{"messageIds":["om_yyy"],"durationMs":842}}
```

---

## 6. Scope 生命周期与 tmux 池

### 6.1 数据模型

```ts
// 内存热状态
interface PoolEntry {
  scopeKey: string;
  scopeId: string;                // = Session.id
  tmuxSession: string;            // `lark-${scopeId}`
  childConn: ChildConn | null;    // null = tmux 已起但 child 还没 hello
  lastActiveAt: number;
  spawnedAt: number;
  stats: { msgCount: number; replyCount: number; lastErrorAt?: number };
}

class TmuxPool {
  private entries = new Map<string, PoolEntry>();  // scopeKey → entry
  private config: { maxSize: 50, idleTtlMs: 14_400_000, sweepMs: 300_000 };
}

// 冷持久化（Session JSON）
interface Session {
  id: string;                     // UUID，作为 scopeId 使用
  scopeKey: string;
  workDir: string;
  claudeSessionId: string;        // hook 写入；空串 = 未分配
  rootInjected: boolean;
  lastUserInput: string;
  createdAt: number;
  updatedAt: number;
}
```

### 6.2 Session ID 捕获（hook 路径）

**关键：** Claude Code interactive 模式不支持 `--session-id` 启动时指定；只能在**启动后**通过 `SessionStart` hook 拿 session_id。

**`hooks/hooks.json`：**
```json
{
  "description": "claude-lark-channel session id capture",
  "hooks": {
    "SessionStart": [{
      "hooks": [{
        "type": "command",
        "command": "${CLAUDE_PLUGIN_ROOT}/hooks/on-session-start.sh"
      }]
    }]
  }
}
```

**`hooks/on-session-start.sh`：**
```bash
#!/bin/bash
set -u
[ -z "${TMUX:-}" ] && exit 0
[ -z "${LARK_CHANNEL_SCOPE_ID:-}" ] && exit 0
[ -z "${LARK_CHANNEL_STORE:-}" ] && exit 0

INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty' 2>/dev/null)
[ -z "$SESSION_ID" ] && exit 0

FILE="${LARK_CHANNEL_STORE}/sessions/by-id/${LARK_CHANNEL_SCOPE_ID}.json"
[ -f "$FILE" ] || exit 0

TS=$(( $(date +%s) * 1000 ))
jq --arg sid "$SESSION_ID" --argjson ts "$TS" \
   '.claudeSessionId = $sid | .updatedAt = $ts' "$FILE" > "$FILE.tmp" \
   && mv "$FILE.tmp" "$FILE"
exit 0
```

**`/clear` 行为**：hook 无条件覆盖 `claudeSessionId`（用户 `/clear` 即意图换新 session）。

**依赖约束**：宿主系统必须有 `jq`（macOS: `brew install jq`；启动时检测 fail-fast）。

### 6.3 关键动作

**(A) `pool.ensure(scopeKey)` — 查或建 tmux**

```
1. 查 entries[scopeKey]
   ├─ 存在且 childConn ready → touch lastActiveAt, return
   ├─ 存在但 childConn == null → await hello（15s）, timeout 则重建
   └─ 不存在 → 继续

2. 容量检查：entries.size >= maxSize → evictLRU()

3. session = getOrCreateSession(scopeKey, defaultWorkDir)
   (新建时 session.id = uuid, claudeSessionId = "")

4. tmuxName = `lark-${session.id}`
   resumeArg = session.claudeSessionId ? `--resume ${session.claudeSessionId}` : ''

5. exec tmux new-session -d -s <tmuxName> -c <session.workDir> \
     -e LARK_CHANNEL_SCOPE_ID=<session.id> \
     -e LARK_CHANNEL_SCOPE_KEY=<scopeKey> \
     -e LARK_CHANNEL_SOCK=<sock path> \
     -e LARK_CHANNEL_STORE=<store dir> \
     "claude ${resumeArg}"
     # 注意：不传 --mcp-config —— plugin 是全局安装，自动加载

6. 创建 PoolEntry { childConn: null }, 入池
7. 返回 entry
```

**(B) `pool.push(scopeKey, event)` — 推消息**

```
1. entry = pool.ensure(scopeKey)
2. 若 childConn == null：await hello_ready（15s）
   超时 → 回复用户 "⏳ Claude 启动超时" + kill tmux + log error
3. 首次消息 & !session.rootInjected：
   ├─ thread scope + threadId → fetchThreadRoot
   ├─ 否则 → fetchChatHistory
   ├─ 成功 → 推 background channel_push
   └─ rootInjected = true（无论成败，避免重复）
4. 推正文 channel_push { content, meta: { chat_id, message_id, user, thread_id?, image_path?, attachment_*?, scope_key, ts } }
5. touch entry.lastActiveAt
6. save session (updated lastUserInput)
```

**(C) `pool.sweeper` — 闲置回收**

```
每 LARK_CHANNEL_SWEEP_MS (默认 5min) 跑：
  for each entry:
    if now - entry.lastActiveAt > idleTtlMs:
      log "reaping scope <key>"
      entry.childConn?.close()
      exec tmux kill-session -t <tmuxName>
      entries.delete(scopeKey)
      (session JSON 不删，下次来 --resume 复活)
```

**(D) `master.onStartup` — 启动清理**

```
1. scan tmux ls 2>/dev/null | awk '{print $1}' | grep '^lark-' | sed 's/://'
2. for each: tmux kill-session -t <name>
3. entries = new Map() (clean start)
4. session JSON 保留不动
5. unlink old bridge.sock, 建新 socket listener（0600 权限）
```

**(E) `master.onShutdown` — stdio close**

```
SIGTERM / SIGINT / stdin EOF:
  pool.shuttingDown = true（拒绝新 push）
  for each entry: close childConn + kill tmux（并发）
  close socket server, unlink sock 文件
  close Feishu WS
  process.exit(0)
```

### 6.4 失败矩阵

| 场景 | 处理 |
|---|---|
| tmux 不存在 | 启动 fail-fast，提示 `brew install tmux` |
| jq 不存在 | 启动 fail-fast（hook 依赖） |
| `claude` 不存在 | pool spawn 时 child 永不 hello → 超时 → 告警；用户侧看到 ack 但无回复 |
| `--resume <id>` 损坏 | child 不 hello → 超时 → 清空 `session.claudeSessionId` → 下次消息按新 session 重建 |
| child 连上但 10s 不发 hello | master 踢连接，下次重建 |
| 宿主 Claude Code 重启 | master stdio close → 清理所有 tmux → 重启后启动清理逻辑兜底 |
| LRU 踢掉的 scope 收到新消息 | ensure 重建 → `--resume claudeSessionId` 续对 |
| 两 Claude Code 窗口同时加载 plugin | 第二个 lock 失败 → exit(0) 无害 |
| 飞书 WS 断线 | SDK 自动重连；期间消息丢失接受 |
| 图片下载失败 | `imagePath = undefined`，照常推 channel |
| 附件 fileKey 过期 | RPC error → Claude 收到工具失败，自行告知用户 |
| bootstrap 拉历史失败 | 返回 null，不推 background；`rootInjected = true` 防重试 |
| `reply` 飞书 API 限流 | 指数退避重试 3 次；失败 RPC error |

### 6.5 容量参数

| 参数 | 默认 | 环境变量 |
|---|---|---|
| 最大活跃 scope | 50 | `LARK_CHANNEL_MAX_SCOPES` |
| 闲置 TTL | 4h | `LARK_CHANNEL_IDLE_TTL_MS` |
| 扫描周期 | 5min | `LARK_CHANNEL_SWEEP_MS` |
| 冷启动 hello 超时 | 15s | `LARK_CHANNEL_HELLO_TIMEOUT_MS` |
| RPC 超时 | 60s | `LARK_CHANNEL_RPC_TIMEOUT_MS` |
| 去重窗口 | 60s | `LARK_CHANNEL_DEDUP_TTL_MS` |

---

## 7. 端到端数据流

### 7.1 Flow A — 用户发图 + Claude 回复

```
① 飞书 @bot "帮我看下这张图" + 一张图
② master WSClient 收 im.message.receive_v1
③ message-parser: 解析 msg_type / content / mentions / thread_id → text
④ dedup / whitelist / 群聊 @bot 过滤
⑤ attachment.ts: image 同步下载到 inbox/ → imagePath
⑥ 发 ack reaction（P2P=Typing, 群=MeMeMe）
⑦ resolveScopeKey → "thread:oc_xxx:t_abc"
⑧ pool.ensure（命中或 spawn 新 tmux）
⑨ bootstrap（首次才执行）→ background channel_push
⑩ 推正文 channel_push {
     content: "帮我看下这张图",
     meta: { chat_id, message_id, user, thread_id, image_path, scope_key, ts }
   }
⑪ child 收 socket → server.notification('notifications/claude/channel')
⑫ Claude 看到事件 → Read 本地 inbox 图片 → 推理
⑬ Claude 调 MCP tool reply(chat_id, text, thread_id)
⑭ child tools.reply → socket RPC 给 master
⑮ master reply.ts: auto-fill reply_to / buildCards / 分片 / Lark.Client.im.message.reply
⑯ 成功 → 撤回 ack reaction / botMessageTracker.add / 回 rpc_result
⑰ child tool call resolve → 返回给 Claude
⑱ 飞书用户看到回复 ✅
```

### 7.2 Flow B — 附件懒下载

Step ⑤ 对 file/audio/video **不下载**，只塞 meta：`attachment_file_id` / `attachment_kind` / `attachment_name`。Claude 决定需要时：

```
Claude → tools/call { name: "download_attachment", args: { message_id, file_key, kind: "video" } }
       → child RPC → master attachment.ts:
         client.im.messageResource.get({ path: { message_id, file_key }, params: { type: "video" } })
         → 落到 inbox/<ts>-<fileKey>.mp4
       → rpc_result { path, size, filename }
       → Claude 拿绝对路径 → Read 工具读
```

### 7.3 Flow C — 新 scope 冷启动时序

```
t=0ms       master 收事件，scope 不在池
t=5ms       pool.ensure → getOrCreateSession → 新 Session (claudeSessionId="")
t=10ms      ack reaction (fire-and-forget)
t=20ms      tmux new-session ... "claude"（无 --resume）
t=100ms     tmux 起, claude 开始 init
t=~500ms    SessionStart hook 触发 → jq 写 claudeSessionId 到 by-id/<uuid>.json
t=~2s       claude MCP 加载完 plugin → child 启动
t=~2.5s     child connect socket, hello
t=~2.5s     master: hello_ack; bootstrap 异步拉根帖/历史
t=~3s       推 background（若有） + 正文 channel_push
t=~3s       claude 推理
t=~10s      claude reply → master → 飞书 API → 撤 ack
            用户看到回复（首条冷启延迟 2-3s + 推理时间）
```

热启动（scope 已在池）：无冷启延迟，推完就推。

### 7.4 Flow D — LRU 回收后重开

```
回收:  pool.sweeper 扫到 idle 超时
       → childConn.close + tmux kill
       → entries.delete
       session JSON 保留

复活:  新消息到 → pool.ensure 走 spawn 路径
       session.claudeSessionId != "" → claude --resume <id>
       → Claude 续对之前对话 ✅
```

---

## 8. 配置

### 8.1 单一配置源：`~/.claude/channels/lark-channel/.env`

```bash
# ─── Feishu 凭据（必填）
LARK_APP_ID=cli_xxxxx
LARK_APP_SECRET=xxxxx
LARK_DOMAIN=feishu                      # feishu | lark

# ─── 白名单（可选，OR 语义）
LARK_ALLOWED_USER_IDS=ou_a,ou_b
LARK_ALLOWED_CHAT_IDS=oc_x,oc_y

# ─── Scope 隔离
LARK_CHANNEL_SCOPE_MODE=thread          # chat | thread (默认 thread)
LARK_CHANNEL_DEFAULT_WORKDIR=/Users/me/work

# ─── tmux 池
LARK_CHANNEL_MAX_SCOPES=50
LARK_CHANNEL_IDLE_TTL_MS=14400000
LARK_CHANNEL_SWEEP_MS=300000

# ─── 超时
LARK_CHANNEL_HELLO_TIMEOUT_MS=15000
LARK_CHANNEL_RPC_TIMEOUT_MS=60000
LARK_CHANNEL_DEDUP_TTL_MS=60000

# ─── 多模态
LARK_ACK_EMOJI=MeMeMe                   # 群聊 ack；P2P 固定 Typing

# ─── 运行时
LARK_CHANNEL_LOG_LEVEL=info             # error | warn | info | debug
```

### 8.2 Plugin marketplace 元信息

**`.claude-plugin/marketplace.json`：**
```json
{
  "name": "claude-lark-channel",
  "description": "Feishu/Lark channel for Claude Code — per-scope tmux isolation, strict thread/chat separation, multimodal",
  "owner": { "name": "<owner>", "email": "<email>" },
  "plugins": [{
    "name": "lark-channel",
    "version": "0.1.1",
    "source": "./",
    "description": "Scope-isolated Feishu/Lark channel plugin. Each chat/thread runs in its own tmux-hosted Claude session.",
    "category": "productivity",
    "keywords": ["feishu","lark","im","bot","channel","tmux","scope"]
  }]
}
```

**`.claude-plugin/plugin.json`：**
```json
{
  "name": "lark-channel",
  "version": "0.1.1",
  "description": "Scope-isolated Feishu/Lark channel plugin for Claude Code",
  "author": { "name": "<owner>" },
  "repository": "https://github.com/<owner>/claude-lark-channel",
  "license": "Apache-2.0",
  "keywords": ["feishu","lark","im","bot","channel","tmux"]
}
```

**`.mcp.json`：**
```json
{
  "mcpServers": {
    "lark-channel": {
      "command": "npm",
      "args": ["run", "--silent", "--prefix", "${CLAUDE_PLUGIN_ROOT}", "start"]
    }
  }
}
```

### 8.3 用户安装流程

```
/plugin marketplace add https://github.com/<owner>/claude-lark-channel.git
/plugin install lark-channel@claude-lark-channel
/reload-plugins

# 交互式配置
/lark-channel:configure setup

# 或一步到位
/lark-channel:configure cli_xxxxxxxx <app_secret>

# 查看当前配置（脱敏）
/lark-channel:configure

# 清除配置
/lark-channel:configure clear
```

### 8.4 Skill `/lark-channel:configure`

**`skills/configure/SKILL.md` 前事务块：**
```markdown
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
```

**4 种调用姿态：**

1. **无参**：显示当前 `.env` 状态（app_id 显前 6、secret 显前 3 后 2、其余遮蔽）；按 Credentials / Scope / Pool / Timeouts / Messaging 分组；提示下一步
2. **`cli_xxx <secret>`**：直接写入凭据；保留其它配置
3. **`setup`**：交互式 wizard 依次问 9 项：
   - `LARK_APP_ID`（必填）
   - `LARK_APP_SECRET`（必填）
   - `LARK_DOMAIN`（默认 feishu）
   - `LARK_CHANNEL_SCOPE_MODE`（默认 thread）
   - `LARK_CHANNEL_DEFAULT_WORKDIR`（默认 `$HOME`）
   - `LARK_ALLOWED_USER_IDS` / `LARK_ALLOWED_CHAT_IDS`（可选）
   - `LARK_CHANNEL_MAX_SCOPES`（默认 50）
   - `LARK_CHANNEL_IDLE_TTL_MS`（默认 14400000）
   - 结束后提示 `/reload-plugins` 生效
4. **`clear`**：二次确认后删 `.env`

---

## 9. 错误处理与日志

### 9.1 分层原则

1. **不让 IM 端等**：慢操作（bootstrap、图片下载）失败即降级，不阻死回复
2. **pool 层容错**：单 scope 故障不影响其它（进程级隔离天然实现）
3. **master 是单点**：挂了整体挂；但挂掉后重启能从 session JSON 完整恢复

### 9.2 日志

```
~/.claude/channels/lark-channel/logs/
└── master.log                 # master 所有 console.error 输出
```

**MCP 协议硬约束：** stdout 保留给 JSON-RPC，所有日志走 stderr。Lark SDK 必须挂自定义 logger 重定向到 stderr（沿用 claude-lark-plugin 的做法）。

**关键日志点：**
- WS 连上/断开/重连
- 每条消息的 scope 决策 + drop 原因
- pool ensure / evict / sweep / kill-all
- child hello / disconnect
- RPC 成功率 / 延迟
- Feishu API 调用（success info / error warn）

---

## 10. 测试策略

### 10.1 单元测试（vitest）

覆盖纯逻辑模块：
- `shared/scope.ts` — `resolveScopeKey` 所有分支（沿用 cc-channel 测试用例）
- `master/dedup.ts` — 窗口滑动 / 清理
- `master/whitelist.ts` — OR 语义 4 象限
- `master/message-parser.ts` — text/post/image/file/audio/video 各 msg_type
- `shared/protocol.ts` — envelope 序列化/反序列化 / 未知 `t` 容错
- `master/bootstrap.ts` — fetcher mock 的成功/失败/超时/空历史

### 10.2 集成测试

- `bridge-server` × `bridge-client` 配对：真 socket 做完整 RPC round-trip；模拟断连重连
- `pool` 带 mock `tmuxExec`：验证 spawn / evict / sweep / kill-all-on-shutdown

### 10.3 E2E 烟测（手动脚本）

`scripts/smoke-test.md`（checklist）：
1. 测试飞书 app 起 master
2. P2P 发文本 → 等回复
3. 群 @bot 发文本 → 等回复
4. 群 @bot 发图片 → Claude 应识图回复
5. 群 @bot 发文件 → Claude 应调 `download_attachment` 再回复
6. 同一话题连发 3 条 → 不应串到其它话题
7. 切换到另一话题 → 首次应看到话题根帖背景注入
8. 等 4h+ → tmux 应被回收；再发消息 → 应无缝续对

### 10.4 不做（明确 out of scope）

- E2E 自动化（飞书真账号依赖）
- tmux 命令 mock（命令行接口在 CI 不稳定）
- 多用户并发压测

---

## 11. 打包与发布

- **不发 npm 包**：用户通过 `/plugin marketplace add` + git 仓库安装
- `package.json.scripts.start` = `tsc && node dist/index.js`（或 `tsx src/index.js`）
- `prestart` = `npm install --prefer-offline --silent`（对齐 claude-lark-plugin）
- CI：`tsc --noEmit` + vitest
- 版本管理：semver；发版时同步更新 `.claude-plugin/*` 与 `package.json` 的 version

---

## 12. 已知限制与未来工作

### 12.1 v1 已知限制

- **资源上限**：活跃 scope 超过 `MAX_SCOPES` 时走 LRU 淘汰；被淘汰 scope 下次来要冷启动（2-3s 额外延迟）
- **宿主必须常开**：Claude Code 窗口关了即整体退出；场景适合"人在"时使用
- **无 Feishu WS 重连期消息回放**：WS 断线重连期间可能丢消息（飞书侧事件有限回放）
- **无推理超时**：Claude 卡住时需用户手动 `tmux kill-session`；MVP 不做强制超时
- **Ack reaction 持久化**：master 崩溃时 in-flight ack 无法撤回，飞书用户会看到残留 emoji（人眼容忍）
- **Inbox 无 GC**：下载的附件不自动清理；文档提示定期 `rm`

### 12.2 v2 候选

- Tool: `edit_message` / `react`（已保留协议扩展位）
- Reaction 事件转发（`im.message.reaction.created_v1`）
- 推理超时 + 强 kill
- Inbox 定期清理 GC
- Master status MCP 工具（宿主 Claude Code 可查 scope 状态）
- 按 scope 改 workdir（`/lark-channel:scope set-workdir <scopeKey> <path>`）
- `lark-channel:scope list` / `lark-channel:scope reset <key>` 等辅助 skills

### 12.3 硬依赖

- **tmux**（运行时硬依赖）
- **jq**（SessionStart hook 依赖）
- **Claude Code ≥ 2.1.80**（channel 机制要求）
- **claude.ai 登录**（channel 机制不支持 API key 鉴权）
- **Node.js ≥ 20** / ESM
- **macOS 优先**；Linux 应可运行但未官方验证；Windows 不支持

---

## 13. 开放问题与实现前验证项

这些点在**实现前**需要先跑一个小 spike 验证，失败就需要调整设计：

1. **[CRITICAL] Plugin 在 spawned claude 里是否自动加载**：ε' 架构成立的前提 —— 当 master 在 tmux 里 `tmux new -d ... "claude --resume <id>"` spawn 一个新 claude 进程时，这个新进程必须能自动感知并加载本 plugin（读其 `.mcp.json` 起 MCP server）。验证办法：装好 plugin 后，在一个新 terminal 里 `claude`，`/mcp` 看 lark-channel 是否在列表。easy-harness 走的是这个模式，应该可行，但要亲测。若不行，降级方案：master spawn 时额外 `--mcp-config <generated.json>` 显式指定，文件里写绝对路径。

2. **[CRITICAL] `tmux new-session -e KEY=VAL` 的最低 tmux 版本**：tmux 3.2+ 才支持 `-e` 注入环境变量。启动时 `tmux -V` 检测，低于 3.2 fail-fast 并提示 `brew upgrade tmux`。若用户 tmux 过老，降级方案：用 `tmux setenv` 在 session 级别设 env，再 `send-keys` 启 claude；但可能丢失 claude 子进程对 env 的继承。

3. **SessionStart hook 在 `--resume` 路径下是否一定触发**：`/clear` 会触发，但 `claude --resume` 恢复已有 session 是否触发 SessionStart 需实测。若 resume 不触发，首次 hook 写入的 `claudeSessionId` 在后续永远不变（OK，不需要重写）；但若连 resume 也不触发且 claude 内部生成了新 id（不太可能），我们的 session id 会过期。

4. **`workDir → ~/.claude/projects/<safe>` 映射**：本设计改用 hook 后不强依赖，但首次启动诊断仍可能用到。特殊字符（空格、点、unicode）的转换规则需实测后补充兜底逻辑。

5. **Socket 路径多用户场景**：默认 `$LARK_CHANNEL_STORE/bridge.sock`（用户级目录天然隔离，无冲突风险）；若未来支持跨用户场景再考虑 `/tmp/lark-channel-${uid}.sock`。

6. **版本协议升级策略**：`hello.version` 不匹配时 master 发 `hello_reject`；未来做向后兼容可扩展 `min_compatible_version` 字段。

---

## 14. 验收标准

v1 MVP 上线需满足：

- [ ] `/plugin marketplace add` + `/plugin install` + `/reload-plugins` 能在干净环境 5 分钟内完成安装
- [ ] `/lark-channel:configure setup` 完整走完 9 项，`.env` 正确生成
- [ ] P2P 发文本能收到回复
- [ ] 群聊 @bot 发图片能收到识图回复
- [ ] 同 chat 的不同 thread 之间上下文独立（通过 tmux 物理隔离验证）
- [ ] LRU 回收后重发消息，Claude 能 `--resume` 续对
- [ ] 宿主 Claude Code 关闭后，所有 `lark-*` tmux 被清理
- [ ] 重启后所有 session 能从 JSON 恢复能力
- [ ] `scripts/smoke-test.md` 8 条全通过
