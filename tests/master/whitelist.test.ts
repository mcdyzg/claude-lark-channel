import { describe, it, expect } from 'vitest';
import { passesWhitelist } from '../../src/master/whitelist.js';

describe('passesWhitelist (OR semantics)', () => {
  it('allows all when both lists empty', () => {
    expect(passesWhitelist('u', 'c', [], [])).toBe(true);
  });

  it('only user list: allows by user match', () => {
    expect(passesWhitelist('u1', 'cX', ['u1'], [])).toBe(true);
    expect(passesWhitelist('u2', 'cX', ['u1'], [])).toBe(false);
  });

  it('only chat list: allows by chat match', () => {
    expect(passesWhitelist('uX', 'c1', [], ['c1'])).toBe(true);
    expect(passesWhitelist('uX', 'c2', [], ['c1'])).toBe(false);
  });

  it('both lists: allow when EITHER matches (OR)', () => {
    expect(passesWhitelist('u1', 'cX', ['u1'], ['c1'])).toBe(true);  // user match
    expect(passesWhitelist('uX', 'c1', ['u1'], ['c1'])).toBe(true);  // chat match
    expect(passesWhitelist('u1', 'c1', ['u1'], ['c1'])).toBe(true);  // both match
    expect(passesWhitelist('uX', 'cX', ['u1'], ['c1'])).toBe(false); // neither
  });
});
