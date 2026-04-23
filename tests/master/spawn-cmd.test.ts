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
