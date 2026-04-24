# Thread/Parent Context Images — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When users @bot in a thread, ensure Claude also receives: (1) images attached to the thread root; (2) text + images from the parent message when the inbound event is a quote-reply (`parent_id` set).

**Architecture:** Add a pure helper `extractImageKeys()` unifying image-key extraction from `image` / `post` message types; extend `fetchThreadRoot` to surface root `imageKeys`; add `fetchMessage()` for on-demand quote-reply parent fetch; have master download those extra images synchronously and include them in channel_push meta (`image_path(s)` on background frame; `parent_content` / `parent_image_path(s)` on main frame).

**Tech Stack:** TypeScript, Node 20+ ESM, `@larksuiteoapi/node-sdk`, `@modelcontextprotocol/sdk`, vitest.

**Spec:** `docs/superpowers/specs/2026-04-22-thread-context-images-design.md`

---

## File Structure

Files modified / created in this plan:

```
claude-lark-channel/
├── src/
│   └── master/
│       ├── message-parser.ts          # Task 1: +extractImageKeys; Task 4: refactor handleInbound callsite (no — handleInbound is in index.ts)
│       ├── feishu-client.ts           # Task 2: ThreadRoot.imageKeys; new fetchMessage()
│       ├── bootstrap.ts               # Task 3: resolveThreadBackground return shape
│       └── index.ts                   # Task 4/5/6: handleInbound changes (refactor + root images + parent path)
├── tests/
│   └── master/
│       ├── message-parser.test.ts     # Task 1: +6 tests
│       └── bootstrap.test.ts          # Task 3: shape migration + 1 new test
└── scripts/
    └── smoke-test.md                  # Task 7: new checklist items
```

No new files. src/types.ts does NOT need changing (the new parent fields live directly in the channel_push meta object, not in the `LarkMessage` type — master builds meta inline and doesn't need LarkMessage fields for parent.)

---

## Phase 1 — `extractImageKeys` pure helper (TDD)

### Task 1.1: Write failing tests

**Files:**
- Modify: `/Users/bytedance/haha/x/agent/claude-about/claude-lark-channel/tests/master/message-parser.test.ts`

- [ ] **Step 1: Append 6 tests to `tests/master/message-parser.test.ts`**

Append at end of file (after existing describes):

```ts
import { extractImageKeys } from '../../src/master/message-parser.js';

describe('extractImageKeys', () => {
  it('image type — returns [image_key]', () => {
    expect(extractImageKeys('image', JSON.stringify({ image_key: 'img_abc' })))
      .toEqual(['img_abc']);
  });

  it('post with single inline img — returns [key]', () => {
    const raw = JSON.stringify({
      zh_cn: {
        content: [
          [
            { tag: 'text', text: 'hello' },
            { tag: 'img', image_key: 'img_xyz' },
          ],
        ],
      },
    });
    expect(extractImageKeys('post', raw)).toEqual(['img_xyz']);
  });

  it('post with multiple imgs across lines — returns all keys in order', () => {
    const raw = JSON.stringify({
      content: [
        [{ tag: 'img', image_key: 'k1' }],
        [{ tag: 'text', text: 'middle' }],
        [{ tag: 'img', image_key: 'k2' }, { tag: 'img', image_key: 'k3' }],
      ],
    });
    expect(extractImageKeys('post', raw)).toEqual(['k1', 'k2', 'k3']);
  });

  it('post with en_us locale wrapper — handles it', () => {
    const raw = JSON.stringify({
      en_us: {
        content: [[{ tag: 'img', image_key: 'en_key' }]],
      },
    });
    expect(extractImageKeys('post', raw)).toEqual(['en_key']);
  });

  it('text — returns []', () => {
    expect(extractImageKeys('text', JSON.stringify({ text: 'hello' }))).toEqual([]);
  });

  it('file — returns []', () => {
    expect(extractImageKeys('file', JSON.stringify({ file_key: 'f1', file_name: 'a.pdf' }))).toEqual([]);
  });

  it('malformed JSON — returns []', () => {
    expect(extractImageKeys('image', 'not json')).toEqual([]);
    expect(extractImageKeys('post', '<!html>')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run — expect fail**

```bash
cd /Users/bytedance/haha/x/agent/claude-about/claude-lark-channel
npm test -- tests/master/message-parser.test.ts 2>&1 | tail -20
```
Expected: FAIL with error about `extractImageKeys` not being exported (or import resolution error).

### Task 1.2: Implement `extractImageKeys`

**Files:**
- Modify: `/Users/bytedance/haha/x/agent/claude-about/claude-lark-channel/src/master/message-parser.ts`

- [ ] **Step 1: Append export**

Append after `extractAttachments` function at the end of `src/master/message-parser.ts`:

```ts
/**
 * 从 `image` / `post` 消息的 raw content 抽取 image_key 列表。
 * - image: 返回 [parsed.image_key]
 * - post:  深度遍历 content/zh_cn.content/en_us.content，收集所有 node.tag === 'img' 的 image_key
 * - 其他 msg_type / 解析失败：[]
 */
export function extractImageKeys(messageType: string, rawContent: string): string[] {
  let parsed: any;
  try {
    parsed = JSON.parse(rawContent);
  } catch {
    return [];
  }

  if (messageType === 'image') {
    return parsed?.image_key ? [parsed.image_key] : [];
  }

  if (messageType === 'post') {
    const content = parsed?.content ?? parsed?.zh_cn?.content ?? parsed?.en_us?.content ?? [];
    const keys: string[] = [];
    for (const line of content) {
      if (!Array.isArray(line)) continue;
      for (const node of line) {
        if (node?.tag === 'img' && node?.image_key) {
          keys.push(node.image_key);
        }
      }
    }
    return keys;
  }

  return [];
}
```

- [ ] **Step 2: Typecheck**

```bash
cd /Users/bytedance/haha/x/agent/claude-about/claude-lark-channel
npm run typecheck 2>&1 | tail -5
```
Expected: exit 0 (no errors).

- [ ] **Step 3: Run tests — expect pass**

```bash
npm test -- tests/master/message-parser.test.ts 2>&1 | tail -15
```
Expected: all previous parser tests pass + 7 new extractImageKeys tests pass.

- [ ] **Step 4: Commit**

```bash
cd /Users/bytedance/haha/x/agent/claude-about/claude-lark-channel
git add src/master/message-parser.ts tests/master/message-parser.test.ts
git -c user.email=loujiahao@bytedance.com -c user.name=loujiahao commit -m "feat(parser): add extractImageKeys for image/post types"
```

---

## Phase 2 — `feishu-client` extensions

### Task 2.1: Extend `fetchThreadRoot` to surface `imageKeys`; add `fetchMessage`

**Files:**
- Modify: `/Users/bytedance/haha/x/agent/claude-about/claude-lark-channel/src/master/feishu-client.ts`

No test file — thin SDK wrappers covered by Phase 6 manual smoke per spec §7.3.

- [ ] **Step 1: Update imports**

Find the existing dynamic import pattern in `fetchThreadRoot`:
```ts
const { extractPlainText } = await import('./message-parser.js');
```

Replace both occurrences (in `fetchThreadRoot` and `fetchChatHistory`) with:
```ts
const { extractPlainText, extractImageKeys } = await import('./message-parser.js');
```

Note: `fetchChatHistory` doesn't need `extractImageKeys` (spec §1.4 — chat history text-only), but sharing the import costs nothing; leave it out to keep imports tidy. Use `extractPlainText` only in `fetchChatHistory`. Only `fetchThreadRoot` and the new `fetchMessage` import both.

- [ ] **Step 2: Update `fetchThreadRoot` return type + body**

Find the existing signature:
```ts
export async function fetchThreadRoot(
  client: Lark.Client,
  threadId: string,
): Promise<{ messageId: string; text: string; createTime: number } | null> {
```

Change to (also export a named interface for clarity):
```ts
export interface ThreadRoot {
  messageId: string;
  text: string;
  imageKeys: string[];
  createTime: number;
}

export async function fetchThreadRoot(
  client: Lark.Client,
  threadId: string,
): Promise<ThreadRoot | null> {
```

Inside the function, after `const text = extractPlainText(msgType, raw);` and before `const messageId = ...`, insert:
```ts
    const imageKeys = extractImageKeys(msgType, raw);
```

Update the return statement:
```ts
    return {
      messageId,
      text,
      imageKeys,
      createTime: Number.isFinite(createTime) ? createTime : Date.now(),
    };
```

(The `extractImageKeys` symbol must be in the dynamic import on the line above.)

- [ ] **Step 3: Add `fetchMessage`**

Append after `fetchChatHistory` at the end of the file:

```ts
/**
 * 拉单条消息（用于处理 parent_id 引用回复）。
 * 失败统一返回 null，调用方做降级。
 */
export interface FetchedMessage {
  messageId: string;
  text: string;
  imageKeys: string[];
  createTime: number;
}

export async function fetchMessage(
  client: Lark.Client,
  messageId: string,
): Promise<FetchedMessage | null> {
  if (!messageId) return null;
  try {
    const resp: any = await client.im.v1.message.get({
      path: { message_id: messageId },
    } as any);
    const item = resp?.data?.items?.[0];
    if (!item) return null;
    const msgType = item.msg_type ?? 'text';
    const raw = item.body?.content ?? '';
    const { extractPlainText, extractImageKeys } = await import('./message-parser.js');
    const text = extractPlainText(msgType, raw);
    const imageKeys = extractImageKeys(msgType, raw);
    const createTime = item.create_time
      ? parseInt(String(item.create_time), 10)
      : Date.now();
    return {
      messageId: item.message_id ?? messageId,
      text,
      imageKeys,
      createTime: Number.isFinite(createTime) ? createTime : Date.now(),
    };
  } catch (err) {
    console.error('[feishu] fetchMessage failed:', err);
    return null;
  }
}
```

- [ ] **Step 4: Typecheck**

```bash
cd /Users/bytedance/haha/x/agent/claude-about/claude-lark-channel
npm run typecheck 2>&1 | tail -5
```
Expected: exit 0.

Note: typecheck will likely flag bootstrap.ts / master/index.ts for type mismatches because `ThreadRoot` grew `imageKeys`. Those get fixed in Phase 3 and 4. **If typecheck surfaces only those downstream errors**, still proceed to commit — they resolve in subsequent tasks. If there are errors inside `feishu-client.ts` itself, fix before committing.

If typecheck fails only with `src/master/bootstrap.ts` or `src/master/index.ts` errors about `imageKeys` missing on the ThreadRoot object literals / property access, that's expected — continue to Step 5.

- [ ] **Step 5: Commit**

```bash
cd /Users/bytedance/haha/x/agent/claude-about/claude-lark-channel
git add src/master/feishu-client.ts
git -c user.email=loujiahao@bytedance.com -c user.name=loujiahao commit -m "feat(feishu-client): surface imageKeys on ThreadRoot; add fetchMessage"
```

---

## Phase 3 — `bootstrap` return shape change

### Task 3.1: Update `resolveThreadBackground` to return `{ text, imageKeys }`

**Files:**
- Modify: `/Users/bytedance/haha/x/agent/claude-about/claude-lark-channel/src/master/bootstrap.ts`
- Modify: `/Users/bytedance/haha/x/agent/claude-about/claude-lark-channel/tests/master/bootstrap.test.ts`

**Approach:** We flip existing tests to the new return shape first (they'll fail because implementation still returns string), add a new test for imageKeys passthrough, then change the implementation.

- [ ] **Step 1: Update tests to new shape + add new test**

Open `tests/master/bootstrap.test.ts` and update the `resolveThreadBackground` test block. Replace assertions that compare against strings with `{ text, imageKeys }` objects. Also update the fetcher mocks to return the new `ThreadRoot` shape (with `imageKeys` field).

Replace the entire `describe('resolveThreadBackground', () => { ... })` block with:

```ts
describe('resolveThreadBackground', () => {
  it('returns null when scope != thread', async () => {
    const r = await resolveThreadBackground(
      { chatId: 'c', threadId: 't', messageId: 'm' },
      'chat',
      async () => null,
    );
    expect(r).toBeNull();
  });

  it('returns null when no threadId', async () => {
    const r = await resolveThreadBackground(
      { chatId: 'c', messageId: 'm' },
      'thread',
      async () => null,
    );
    expect(r).toBeNull();
  });

  it('returns null when current message is thread root', async () => {
    const fetcher = vi.fn(async () => ({
      messageId: 'm1',
      text: 'root text',
      imageKeys: [],
      createTime: 0,
    }));
    const r = await resolveThreadBackground(
      { chatId: 'c', threadId: 't', messageId: 'm1' },
      'thread',
      fetcher,
    );
    expect(r).toBeNull();
  });

  it('returns { text, imageKeys } with root text', async () => {
    const fetcher = vi.fn(async () => ({
      messageId: 'm_root',
      text: 'initial topic',
      imageKeys: [],
      createTime: 0,
    }));
    const r = await resolveThreadBackground(
      { chatId: 'c', threadId: 't', messageId: 'm2' },
      'thread',
      fetcher,
    );
    expect(r).toEqual({ text: '【话题背景】\ninitial topic', imageKeys: [] });
  });

  it('returns null when fetcher throws', async () => {
    const r = await resolveThreadBackground(
      { chatId: 'c', threadId: 't', messageId: 'm2' },
      'thread',
      async () => {
        throw new Error('boom');
      },
    );
    expect(r).toBeNull();
  });

  it('uses placeholder for empty root text', async () => {
    const fetcher = async () => ({
      messageId: 'm_root',
      text: '',
      imageKeys: [],
      createTime: 0,
    });
    const r = await resolveThreadBackground(
      { chatId: 'c', threadId: 't', messageId: 'm2' },
      'thread',
      fetcher,
    );
    expect(r).toEqual({ text: '【话题背景】\n[非文本消息]', imageKeys: [] });
  });

  it('passes through imageKeys from root', async () => {
    const fetcher = async () => ({
      messageId: 'm_root',
      text: '看这张图',
      imageKeys: ['img_aaa', 'img_bbb'],
      createTime: 0,
    });
    const r = await resolveThreadBackground(
      { chatId: 'c', threadId: 't', messageId: 'm_follow' },
      'thread',
      fetcher,
    );
    expect(r).toEqual({
      text: '【话题背景】\n看这张图',
      imageKeys: ['img_aaa', 'img_bbb'],
    });
  });
});
```

Leave `describe('resolveChatHistoryBackground', ...)` untouched — chat history stays text-only per spec §1.4.

- [ ] **Step 2: Run tests — expect fail**

```bash
cd /Users/bytedance/haha/x/agent/claude-about/claude-lark-channel
npm test -- tests/master/bootstrap.test.ts 2>&1 | tail -15
```
Expected: 7 failures in `resolveThreadBackground` block (return type mismatch: test expects object, impl returns string). Other tests (including `resolveChatHistoryBackground`) pass.

- [ ] **Step 3: Update `bootstrap.ts` implementation**

Open `src/master/bootstrap.ts` and update:

1. Find the `ThreadRoot` interface. Add `imageKeys`:
```ts
export interface ThreadRoot {
  messageId: string;
  text: string;
  imageKeys: string[];
  createTime: number;
}
```

2. Add a new interface:
```ts
export interface ThreadBackground {
  text: string;
  imageKeys: string[];
}
```

3. Change `resolveThreadBackground` signature return type from `Promise<string | null>` to `Promise<ThreadBackground | null>`, and rewrite the last 3 lines of the function body:

Old tail:
```ts
  if (root.messageId === event.messageId) return null;
  const text = root.text.length > 0 ? root.text : NON_TEXT_PLACEHOLDER;
  return `${THREAD_PREFIX}${text}`;
```

New tail:
```ts
  if (root.messageId === event.messageId) return null;
  const bodyText = root.text.length > 0 ? root.text : NON_TEXT_PLACEHOLDER;
  return {
    text: `${THREAD_PREFIX}${bodyText}`,
    imageKeys: root.imageKeys ?? [],
  };
```

- [ ] **Step 4: Typecheck**

```bash
cd /Users/bytedance/haha/x/agent/claude-about/claude-lark-channel
npm run typecheck 2>&1 | tail -5
```

Expected: `src/master/index.ts` will still fail on the background push line because `background` is used as `string` but is now an object. That's addressed in Phase 4.

If typecheck fails ONLY on `src/master/index.ts` about `bridge.push(..., background, ...)` or `background.length`, proceed to Step 5. If failures are inside `bootstrap.ts`, fix before committing.

- [ ] **Step 5: Run bootstrap tests — expect pass**

```bash
npm test -- tests/master/bootstrap.test.ts 2>&1 | tail -10
```
Expected: All `resolveThreadBackground` tests pass (now 7 cases) + `resolveChatHistoryBackground` tests unchanged pass.

- [ ] **Step 6: Commit**

```bash
cd /Users/bytedance/haha/x/agent/claude-about/claude-lark-channel
git add src/master/bootstrap.ts tests/master/bootstrap.test.ts
git -c user.email=loujiahao@bytedance.com -c user.name=loujiahao commit -m "feat(bootstrap): resolveThreadBackground returns {text, imageKeys}"
```

---

## Phase 4 — `handleInbound` root image download + background meta

### Task 4.1: Refactor own-message image extraction + download root images + push with meta

**Files:**
- Modify: `/Users/bytedance/haha/x/agent/claude-about/claude-lark-channel/src/master/index.ts`

This task has three coupled changes. Splitting would mean re-reading + re-editing `handleInbound` three times; cleaner to do in one pass.

- [ ] **Step 1: Add `extractImageKeys` to imports**

Find the existing import from message-parser (around line 19):
```ts
import { extractPlainText, extractAttachments } from './message-parser.js';
```

Change to:
```ts
import { extractPlainText, extractAttachments, extractImageKeys } from './message-parser.js';
```

- [ ] **Step 2: Refactor own-message image extraction**

Find the block in `handleInbound` that starts with:
```ts
    // 同步下载图片到 inbox
    let imagePath: string | undefined;
    let imagePaths: string[] | undefined;
    if (messageType === 'image') {
      try {
        const parsed = JSON.parse(rawContent);
        if (parsed.image_key) {
          const d = await downloadAttachment(client, messageId, parsed.image_key, 'image', cfg.inboxDir);
          imagePath = d.path;
        }
      } catch {/* ignore */}
    } else if (messageType === 'post') {
      try {
        const parsed = JSON.parse(rawContent);
        const content = parsed.content ?? parsed.zh_cn?.content ?? parsed.en_us?.content ?? [];
        const downloaded: string[] = [];
        for (const line of content) {
          for (const node of line as any[]) {
            if (node.tag === 'img' && node.image_key) {
              const d = await downloadAttachment(client, messageId, node.image_key, 'image', cfg.inboxDir);
              downloaded.push(d.path);
            }
          }
        }
        if (downloaded.length === 1) imagePath = downloaded[0];
        else if (downloaded.length > 1) imagePaths = downloaded;
      } catch {/* ignore */}
    }
```

Replace the entire block with:
```ts
    // 同步下载本消息的图片到 inbox
    let imagePath: string | undefined;
    let imagePaths: string[] | undefined;
    {
      const ownImageKeys = extractImageKeys(messageType, rawContent);
      const downloaded: string[] = [];
      for (const key of ownImageKeys) {
        try {
          const d = await downloadAttachment(client, messageId, key, 'image', cfg.inboxDir);
          downloaded.push(d.path);
        } catch (err: any) {
          inboundLog.warn(`own image download failed key=${key} err=${err?.message ?? err}`);
        }
      }
      if (downloaded.length === 1) imagePath = downloaded[0];
      else if (downloaded.length > 1) imagePaths = downloaded;
    }
```

- [ ] **Step 3: Download root images and adjust background push**

Find the block:
```ts
    if (!session.rootInjected) {
      inboundLog.info(`first message for scope=${scopeKey}; fetching background...`);
      let background: string | null = null;
      if (cfg.scopeMode === 'thread' && threadId) {
        background = await resolveThreadBackground(
          { chatId, threadId, messageId },
          cfg.scopeMode,
          (tid) => fetchThreadRoot(client, tid),
        );
      } else {
        background = await resolveChatHistoryBackground(
          chatId,
          (cid, limit) => fetchChatHistory(client, cid, limit),
          { limit: CHAT_HISTORY_LIMIT, selfOpenId: botOpenId },
        );
      }
      session.rootInjected = true;
      store.save(session);
      if (background) {
        inboundLog.info(`pushing background len=${background.length} scope=${scopeKey}`);
        bridge.push(scopeKey, background, { kind: 'background', scope_key: scopeKey });
      } else {
        inboundLog.info(`no background available scope=${scopeKey}`);
      }
    }
```

Replace with:
```ts
    if (!session.rootInjected) {
      inboundLog.info(`first message for scope=${scopeKey}; fetching background...`);
      let threadBg: Awaited<ReturnType<typeof resolveThreadBackground>> = null;
      let chatBgText: string | null = null;
      let rootMessageId: string | null = null;

      if (cfg.scopeMode === 'thread' && threadId) {
        // 记下 root 的 messageId 供后续下载图片使用
        threadBg = await resolveThreadBackground(
          { chatId, threadId, messageId },
          cfg.scopeMode,
          async (tid) => {
            const root = await fetchThreadRoot(client, tid);
            if (root) rootMessageId = root.messageId;
            return root;
          },
        );
      } else {
        chatBgText = await resolveChatHistoryBackground(
          chatId,
          (cid, limit) => fetchChatHistory(client, cid, limit),
          { limit: CHAT_HISTORY_LIMIT, selfOpenId: botOpenId },
        );
      }
      session.rootInjected = true;
      store.save(session);

      if (threadBg) {
        // 并发下载 root 里附带的图片
        const rootImagePaths: string[] = [];
        if (rootMessageId && threadBg.imageKeys.length > 0) {
          for (const key of threadBg.imageKeys) {
            try {
              const d = await downloadAttachment(client, rootMessageId, key, 'image', cfg.inboxDir);
              rootImagePaths.push(d.path);
            } catch (err: any) {
              inboundLog.warn(`root image download failed key=${key} err=${err?.message ?? err}`);
            }
          }
        }
        const bgMeta: Record<string, unknown> = {
          kind: 'background',
          scope_key: scopeKey,
        };
        if (rootImagePaths.length === 1) bgMeta.image_path = rootImagePaths[0];
        else if (rootImagePaths.length > 1) bgMeta.image_paths = rootImagePaths.join(',');
        inboundLog.info(`pushing thread background len=${threadBg.text.length} rootImages=${rootImagePaths.length} scope=${scopeKey}`);
        bridge.push(scopeKey, threadBg.text, bgMeta);
      } else if (chatBgText) {
        inboundLog.info(`pushing chat history background len=${chatBgText.length} scope=${scopeKey}`);
        bridge.push(scopeKey, chatBgText, { kind: 'background', scope_key: scopeKey });
      } else {
        inboundLog.info(`no background available scope=${scopeKey}`);
      }
    }
```

- [ ] **Step 4: Typecheck**

```bash
cd /Users/bytedance/haha/x/agent/claude-about/claude-lark-channel
npm run typecheck 2>&1 | tail -5
```
Expected: exit 0.

- [ ] **Step 5: Run all tests**

```bash
npm test 2>&1 | tail -6
```
Expected: all tests still pass (no test targets the `handleInbound` function directly; unit tests for parser + bootstrap cover the logic we changed).

- [ ] **Step 6: Commit**

```bash
cd /Users/bytedance/haha/x/agent/claude-about/claude-lark-channel
git add src/master/index.ts
git -c user.email=loujiahao@bytedance.com -c user.name=loujiahao commit -m "feat(master): download thread root images; use extractImageKeys for own msg

Root images previously dropped — only root text was surfaced in the
background channel_push frame. Now master downloads them synchronously
to inbox and attaches image_path(s) to the background meta so Claude
can Read them alongside the text context.

Also refactor own-message image extraction to share the new
extractImageKeys helper (DRY)."
```

---

## Phase 5 — `handleInbound` parent path

### Task 5.1: Fetch parent message on `parent_id`; attach parent_content + parent image paths to current meta

**Files:**
- Modify: `/Users/bytedance/haha/x/agent/claude-about/claude-lark-channel/src/master/index.ts`

- [ ] **Step 1: Import `fetchMessage`**

Find the import from `./feishu-client.js` (around line 13):
```ts
import {
  createFeishuClient,
  createFeishuWSClient,
  fetchBotOpenId,
  fetchThreadRoot,
  fetchChatHistory,
} from './feishu-client.js';
```

Change to:
```ts
import {
  createFeishuClient,
  createFeishuWSClient,
  fetchBotOpenId,
  fetchThreadRoot,
  fetchChatHistory,
  fetchMessage,
} from './feishu-client.js';
```

- [ ] **Step 2: Destructure `parent_id` from inbound event**

Find this block in `handleInbound`:
```ts
    const threadId: string | undefined = message.root_id || undefined;
    const mentions: any[] = message.mentions ?? [];
    const senderId: string = sender?.sender_id?.open_id ?? '';
```

Add one line directly after `threadId`:
```ts
    const threadId: string | undefined = message.root_id || undefined;
    const parentId: string | undefined = message.parent_id || undefined;
    const mentions: any[] = message.mentions ?? [];
    const senderId: string = sender?.sender_id?.open_id ?? '';
```

- [ ] **Step 3: Fetch parent and prepare parent fields before meta assembly**

Find the block that starts with `// 构建 meta 并推送` (before the final `bridge.push` of the main frame):
```ts
    // 构建 meta 并推送
    const meta: Record<string, unknown> = {
      chat_id: chatId,
      message_id: messageId,
      user_id: senderId,
      chat_type: chatType,
      scope_key: scopeKey,
      ts: new Date().toISOString(),
    };
    if (threadId) meta.thread_id = threadId;
    if (imagePath) meta.image_path = imagePath;
    if (imagePaths?.length) meta.image_paths = imagePaths.join(',');
    if (attachments.length === 1 && attachments[0].fileType !== 'image') {
      meta.attachment_kind = attachments[0].fileType;
      meta.attachment_file_id = attachments[0].fileKey;
      meta.attachment_name = attachments[0].fileName;
    }

    session.lastUserInput = text;
    store.save(session);

    const pushed = bridge.push(scopeKey, text, meta);
    inboundLog.info(`push result=${pushed ? 'OK' : 'FAILED'} scope=${scopeKey} textLen=${text.length} imagePath=${imagePath ?? '-'} imagePaths=${imagePaths?.length ?? 0} attachments=${attachments.length}`);
  }
```

Replace with (adds a parent-fetch + image-download block between `store.save(session)` and the existing `const pushed = ...`, and extends meta):

```ts
    // 若事件带 parent_id（引用回复），拉 parent 消息的文本 + 图片，
    // 作为 meta 里的 parent_* 字段传给 Claude
    let parentContent: string | null = null;
    let parentImagePath: string | undefined;
    let parentImagePaths: string[] | undefined;
    let parentMessageIdResolved: string | undefined;
    if (parentId) {
      inboundLog.info(`fetching parent messageId=${parentId}`);
      const parent = await fetchMessage(client, parentId);
      if (parent) {
        parentMessageIdResolved = parent.messageId;
        parentContent = parent.text;
        if (parent.imageKeys.length > 0) {
          const downloaded: string[] = [];
          for (const key of parent.imageKeys) {
            try {
              const d = await downloadAttachment(client, parent.messageId, key, 'image', cfg.inboxDir);
              downloaded.push(d.path);
            } catch (err: any) {
              inboundLog.warn(`parent image download failed key=${key} err=${err?.message ?? err}`);
            }
          }
          if (downloaded.length === 1) parentImagePath = downloaded[0];
          else if (downloaded.length > 1) parentImagePaths = downloaded;
        }
        inboundLog.info(`parent resolved textLen=${parentContent.length} imageCount=${parent.imageKeys.length} downloaded=${(parentImagePaths?.length ?? (parentImagePath ? 1 : 0))}`);
      } else {
        inboundLog.warn(`fetchMessage returned null for parent messageId=${parentId}`);
      }
    }

    // 构建 meta 并推送
    const meta: Record<string, unknown> = {
      chat_id: chatId,
      message_id: messageId,
      user_id: senderId,
      chat_type: chatType,
      scope_key: scopeKey,
      ts: new Date().toISOString(),
    };
    if (threadId) meta.thread_id = threadId;
    if (imagePath) meta.image_path = imagePath;
    if (imagePaths?.length) meta.image_paths = imagePaths.join(',');
    if (attachments.length === 1 && attachments[0].fileType !== 'image') {
      meta.attachment_kind = attachments[0].fileType;
      meta.attachment_file_id = attachments[0].fileKey;
      meta.attachment_name = attachments[0].fileName;
    }
    if (parentMessageIdResolved) {
      meta.parent_message_id = parentMessageIdResolved;
      meta.parent_content = parentContent ?? '';
      if (parentImagePath) meta.parent_image_path = parentImagePath;
      if (parentImagePaths?.length) meta.parent_image_paths = parentImagePaths.join(',');
    }

    session.lastUserInput = text;
    store.save(session);

    const pushed = bridge.push(scopeKey, text, meta);
    inboundLog.info(`push result=${pushed ? 'OK' : 'FAILED'} scope=${scopeKey} textLen=${text.length} imagePath=${imagePath ?? '-'} imagePaths=${imagePaths?.length ?? 0} parentImages=${(parentImagePaths?.length ?? (parentImagePath ? 1 : 0))} attachments=${attachments.length}`);
  }
```

Note: the parent-fetch block sits **after** `session.rootInjected` handling but **before** meta assembly, so a single event that is both "first in scope" AND "quote-reply" will do root fetch → parent fetch → push background frame → push main frame with parent_* meta. Order matches spec §5 data flow.

- [ ] **Step 4: Typecheck**

```bash
cd /Users/bytedance/haha/x/agent/claude-about/claude-lark-channel
npm run typecheck 2>&1 | tail -5
```
Expected: exit 0.

- [ ] **Step 5: Run all tests**

```bash
npm test 2>&1 | tail -6
```
Expected: all tests pass (no direct handleInbound tests).

- [ ] **Step 6: Commit**

```bash
cd /Users/bytedance/haha/x/agent/claude-about/claude-lark-channel
git add src/master/index.ts
git -c user.email=loujiahao@bytedance.com -c user.name=loujiahao commit -m "feat(master): fetch parent message content + images on quote-reply

When the inbound event carries parent_id (user quote-replied a prior
message), pull the parent via im.v1.message.get, extract its text
and image_keys, download those images to inbox, and attach 4 optional
meta fields to the main channel_push frame:

  parent_message_id   string — the parent's id (presence = 'there is a parent')
  parent_content      string — parent's plain text (empty string if none)
  parent_image_path   string — single parent image (if exactly 1)
  parent_image_paths  string — comma-joined paths (if 2+)

Failures (fetch error, image download error) are logged as warn and
don't affect the main frame. Mirrors claude-lark-plugin's parentContent
model, extended with image support."
```

---

## Phase 6 — Docs & Manual Smoke

### Task 6.1: Update smoke-test.md

**Files:**
- Modify: `/Users/bytedance/haha/x/agent/claude-about/claude-lark-channel/scripts/smoke-test.md`

- [ ] **Step 1: Append new checklist items**

Open `scripts/smoke-test.md`. Locate the existing checklist section and append to it (keep existing items intact):

```markdown
## Thread / parent context images (spec 2026-04-22)

- [ ] **Thread root image**: in a group chat (whitelisted), create a new thread by posting an image + text caption as the thread root. In the same thread, reply `@bot 分析下这张图` (no quote-reply). Expect: Claude's reply references the image's content (proving it read `image_path` from the background frame).
- [ ] **Quote-reply with image**: in any chat, find a prior message containing an image, quote-reply it and include `@bot 看一下这张图`. Expect: Claude's reply references the parent image.
- [ ] **Quote-reply with text only**: quote-reply a text-only prior message and `@bot`. Expect: Claude reply references the parent's text (via `parent_content`).
- [ ] **Regression — thread without images**: start a new thread with text-only root, `@bot` there. Expect: unchanged behaviour (background frame with text, no `image_path` meta).
- [ ] **Regression — plain P2P, no parent**: DM the bot plain text. Expect: unchanged behaviour (no parent_* meta).
```

- [ ] **Step 2: Commit**

```bash
cd /Users/bytedance/haha/x/agent/claude-about/claude-lark-channel
git add scripts/smoke-test.md
git -c user.email=loujiahao@bytedance.com -c user.name=loujiahao commit -m "docs(smoke): add thread/parent image scenarios"
```

### Task 6.2: Propagate to plugin cache + marketplace clone

**Files:**
- Copy to: `~/.claude/plugins/cache/claude-lark-channel/lark-channel/0.1.2/src/`
- Copy to: `~/.claude/plugins/marketplaces/claude-lark-channel/src/`

This is necessary because the user's master runs from the plugin cache, not the workspace repo.

- [ ] **Step 1: Copy changed source files**

```bash
cd /Users/bytedance/haha/x/agent/claude-about/claude-lark-channel
for dst in ~/.claude/plugins/cache/claude-lark-channel/lark-channel/0.1.2 \
           ~/.claude/plugins/marketplaces/claude-lark-channel; do
  cp src/master/message-parser.ts "$dst/src/master/message-parser.ts"
  cp src/master/feishu-client.ts  "$dst/src/master/feishu-client.ts"
  cp src/master/bootstrap.ts      "$dst/src/master/bootstrap.ts"
  cp src/master/index.ts          "$dst/src/master/index.ts"
  cp scripts/smoke-test.md        "$dst/scripts/smoke-test.md"
done
```

- [ ] **Step 2: Verify hashes match**

```bash
for f in src/master/message-parser.ts src/master/feishu-client.ts src/master/bootstrap.ts src/master/index.ts; do
  LOCAL=$(md5 -q "/Users/bytedance/haha/x/agent/claude-about/claude-lark-channel/$f")
  CACHE=$(md5 -q "$HOME/.claude/plugins/cache/claude-lark-channel/lark-channel/0.1.2/$f")
  if [ "$LOCAL" = "$CACHE" ]; then
    echo "OK  $f"
  else
    echo "MISMATCH  $f"
  fi
done
```
Expected: 4 lines of `OK`.

- [ ] **Step 3: No commit** — this is a deployment step, not a code change.

### Task 6.3: Final verification pass

- [ ] **Step 1: Run full test suite + typecheck + build**

```bash
cd /Users/bytedance/haha/x/agent/claude-about/claude-lark-channel
npm run typecheck && npm test && npm run build
```
Expected: all green. Test count should be 50 (prior) + 7 new (`extractImageKeys`) + 1 new (`resolveThreadBackground` imageKeys passthrough) = **58 tests**.

- [ ] **Step 2: Review commit series**

```bash
git log --oneline | head -10
```
Expected last 6 commits (in order, newest first):
```
<sha>  docs(smoke): add thread/parent image scenarios
<sha>  feat(master): fetch parent message content + images on quote-reply
<sha>  feat(master): download thread root images; use extractImageKeys for own msg
<sha>  feat(bootstrap): resolveThreadBackground returns {text, imageKeys}
<sha>  feat(feishu-client): surface imageKeys on ThreadRoot; add fetchMessage
<sha>  feat(parser): add extractImageKeys for image/post types
```

- [ ] **Step 3: User guidance to test live**

Tell the user:
```
Implementation done — 6 commits on main + cache propagated.
Next: /reload-plugins (to restart master with new code), then run through
scripts/smoke-test.md §"Thread / parent context images".
```

---

## Self-Review Notes

**Spec coverage:**

| Spec section | Implemented in |
|---|---|
| §1.3 goal "thread root images" | Task 4.1 step 3 |
| §1.3 goal "parent text + images" | Task 5.1 steps 2–3 |
| §2 parity with claude-lark-plugin + parent image addition | Task 5.1 step 3 |
| §3.1 `extractImageKeys` helper | Task 1.2 |
| §3.1 `ThreadRoot.imageKeys` | Task 2.1 step 2 |
| §3.1 `fetchMessage` | Task 2.1 step 3 |
| §3.1 `resolveThreadBackground` shape change | Task 3.1 step 3 |
| §3.1 handleInbound refactor | Task 4.1 step 2 |
| §3.1 handleInbound parent handling | Task 5.1 steps 2–3 |
| §4.1 background meta image_path(s) | Task 4.1 step 3 |
| §4.2 parent_* meta | Task 5.1 step 3 |
| §6 failure matrix (parent fetch fails) | Task 5.1 step 3 (else branch logs warn; no parent_* in meta) |
| §6 failure matrix (image download fails) | Task 4.1 step 3 + Task 5.1 step 3 (per-key try/catch) |
| §6 failure matrix (parent_id == thread root, duplicate download) | Accepted — both paths run independently per spec |
| §7.1 extractImageKeys tests (6) | Task 1.1 (7 cases actually — image/post single/post multi/en_us locale/text/file/malformed; the 6 in spec is a floor) |
| §7.1 bootstrap shape migration + imageKeys passthrough | Task 3.1 step 1 |
| §7.2 smoke checklist additions | Task 6.1 |

**Placeholder scan:** none — every code step shows the full block to replace and full replacement content.

**Type consistency check:**
- `ThreadRoot`: defined in Task 2.1 step 2 with `{ messageId, text, imageKeys, createTime }`. Used in Task 3.1 step 3 (`root.imageKeys ?? []`). Consistent.
- `ThreadBackground`: defined in Task 3.1 step 3 with `{ text, imageKeys }`. Used in Task 4.1 step 3 (`threadBg.text`, `threadBg.imageKeys`). Consistent.
- `FetchedMessage`: defined in Task 2.1 step 3 with `{ messageId, text, imageKeys, createTime }`. Used in Task 5.1 step 3 (`parent.messageId`, `parent.text`, `parent.imageKeys`). Consistent.
- `extractImageKeys`: signature `(messageType: string, rawContent: string) => string[]` in Task 1.2. Used in Task 2.1 step 2 (`extractImageKeys(msgType, raw)`), Task 4.1 step 2 (`extractImageKeys(messageType, rawContent)`), Task 5.1 step 3 (inside `fetchMessage`). Consistent.
- Meta field names `parent_message_id` / `parent_content` / `parent_image_path` / `parent_image_paths`: appear only in Task 5.1 step 3 + spec §4.2. Consistent snake_case.

No gaps, no contradictions, no placeholders.
