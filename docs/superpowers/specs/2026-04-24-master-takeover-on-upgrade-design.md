# Auto-Takeover on Master Startup (Prevent Silent Failure After Plugin Upgrade)

Date: 2026-04-24
Status: Draft (approved by user)

## 背景

今天早上的真实 incident：用户把 plugin 从 0.1.0 升级到 0.1.1（workspace / marketplace / cache/0.1.1 都已同步），打开新 host claude 后发现 @机器人不回复、`~/.claude/channels/lark-channel/logs/` 没有 `debug.log`。

根因三合一（见 `src/shared/lock.ts`、`src/shared/logger.ts:35-42`、`src/master/index.ts:54-58`）：

1. **Logger 在 `debug=false` 时完全 no-op**（`write()` 首行 `if (!this.enabled) return` 吞掉所有级别）——老 master 昨晚启动时 `debug=false`，配置文件后来改成 true 也影响不到已加载的进程，所以看不到任何信号
2. **Lock 冲突的路径只有一行 `console.error('[master] another master is running; exiting')` + `process.exit(0)`**——信息量小（不说持有者 PID、不说怎么修），exit 0 还让宿主当作"成功退出"不吵闹
3. **运行中的 master 看不到版本号**——从日志 / ps 上分不清"0.1.0 僵尸"和"0.1.1 新起"

结果：0.1.0 僵尸 master（由一个昨晚 `npm run start` 启的 shell 留下）一直霸占着 `master-<appId>.lock` 和 `bridge.sock`。今天 10:46 新启动的 host claude 尝试加载 0.1.1 的 master，撞锁，`exit(0)` 静默失败。WS 事件进来能被老 master 接收、写 session 记录，但 @消息处理链路在 0.1.0 上又因为某些其他原因不工作（细节不再重要），而且 logger 是死的——完全黑盒。

PID lock 本就是"1 master / appId"的硬 invariant。升级时老 master 没被主动替换，invariant 违反就静默发生。

## 方案选择

之前讨论过三种处理姿态：

- **A. Default-on auto takeover**：新 master 启动遇到任何 lark-channel 老 master 就 SIGTERM 替换
- **B. Opt-in via config flag**：加个 `autoTakeover` 开关，默认 false 保留今天的 refuse 行为
- **C. Never takeover，只把错误做响亮**：完全让用户手动 kill

用户选择 **A**，理由：PID lock 的 1-of-1 invariant 本来就不容许"两个合法 master 同时活"。"升级时老的要让位"是 invariant 的自然延伸，不是新策略。

同时用户决定把四件小事打包成**同一个 spec**（而不是拆成 4 个）——它们围绕同一个失败模式（"升级后静默失败"），分开做容易有一个没做就忘了；合在一起也不大。

代码结构上，接管逻辑放进**新的 `src/shared/master-handoff.ts`**，而非扩展 `lock.ts`。`lock.ts` 保持"纯文件锁 + 死锁自愈"的单一职责，接管涉及的 `process.kill` / `execSync('ps')` / 轮询 不进去。

## 设计

### 1. 改动范围（4 件事）

| # | 件事 | 目的 | 体量 |
|---|---|---|---|
| T1 | `master-handoff.ts` + `master/index.ts` 编排 | 升级时自动 SIGTERM 老 master | ~80 行 + 测试 |
| T2 | `logger.ts`：error 级别永远走 stderr | 任何 error 都能从宿主终端看到，不依赖 debug 开关 | ~5 行 + 测试 |
| T3 | master 启动横幅：版本 + PID 写 debug.log 头 + stderr 一行 | 分辨新老 master 版本 | ~5 行 |
| T4 | README Troubleshooting："bot 不回复 / 无日志" | 手动兜底流程 | ~15 行 markdown |

不在本 spec 范围（YAGNI）：

- **heartbeat state.json / `/lark-channel:status`**：有用，但不是预防今天这个 bug 必需
- **fs.watch config.json 热重载**：复杂且只有 debug 字段真的能热重载，ROI 低
- **超时可配置**：10s SIGTERM + 2s SIGKILL 是合理默认，加 config 字段只是膨胀表面积

### 2. T1: Takeover 语义与实现

#### 2.1 契约

同一个 `appId` 在同一个 `storeDir` 下只能有**一个**活着的 lark-channel master。任何新启动的 master 负责保证这个 invariant，方式是**温和接管**——SIGTERM 老 master 给它机会跑 graceful shutdown（`master/index.ts:372-383` 已有：关 pool / bridge / WS，保留 tmux，unlink lock）。老 master 清退后新 master 再抢锁。

#### 2.2 启动编排（`master/index.ts`）

```
1. tryAcquireLock(lockPath)          ← lock.ts 不变
     acquired → 进入 3
     refused  → 进入 2

2. attemptTakeover(ownerPid, lockPath, logger)
     ok     → 再试一次 tryAcquireLock
                acquired → 进入 3
                refused  → 进入 4（罕见 race：takeover 成功后又被第三方抢先）
     fail   → 进入 4

3. 正常启动：createRootLogger → 版本横幅 → MCP 接入 → bridge listen → pool.start → WS.start

4. 醒目错误 + exit 1：多行 stderr 说明持有者 PID、takeover 结果 reason、手动修复 recipe
```

替换现在 `master/index.ts:54-58` 的：

```ts
const got = await tryAcquireLock(lockPath);
if (!got) {
  console.error('[master] another master is running; exiting');
  process.exit(0);
}
```

#### 2.3 `master-handoff.ts` 状态机

新模块 `src/shared/master-handoff.ts`，导出 `attemptTakeover(ownerPid, lockPath, logger, deps?)`。

返回类型：

```ts
type TakeoverResult =
  | { ok: true; method: 'SIGTERM' | 'SIGKILL'; elapsedMs: number }
  | { ok: false; reason: 'not-our-master' | 'ps-unavailable' | 'killproof' };
```

状态机：

```
a. verifyIsOurMaster(ownerPid):
     ps -o command= -p <pid> 输出非空、且含 "lark-channel"、且含 "src/index" 或 "tsx"
     false → return { ok: false, reason: 'not-our-master' }
     ps 本身执行失败（命令不存在等） → return { ok: false, reason: 'ps-unavailable' }

b. logger.error('[lark-channel] replacing old master pid=<X> — SIGTERM')
   process.kill(ownerPid, 'SIGTERM')

c. waitForExit(ownerPid, 10_000):
     每 200ms 做 process.kill(pid, 0)，直到 ESRCH 或 10s 超时
     死了 → return { ok: true, method: 'SIGTERM', elapsedMs }

d. 10s 超时：
     logger.error('unresponsive — SIGKILL')
     process.kill(ownerPid, 'SIGKILL')
     waitForExit(ownerPid, 2_000):
       死了 → return { ok: true, method: 'SIGKILL', elapsedMs: 10s + 那段 }
       还活 → return { ok: false, reason: 'killproof' }
```

#### 2.4 安全边界

- **`verifyIsOurMaster` 是硬门槛**：`ps` 看不出或签名不匹配一律拒绝接管。防止 PID 复用误杀（老 master 死了，OS 把该 PID 分配给别的进程，`process.kill(pid, 0)` 仍 OK，但 ps 签名会 mismatch）
- **`ps` 作为前置依赖**：macOS/Linux 都有；tmux 已经是硬依赖（README Requirements），再加一个 `ps` 不扩大支持面
- **Windows 不支持**：本项目本来就 unsupported
- **signal 失败吞掉**：`process.kill(ownerPid, 'SIGTERM')` 可能抛 EPERM（极罕见，比如跨 uid；macOS 日常场景下不会发生）；用 try/catch 包住，失败不中断流程——`waitForExit` 会自然走超时路径然后升级到 SIGKILL

#### 2.5 关键属性

- **Tmux 连续性自动保留**：老 master 的 SIGTERM handler 已经"保留 tmux、断 child socket"；新 master 的 `pool.start()` 已经"enumerate 已存在的 `lark-*` tmux 并 adopt 在 store 里有的"——takeover 走的是 `/reload-plugins` 一直以来就走的那条代码路径
- **Child 透明感知**：child 的 bridge-client 本来就有"socket 断开→指数退避重连"逻辑，老 master 退出到新 master 接管之间 child 看到的只是一次短暂 reconnect

### 3. T2: Logger error 永远到 stderr

`src/shared/logger.ts:35-42` 的 `write()` 改为：

```ts
private write(level: LogLevel, args: unknown[]): void {
  const line = this.format(level, args);
  // error 永远走 stderr；其他级别由 debug 开关门控
  if (level === 'error' || this.enabled) {
    console.error(line);
  }
  // 文件只在 debug=true 时写
  if (this.enabled && this.logFile) {
    try { fs.appendFileSync(this.logFile, line + '\n'); } catch {/* ignore */}
  }
}
```

`createRootLogger(tag, logsDir, debug=false)` 分支继续返回 `enabled=false` 的 logger，但这个 logger 对 error 不再 no-op。

**审阅义务**：扫所有 `.error()` 调用点，确认是真 error 不是警告噪声。当前（2026-04-24 已看过）：

- `src/master/pool.ts`: 4 处（attemptSpawn 绝望、appendSystemPromptFile 校验失败、spawn tmux 失败）——全部真 error
- `src/master/bridge-server.ts` / `src/master/index.ts` / `src/child/*`: 需要实施时扫一遍

如有噪声点，降级为 `.warn()` 而非修改 logger 语义。

### 4. T3: 启动横幅

`src/master/index.ts` 在 `createRootLogger` 和 `rootLogger.info` 附近（当前 L61-L62）扩成：

```ts
const pkgVersion = readPackageVersion(); // 从插件自身 package.json 读
const rootLogger = createRootLogger('master', cfg.logsDir, cfg.debug);
rootLogger.info(`startMaster pid=${process.pid} version=${pkgVersion} storeDir=${cfg.storeDir} scopeMode=${cfg.scopeMode} debug=${cfg.debug}`);
console.error(`[lark-channel] master v${pkgVersion} ready (pid=${process.pid})`);
```

`readPackageVersion()` 用 `import.meta.url` 或 `__dirname` 定位当前文件，再往上找到 `package.json` 读 `version` 字段。找不到兜底为 `'unknown'`。

原因不直接从 `'0.1.1'` 字符串硬编：今天早上的 incident 根源之一就是版本漂移——代码里说 A、实际是 B；从 `package.json` 唯一源读是防再犯。

MCP server 声明里也有个硬编的 `version: '0.1.1'`（`master/index.ts` 附近的 `new McpServer({ name, version })`）——借机也改成读 `pkgVersion`，一起消灭硬编。

### 5. T4: README Troubleshooting

`README.md` 现有 "## Troubleshooting" 段追加一个新 bullet：

```markdown
- **Bot silently not replying / no logs appearing**: usually means a zombie master from a previous plugin version is holding the lock. Since v0.1.2 the new master auto-takes-over on startup; if the startup banner never appeared (or you see `✗ cannot acquire lock`), inspect manually:
  ```bash
  cat ~/.claude/channels/lark-channel/master-*.lock    # 持有者 PID
  ps -p <pid>                                            # 确认进程身份
  ```
  如果它是 lark-channel master 但 takeover 没生效，`kill <pid>` 后 `/reload-plugins` 即可。如果它不是 lark-channel 进程，调查为什么锁文件会指向一个无关进程（可能是上一个 master crash 时 lock 没清 + PID 被复用）。
```

### 6. 测试

#### T1 — `tests/shared/master-handoff.test.ts`（新建）

通过依赖注入测试，不 spawn 真进程：

```ts
attemptTakeover(ownerPid, lockPath, logger, {
  runPs: (pid) => string | null,      // 注入 ps 返回
  sendSignal: (pid, sig) => void,     // 注入 process.kill（抛/不抛由测试决定）
  probeAlive: (pid) => boolean,       // 注入 "死没死" 探针
  now: () => number,                  // 假时钟
  sleep: (ms) => Promise<void>,       // 假 sleep
});
```

测试点：

1. `ps` 返回不含 lark-channel 签名 → `{ ok: false, reason: 'not-our-master' }`，且 `sendSignal` 从未被调用
2. `ps` 命令失败（注入抛错）→ `{ ok: false, reason: 'ps-unavailable' }`
3. SIGTERM 后第 2 次 probe 就 dead → `{ ok: true, method: 'SIGTERM' }`
4. SIGTERM 后 10s 还活 + SIGKILL 后 0.4s 内死 → `{ ok: true, method: 'SIGKILL' }`
5. SIGTERM + SIGKILL 都打不死 → `{ ok: false, reason: 'killproof' }`
6. SIGTERM 抛 EPERM → 仍进入 waitForExit，最终走到 SIGKILL 路径

关于 `master/index.ts` 的编排分支：不单测（需要 mock lock + handoff 两个模块，架构上没意义），靠 smoke 覆盖。

#### T2 — `tests/shared/logger.test.ts`（新建）

通过临时目录 + stderr capture：

1. `debug=false` + `logger.error(...)` → stderr 有、文件不存在
2. `debug=false` + `logger.info/warn/debug(...)` → stderr 无、文件不存在
3. `debug=true` + 任意级别 → stderr 有 + 文件 append 有

#### T3 — 不单测

一行 log + 一行 console.error，trivial。靠 smoke 覆盖（启动 master → stderr 看到 `master v<X> ready`）。

#### T4 — 不测（纯 markdown）

#### 手动 smoke（追加到 `scripts/smoke-test.md`）

新增一节 "## Auto takeover on upgrade (spec 2026-04-24)"：

- [ ] **Happy path**：跑老版 master（可以简单地用 `npm run start` 起 v0.1.1，先让它占锁），再开一个窗口 `npm run start`。第二个应该打 `replacing old master pid=X — SIGTERM` 然后 `master vX.Y.Z ready`，第一个 window 跑了 graceful shutdown
- [ ] **Non-our-master refusal**：用 `echo $$ > master-<appId>.lock` 把锁指向当前 shell 的 PID，然后起 master。它应该判 `not-our-master`、exit 1、打醒目错误。删掉 lock 再起就正常
- [ ] **SIGKILL fallback**：人为构造一个 hang 住的 lark-channel 进程（比如一个 `node -e 'process.on("SIGTERM",()=>{}); setInterval(()=>{},1e9)'` 改掉 argv 让 ps 显示 lark-channel）… 这个场景太人工，smoke 不做，只单测
- [ ] **Debug=false error visibility**：config 里 `debug: false`，跑 master 起不来的场景（比如故意把 `appendSystemPromptFile` 指向一个存在但无读权限的文件），应该能从**启动 master 的终端 stderr** 看到错误行；debug.log 文件不应被创建

## 风险与未决项

1. **读 `package.json` 的路径定位**：`import.meta.url` + `new URL('../../package.json', ...)` 或 `fileURLToPath`。ESM 下要小心 `bundle` 行为；实施时第 1 步验证并 fallback 到 `'unknown'`
2. **`ps` 命令输出格式在不同 OS 下略有差异**：macOS `ps -o command=` vs Linux `ps -o cmd=`。`command=` macOS 上有、Linux 上也有（POSIX）。实施时跑一下 `ps -o command= -p $$` 确认
3. **takeover 时间 10s + 2s 是否够**：master 的 graceful shutdown 要关 pool、bridge、WS。bridge-server 关闭时对所有 child 连接做 `close`，child 这边是异步的；WS 关是 lib 内部异步。实测应该 <1s 就走完，10s 上限极度宽裕。但 smoke 时观察一下实际 elapsed
4. **不做 race mitigation**：两个 host claude 并发 `/reload-plugins` 可能触发 takeover 互相打架，出现短暂 bounce。概率低、自愈（PID lock 最终只有一个活着）、文档里提一句够了

## 实施顺序（将进入 writing-plans）

1. T2：logger error 永远到 stderr（最小风险，先做 → 后面所有步骤的 error 都能看到）
2. T1a：`src/shared/master-handoff.ts` + 单测（纯模块，不 touch master index）
3. T1b：`src/master/index.ts` 编排 + `exit(0)` 兜底改成 `exit(1)` + 醒目错误文案
4. T3：startup 横幅 + MCP version 读 package.json
5. T4：README Troubleshooting
6. smoke-test.md 追加
