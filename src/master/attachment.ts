import fs from 'node:fs';
import path from 'node:path';
import * as Lark from '@larksuiteoapi/node-sdk';

export interface DownloadedAttachment {
  path: string;
  size: number;
  filename: string;
}

/**
 * Download a Feishu message resource by message_id + file_key.
 * Saves to inboxDir with a timestamped prefix to prevent collisions.
 */
export async function downloadAttachment(
  client: Lark.Client,
  messageId: string,
  fileKey: string,
  kind: 'image' | 'file' | 'audio' | 'video',
  inboxDir: string,
): Promise<DownloadedAttachment> {
  fs.mkdirSync(inboxDir, { recursive: true });

  const ext = extFor(kind);
  const safeKey = fileKey.replace(/[^a-zA-Z0-9_-]/g, '_');
  const filename = `${Date.now()}-${safeKey}${ext}`;
  const filePath = path.join(inboxDir, filename);

  const resp: any = await (client.im.v1.messageResource.get as any)({
    path: { message_id: messageId, file_key: fileKey },
    params: { type: kind },
  });

  if (!resp) {
    throw new Error('messageResource.get returned empty');
  }

  if (Buffer.isBuffer(resp)) {
    fs.writeFileSync(filePath, resp);
  } else if (typeof resp?.writeFile === 'function') {
    await resp.writeFile(filePath);
  } else if (typeof resp?.pipe === 'function') {
    const chunks: Buffer[] = [];
    for await (const chunk of resp) chunks.push(Buffer.from(chunk));
    fs.writeFileSync(filePath, Buffer.concat(chunks));
  } else {
    throw new Error(`Unexpected resource response type for ${fileKey}`);
  }

  const size = fs.statSync(filePath).size;
  return { path: filePath, size, filename };
}

function extFor(kind: string): string {
  switch (kind) {
    case 'image': return '.png';
    case 'video': return '.mp4';
    case 'audio': return '.ogg';
    default: return '';
  }
}
