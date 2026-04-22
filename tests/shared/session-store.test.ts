import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  SessionStore,
  type Session,
} from '../../src/shared/session-store.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sess-'));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('SessionStore', () => {
  it('creates a new session when none exists', () => {
    const store = new SessionStore(tmpDir);
    const s = store.getOrCreate('chat:oc_a', '/work');
    expect(s.scopeKey).toBe('chat:oc_a');
    expect(s.workDir).toBe('/work');
    expect(s.claudeSessionId).toBe('');
    expect(s.rootInjected).toBe(false);
    expect(s.id).toMatch(/^[0-9a-f-]+$/);
  });

  it('reuses existing session on second lookup', () => {
    const store = new SessionStore(tmpDir);
    const a = store.getOrCreate('chat:oc_a', '/work');
    const b = store.getOrCreate('chat:oc_a', '/work');
    expect(b.id).toBe(a.id);
  });

  it('persists by-id JSON and by-scope symlink', () => {
    const store = new SessionStore(tmpDir);
    const s = store.getOrCreate('thread:oc_a:t_1', '/work');
    const byId = path.join(tmpDir, 'by-id', `${s.id}.json`);
    expect(fs.existsSync(byId)).toBe(true);
    const byScope = path.join(tmpDir, 'by-scope', 'thread_oc_a_t_1.json');
    expect(fs.lstatSync(byScope).isSymbolicLink()).toBe(true);
  });

  it('saves updates round-trip', () => {
    const store = new SessionStore(tmpDir);
    const s = store.getOrCreate('chat:oc_a', '/work');
    s.claudeSessionId = 'xyz';
    s.rootInjected = true;
    store.save(s);

    const store2 = new SessionStore(tmpDir);
    const loaded = store2.getByScopeKey('chat:oc_a');
    expect(loaded?.claudeSessionId).toBe('xyz');
    expect(loaded?.rootInjected).toBe(true);
  });

  it('survives external by-id rewrites (simulates hook overwrite)', () => {
    const store = new SessionStore(tmpDir);
    const s = store.getOrCreate('chat:oc_a', '/work');
    const byId = path.join(tmpDir, 'by-id', `${s.id}.json`);
    const data = JSON.parse(fs.readFileSync(byId, 'utf-8'));
    data.claudeSessionId = 'hook-written';
    fs.writeFileSync(byId, JSON.stringify(data));
    // Re-read via by-scope symlink
    const fresh = store.getByScopeKey('chat:oc_a');
    expect(fresh?.claudeSessionId).toBe('hook-written');
  });

  it('returns null for unknown scope', () => {
    const store = new SessionStore(tmpDir);
    expect(store.getByScopeKey('chat:nope')).toBeNull();
  });
});
