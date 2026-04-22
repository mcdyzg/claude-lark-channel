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
