import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../../src/shared/config.js';

describe('loadConfig — appendSystemPromptFile', () => {
  let tmpDir: string;
  let cfgPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-cfg-'));
    cfgPath = path.join(tmpDir, 'config.json');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns undefined when no config file exists', () => {
    const cfg = loadConfig(cfgPath);
    expect(cfg.appendSystemPromptFile).toBeUndefined();
  });

  it('returns undefined when field is omitted', () => {
    fs.writeFileSync(cfgPath, JSON.stringify({ debug: false }));
    const cfg = loadConfig(cfgPath);
    expect(cfg.appendSystemPromptFile).toBeUndefined();
  });

  it('returns the configured path when set', () => {
    fs.writeFileSync(cfgPath, JSON.stringify({
      appendSystemPromptFile: '/abs/path/persona.md',
    }));
    const cfg = loadConfig(cfgPath);
    expect(cfg.appendSystemPromptFile).toBe('/abs/path/persona.md');
  });

  it('returns undefined when set to empty string', () => {
    fs.writeFileSync(cfgPath, JSON.stringify({
      appendSystemPromptFile: '',
    }));
    const cfg = loadConfig(cfgPath);
    expect(cfg.appendSystemPromptFile).toBeUndefined();
  });
});
