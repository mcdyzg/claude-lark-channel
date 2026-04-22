# Thread/Parent Context Images — 设计文档

- **日期**：2026-04-22
- **作者**：loujiahao@bytedance.com
- **状态**：设计（待实现）
- **关联**：延续 `2026-04-21-claude-lark-channel-design.md`（v0.1 基线）

---

## 1. 背景与目标

### 1.1 观察到的问题

用户在话题（thread）下 @bot 时，话题根帖携带的图片**未传达给 Claude**。典型案例：
- 根帖（thread root）：用户贴了一张树形组件的截图 + 文字"这是一个树形组件的问题"
- 跟帖：用户发 "@bot 分析下这个问题"
- bot 回复："但这条消息里没有看到具体的问题内容"——它**只看到了根帖的文字**，图片丢了

### 1.2 根因

| 环节 | 当前行为 |
|---|---|
| 当前消息图片抽取 | ✅ `handleInbound` 直接处理 `image` / `post` 两种 msg_type，下载 inbox |
| `fetchThreadRoot` | ⚠️ 只用 `extractPlainText` 取文字，丢弃 `image_key` |
| `resolveThreadBackground` | ⚠️ 返回 `string`（仅 text），master 推 background 帧时没带图片元信息 |
| `parent_id` 事件 | ❌ 完全未处理（不拉 parent 文本、不拉 parent 图片） |

### 1.3 目标

向 Claude 传达以下上下文的图片：

1. **话题根帖的图片**（首次在该 scope @bot 时注入）
2. **引用回复 parent 消息的图片 + 文字**（每次有 `parent_id` 事件都处理）

### 1.4 非目标

- 话题内非根帖、非 parent 的其他历史消息的图片（过度抓取，风险大于收益）
- `fetchChatHistory`（chat 模式的群历史）里的图片（历史条数多，回拉图会失控）
- 图片数量上限 / 速率限制（MVP 不做，出现滥用再补）
- parent 懒下载（parent 图片同步下载到 inbox，和 root 一致）

---

## 2. 对标 claude-lark-plugin

| 项 | claude-lark-plugin | 本设计 |
|---|---|---|
| `parent_id` 拉 parent 文本 | ✅ `parentContent` | ✅ `parent_content` |
| 下载 parent 图片 | ❌ | ✅ `parent_image_path(s)` |
| `thread_id` 根帖抓图 | N/A（它把 threadId 作记忆标签，没根帖注入概念） | ✅ 根帖 image_keys 下到 inbox |

我们比 claude-lark-plugin 多一步"下 parent 图"，其余行为对齐（字段命名、meta 传递方式）。

---

## 3. 代码结构变化

### 3.1 新增 / 修改文件清单

| 文件 | 改动性质 | 说明 |
|---|---|---|
| `src/master/message-parser.ts` | 新增导出 | `extractImageKeys(messageType, rawContent): string[]` —— 纯函数，text/image/post 三种都支持 |
| `src/master/feishu-client.ts` | 修改 | `fetchThreadRoot` 返回类型增加 `imageKeys: string[]`；新增 `fetchMessage(messageId)` |
| `src/master/bootstrap.ts` | 修改 | `resolveThreadBackground` 返回 `{ text, imageKeys } \| null`；`ThreadRoot` 接口加 `imageKeys` |
| `src/master/index.ts` | 修改 | handleInbound 里 (a) 用新 helper 替换重复代码；(b) 新增 parent 路径；(c) 下载 root 图片后塞 meta |
| `src/types.ts` | 修改 | `LarkMessage` 可选加 `parentImagePath` / `parentImagePaths`（和 imagePath/imagePaths 对称） |
| `tests/master/message-parser.test.ts` | 新增 6 个用例 | `extractImageKeys` 的覆盖 |
| `tests/master/bootstrap.test.ts` | 更新 | 现有用例调整返回形状；新增 1 个"root 有 imageKeys" |

### 3.2 接口契约

```ts
// message-parser.ts
export function extractImageKeys(messageType: string, rawContent: string): string[];

// feishu-client.ts
export interface ThreadRoot {
  messageId: string;
  text: string;
  imageKeys: string[];      // NEW — 只是 key，master 负责下载
  createTime: number;
}

export interface FetchedMessage {
  messageId: string;
  text: string;
  imageKeys: string[];
  createTime: number;
}

export async function fetchThreadRoot(client, threadId): Promise<ThreadRoot | null>;      // shape 变了
export async function fetchMessage(client, messageId): Promise<FetchedMessage | null>;    // NEW

// bootstrap.ts
export interface ThreadBackground {
  text: string;                   // "【话题背景】\n<root text>" 或 "[非文本消息]"
  imageKeys: string[];
}
export async function resolveThreadBackground(
  event, scope, fetcher
): Promise<ThreadBackground | null>;    // shape 变了
```

---

## 4. Meta Schema 增量

### 4.1 Background 帧（首次 scope 注入）

**Before：**
```json
{ "kind": "background", "scope_key": "thread:oc_x:t_y" }
```

**After：**
```json
{
  "kind": "background",
  "scope_key": "thread:oc_x:t_y",
  "image_path": "/Users/.../inbox/1713700000-img_abc.png",
  "image_paths": "/path/a.png,/path/b.png"
}
```

规则（和现有 current-message 字段一致）：
- 1 张图 → `image_path`（单数）
- 多张图 → `image_paths`（逗号分隔）
- 无图 → 两字段都不写

### 4.2 正文帧（当前消息，带 parent）

**Before：**
```json
{
  "chat_id": "oc_x",
  "message_id": "om_y",
  "user_id": "ou_z",
  "chat_type": "group",
  "thread_id": "t_abc",
  "scope_key": "thread:oc_x:t_abc",
  "ts": "2026-04-22T...",
  "image_path": "/path/own.png"
}
```

**After（新增 4 个可选字段，仅在 `parent_id` 存在时写）：**
```json
{
  ...(原字段),
  "parent_message_id": "om_parent",
  "parent_content": "这是一个树形组件的问题",
  "parent_image_path": "/Users/.../inbox/1713700000-img_root.png",
  "parent_image_paths": "/a.png,/b.png"
}
```

规则：
- `parent_content`：parent 消息的 plain text（空字符串也写，便于 Claude 分辨"parent 有内容"和"无 parent"）
- `parent_image_path` / `parent_image_paths`：同上，单/多/无三态

### 4.3 Child / MCP 层面无改动

`notifications/claude/channel` 的 params 结构不变（`{content, meta}`）。只是 `meta` 字段集合扩充。Claude 侧按 meta 里的路径自行 Read 就行。

---

## 5. 数据流

```
飞书 im.message.receive_v1
  │
  ▼
handleInbound:
  1. 基础解析/过滤（未变）
  2. extractImageKeys(messageType, rawContent)  —— 替换原重复代码
  3. 下载自己的 images → imagePath/imagePaths
  4. 【新】 if (parent_id):
       parent = fetchMessage(client, parent_id)
       parentImagePaths = await Promise.all(parent.imageKeys.map(k => downloadAttachment(...)))
       // 下述字段后续填入正文帧 meta：
       //   parent_message_id, parent_content, parent_image_path(s)
  5. resolveScopeKey → pool.ensure → 等 child ready
  6. if (!session.rootInjected && scopeMode==thread && threadId):
       bg = resolveThreadBackground(...)    //  { text, imageKeys } | null
       if (bg):
         rootImagePaths = await Promise.all(bg.imageKeys.map(k => downloadAttachment(client, root.messageId, k, 'image', inbox)))
         bridge.push(scopeKey, bg.text, {
           kind: 'background',
           scope_key,
           ...(image_path / image_paths from rootImagePaths)
         })
       session.rootInjected = true; save
  7. 构建 meta（含 parent_*）+ bridge.push 正文帧
```

并发：step 3、4、5 可用 `Promise.all` 并行化（独立 I/O），但 MVP 先串行保持代码简单，未来有延迟瓶颈再优化。

---

## 6. 失败与降级

| 场景 | 处理 |
|---|---|
| `fetchMessage(parent_id)` 网络失败 / 权限不够 | 记 warn 日志；parent_* 字段全部不写；正文照推。不让单次失败阻死消息 |
| parent 返回空 / 非 text/image/post | `parent_content = ''`, imageKeys=[]，依然在 meta 里写空 `parent_message_id` 表示"parent 存在但无可提取内容" |
| parent 图片下载失败 | 失败的 key 跳过，剩下的正常拼 `parent_image_paths`；0 张图 → 字段不写 |
| `fetchThreadRoot` 失败 | 已有行为不变：返回 null → 不推 background，session.rootInjected 设 true 避免后续重试 |
| root 抽到 imageKeys 但全部下载失败 | 推 background 文本帧但不带 image_* 字段；log warn |
| parent_id 指向的消息就是 thread root | 不做去重判断；parent 路径和 background 路径独立各干各的。同一张图会被下载两次（不同文件名）、两处 meta 都引用。可接受（简单，Claude 读到两张相同内容的图不会出错） |

---

## 7. 测试

### 7.1 单元测试

**`tests/master/message-parser.test.ts`（新增 6 个用例）：**

```ts
describe('extractImageKeys', () => {
  it('image — returns [image_key]', ...);
  it('post single img — returns [key]', ...);
  it('post multiple img across lines — returns all keys', ...);
  it('text — returns []', ...);
  it('file — returns []', ...);
  it('malformed JSON — returns []', ...);
});
```

**`tests/master/bootstrap.test.ts`（调整）：**
- 所有 `resolveThreadBackground` 返回断言从 `'【话题背景】\n...'` 字符串改成 `{ text: '【话题背景】\n...', imageKeys: [] }`
- 新增 1 个用例：`fetcher` 返回带 `imageKeys: ['k1', 'k2']` 的 ThreadRoot → 断言返回对象 imageKeys 透出

### 7.2 集成 / 手工烟测

追加到 `scripts/smoke-test.md`：

- [ ] 话题下发图片+文字作为根帖；第二条消息 `@bot 分析下这张图`（无 parent_id）→ Claude 回复应该识别出根帖里的图的内容
- [ ] 在已有对话里，引用（quote-reply）一条带图的消息并 `@bot`（`parent_id` 非空）→ Claude 回复应引用 parent 图的内容
- [ ] 根帖无图、正文也无图、无 parent（回归）→ 行为不变，正常回复
- [ ] 同一张图同时出现在根帖和 parent → 都收到，Claude 回复不崩（内容重复无伤）

### 7.3 不做

- 自动化 E2E（依赖真飞书 app）
- `fetchMessage` 的单测（薄 SDK 包装）

---

## 8. 兼容性与风险

- **配置不变**：`config.json` 无新字段
- **bridge 协议不变**：只是 meta 扩充，前向兼容
- **child plugin 不改代码**：它只是透传 meta 到 `notifications/claude/channel`
- **会话持久化不变**：Session JSON 不加字段
- **破坏性变更**：
  - `ThreadRoot` / `resolveThreadBackground` 返回类型变化 → 破坏 master 的单一 caller，同步修即可；没有其他 caller
- **性能**：
  - 每条带 `parent_id` 的消息多一次 Feishu API 调用（fetchMessage）+ 图片下载
  - 每个新 scope 首次触发时多若干张 root 图片下载
  - 只影响带 parent 或新 scope 的冷启路径，常态消息零开销
- **资源**：下载的图片一直堆在 inbox（和原本一样），不在本期清理

---

## 9. 验收

MVP 完成需：

- [ ] `npm run typecheck` 0 错误
- [ ] `npm test` 全绿（原 50 + 新增 7 = 57）
- [ ] 话题根帖带图场景：Claude 能识图回复（手工飞书验证）
- [ ] quote-reply 带图场景：Claude 能识图回复（手工飞书验证）
- [ ] 回归：根帖/parent 都无图的普通流程完全不变

---

## 10. 开放问题（实现时可现场判）

1. **parent 消息是 bot 自己发的**：要不要跳过？
   - 先不跳过 —— 用户可能引用 bot 早前的输出继续追问，parent_content 仍然有用。只过滤 `sender.sender_type === "app"` 和 bot 自己 open_id 一致的情况是可选的后续优化。

2. **extractImageKeys 是否处理 `post` 的 locale 包裹外层 content**：
   - 要兼容 `parsed.zh_cn.content` / `parsed.en_us.content` / `parsed.content` 三种位置（和 `extractPlainText` 对齐）

3. **parent/root 图片的 message_id 怎么传给 downloadAttachment**：
   - `downloadAttachment(client, messageId, fileKey, kind, inbox)` 的 messageId 用**那张图所在的消息 id**（root 图用 root.messageId，parent 图用 parent.messageId），不是当前 @bot 消息的 id。`messageResource.get` 需要正确的 message_id/file_key 组合
