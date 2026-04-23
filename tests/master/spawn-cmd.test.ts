import { describe, it, expect } from 'vitest';
import { buildClaudeCmd } from '../../src/master/pool.js';

describe('buildClaudeCmd', () => {
  it('base command without resume, without prompt', () => {
    expect(buildClaudeCmd({})).toBe(
      "claude --dangerously-load-development-channels plugin:lark-channel@claude-lark-channel --dangerously-skip-permissions"
    );
  });

  it('includes --resume when resumeSessionId is set', () => {
    expect(buildClaudeCmd({ resumeSessionId: 'abc-123' })).toBe(
      "claude --dangerously-load-development-channels plugin:lark-channel@claude-lark-channel --dangerously-skip-permissions --resume 'abc-123'"
    );
  });
});

describe('buildClaudeCmd — appendSystemPromptFile', () => {
  it('adds --append-system-prompt-file when path is provided', () => {
    const cmd = buildClaudeCmd({ appendSystemPromptFile: '/abs/path/persona.md' });
    expect(cmd).toContain("--append-system-prompt-file '/abs/path/persona.md'");
  });

  it('single-quote-escapes paths with special characters', () => {
    const cmd = buildClaudeCmd({ appendSystemPromptFile: "/tmp/it's here.md" });
    // shellQuote escapes ' as '\'' — so the arg becomes '/tmp/it'\''s here.md'
    expect(cmd).toContain(`--append-system-prompt-file '/tmp/it'\\''s here.md'`);
  });

  it('omits the flag when path is empty string', () => {
    const cmd = buildClaudeCmd({ appendSystemPromptFile: '' });
    expect(cmd).not.toContain('--append-system-prompt');
  });

  it('omits the flag when path is undefined', () => {
    const cmd = buildClaudeCmd({});
    expect(cmd).not.toContain('--append-system-prompt');
  });

  it('combines with --resume (append before resume)', () => {
    const cmd = buildClaudeCmd({
      resumeSessionId: 'sid-1',
      appendSystemPromptFile: '/abs/persona.md',
    });
    expect(cmd).toContain("--append-system-prompt-file '/abs/persona.md'");
    expect(cmd).toContain("--resume 'sid-1'");
    // Ordering: append-system-prompt-file should come before --resume for readability
    expect(cmd.indexOf('--append-system-prompt-file')).toBeLessThan(cmd.indexOf('--resume'));
  });
});
