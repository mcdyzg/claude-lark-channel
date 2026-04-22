import type { LarkAttachment } from '../types.js';

export function extractPlainText(messageType: string, rawContent: string): string {
  try {
    const parsed = JSON.parse(rawContent);
    switch (messageType) {
      case 'text':
        return parsed.text ?? rawContent;
      case 'post': {
        const content = parsed.content ?? parsed.zh_cn?.content ?? parsed.en_us?.content ?? [];
        const lines: string[] = [];
        for (const line of content) {
          const texts = (line as any[])
            .filter((n: any) => n.tag === 'text' || n.tag === 'md' || n.tag === 'a')
            .map((n: any) => n.text ?? n.href ?? '');
          lines.push(texts.join(''));
        }
        return lines.join('\n');
      }
      case 'image':
        return '[Image]';
      case 'file':
        return `[File: ${parsed.file_name ?? 'attachment'}]`;
      case 'audio':
        return '[Audio]';
      case 'video':
        return '[Video]';
      case 'interactive':
        return parsed.title?.content ?? parsed.header?.title?.content ?? '[Interactive Card]';
      default:
        return parsed.text ?? rawContent;
    }
  } catch {
    return rawContent;
  }
}

interface RawMsgForAttachments {
  message_type?: string;
  msg_type?: string;
  content?: string;
}

export function extractAttachments(message: RawMsgForAttachments): LarkAttachment[] {
  const result: LarkAttachment[] = [];
  let parsed: any;
  try {
    parsed = JSON.parse(message.content ?? '{}');
  } catch {
    return result;
  }
  const msgType = message.message_type ?? message.msg_type ?? '';
  if (msgType === 'image' && parsed.image_key) {
    result.push({ fileKey: parsed.image_key, fileName: 'image.png', fileType: 'image' });
  } else if (msgType === 'file' && parsed.file_key) {
    result.push({ fileKey: parsed.file_key, fileName: parsed.file_name ?? 'file', fileType: 'file' });
  } else if (msgType === 'audio' && parsed.file_key) {
    result.push({ fileKey: parsed.file_key, fileName: 'audio', fileType: 'audio' });
  } else if (msgType === 'video' && parsed.file_key) {
    result.push({ fileKey: parsed.file_key, fileName: 'video', fileType: 'video' });
  }
  return result;
}

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
