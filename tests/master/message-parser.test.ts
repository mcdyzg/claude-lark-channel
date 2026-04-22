import { describe, it, expect } from 'vitest';
import { extractPlainText, extractAttachments } from '../../src/master/message-parser.js';

describe('extractPlainText', () => {
  it('text type — returns parsed text', () => {
    const raw = JSON.stringify({ text: 'hello' });
    expect(extractPlainText('text', raw)).toBe('hello');
  });

  it('text type — malformed JSON falls back to raw', () => {
    expect(extractPlainText('text', 'not-json')).toBe('not-json');
  });

  it('post type — concatenates text nodes per line', () => {
    const raw = JSON.stringify({
      zh_cn: { content: [[{ tag: 'text', text: 'line1' }], [{ tag: 'text', text: 'line2' }]] },
    });
    expect(extractPlainText('post', raw)).toBe('line1\nline2');
  });

  it('image type — returns [Image] placeholder', () => {
    expect(extractPlainText('image', JSON.stringify({ image_key: 'img_x' }))).toBe('[Image]');
  });

  it('file type — returns [File: name]', () => {
    expect(extractPlainText('file', JSON.stringify({ file_key: 'f', file_name: 'doc.pdf' }))).toBe('[File: doc.pdf]');
  });

  it('audio / video — returns tagged placeholder', () => {
    expect(extractPlainText('audio', '{}')).toBe('[Audio]');
    expect(extractPlainText('video', '{}')).toBe('[Video]');
  });

  it('interactive — returns card title if present', () => {
    const raw = JSON.stringify({ header: { title: { content: 'Card Title' } } });
    expect(extractPlainText('interactive', raw)).toBe('Card Title');
  });
});

describe('extractAttachments', () => {
  it('image — returns image attachment', () => {
    const attachments = extractAttachments({
      message_type: 'image',
      content: JSON.stringify({ image_key: 'img_1' }),
    });
    expect(attachments).toEqual([{ fileKey: 'img_1', fileName: 'image.png', fileType: 'image' }]);
  });

  it('file — uses file_name', () => {
    const attachments = extractAttachments({
      message_type: 'file',
      content: JSON.stringify({ file_key: 'f_1', file_name: 'report.pdf' }),
    });
    expect(attachments).toEqual([{ fileKey: 'f_1', fileName: 'report.pdf', fileType: 'file' }]);
  });

  it('audio / video — returns single attachment', () => {
    expect(extractAttachments({ message_type: 'video', content: JSON.stringify({ file_key: 'v_1' }) }))
      .toEqual([{ fileKey: 'v_1', fileName: 'video', fileType: 'video' }]);
  });

  it('text — no attachments', () => {
    expect(extractAttachments({ message_type: 'text', content: JSON.stringify({ text: 'hi' }) })).toEqual([]);
  });
});

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
