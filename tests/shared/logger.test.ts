import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRootLogger } from '../../src/shared/logger.js';

describe('Logger', () => {
  let tmpDir: string;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let stderrLines: string[];

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-log-'));
    stderrLines = [];
    stderrSpy = vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
      stderrLines.push(String(line));
    });
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('debug=false', () => {
    it('writes error to stderr but not to file', () => {
      const log = createRootLogger('test', tmpDir, false);
      log.error('boom');
      expect(stderrLines.some((l) => l.includes('ERROR') && l.includes('boom'))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, 'debug.log'))).toBe(false);
    });

    it('silences info/warn/debug entirely', () => {
      const log = createRootLogger('test', tmpDir, false);
      log.info('i');
      log.warn('w');
      log.debug('d');
      expect(stderrLines).toHaveLength(0);
      expect(fs.existsSync(path.join(tmpDir, 'debug.log'))).toBe(false);
    });

    it('error survives a child() call', () => {
      const log = createRootLogger('test', tmpDir, false).child('sub');
      log.error('child boom');
      expect(stderrLines.some((l) => l.includes('child boom'))).toBe(true);
    });
  });

  describe('debug=true', () => {
    it('writes all levels to both stderr and file', () => {
      const log = createRootLogger('test', tmpDir, true);
      stderrLines.length = 0; // discard the "logger initialized" line createRootLogger emits
      log.info('i-line');
      log.warn('w-line');
      log.error('e-line');
      log.debug('d-line');
      const content = fs.readFileSync(path.join(tmpDir, 'debug.log'), 'utf-8');
      for (const token of ['i-line', 'w-line', 'e-line', 'd-line']) {
        expect(content).toContain(token);
        expect(stderrLines.some((l) => l.includes(token))).toBe(true);
      }
    });
  });
});
