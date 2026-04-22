import { describe, it, expect } from 'vitest';
import { Dedup } from '../../src/master/dedup.js';

describe('Dedup', () => {
  it('first occurrence returns false (not duplicate)', () => {
    const d = new Dedup(1000);
    expect(d.seen('m1')).toBe(false);
  });

  it('second occurrence within window returns true', () => {
    const d = new Dedup(1000);
    d.seen('m1');
    expect(d.seen('m1')).toBe(true);
  });

  it('after window expiry, reappearance returns false', () => {
    let now = 1000;
    const d = new Dedup(100, () => now);
    d.seen('m1');
    now += 200;
    expect(d.seen('m1')).toBe(false);
  });

  it('sweep drops expired entries', () => {
    let now = 1000;
    const d = new Dedup(100, () => now);
    d.seen('a');
    d.seen('b');
    expect(d.size()).toBe(2);
    now += 200;
    d.sweep();
    expect(d.size()).toBe(0);
  });
});
