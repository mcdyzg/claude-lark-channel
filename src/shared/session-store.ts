import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { safeScopeKey } from './scope.js';

export interface Session {
  id: string;
  scopeKey: string;
  workDir: string;
  claudeSessionId: string;
  rootInjected: boolean;
  lastUserInput: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * File layout:
 *   <root>/by-id/<uuid>.json       — primary store (hook writes here)
 *   <root>/by-scope/<safe>.json    — symlink → ../by-id/<uuid>.json
 */
export class SessionStore {
  constructor(private readonly root: string) {
    fs.mkdirSync(path.join(root, 'by-id'), { recursive: true });
    fs.mkdirSync(path.join(root, 'by-scope'), { recursive: true });
  }

  private idPath(id: string): string {
    return path.join(this.root, 'by-id', `${id}.json`);
  }

  private scopePath(scopeKey: string): string {
    return path.join(this.root, 'by-scope', `${safeScopeKey(scopeKey)}.json`);
  }

  getOrCreate(scopeKey: string, workDir: string): Session {
    const existing = this.getByScopeKey(scopeKey);
    if (existing) return existing;
    const now = Date.now();
    const s: Session = {
      id: randomUUID(),
      scopeKey,
      workDir,
      claudeSessionId: '',
      rootInjected: false,
      lastUserInput: '',
      createdAt: now,
      updatedAt: now,
    };
    this.save(s);
    // Create symlink by-scope → by-id (relative path for portability)
    const linkPath = this.scopePath(scopeKey);
    const targetRel = path.join('..', 'by-id', `${s.id}.json`);
    try {
      if (fs.existsSync(linkPath) || fs.lstatSync(linkPath, { throwIfNoEntry: false })) {
        fs.unlinkSync(linkPath);
      }
    } catch { /* ignore */ }
    fs.symlinkSync(targetRel, linkPath);
    return s;
  }

  getByScopeKey(scopeKey: string): Session | null {
    const linkPath = this.scopePath(scopeKey);
    if (!fs.existsSync(linkPath)) return null;
    try {
      const raw = fs.readFileSync(linkPath, 'utf-8');
      return normalize(JSON.parse(raw));
    } catch {
      return null;
    }
  }

  getById(id: string): Session | null {
    const p = this.idPath(id);
    if (!fs.existsSync(p)) return null;
    try {
      return normalize(JSON.parse(fs.readFileSync(p, 'utf-8')));
    } catch {
      return null;
    }
  }

  save(s: Session): void {
    s.updatedAt = Date.now();
    const tmp = this.idPath(s.id) + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
    fs.renameSync(tmp, this.idPath(s.id));
  }

  list(): Session[] {
    const dir = path.join(this.root, 'by-id');
    if (!fs.existsSync(dir)) return [];
    const out: Session[] = [];
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const s = normalize(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')));
        if (s) out.push(s);
      } catch {/* ignore corrupt */}
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }
}

function normalize(raw: unknown): Session | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<Session>;
  if (!r.id || !r.scopeKey) return null;
  return {
    id: r.id,
    scopeKey: r.scopeKey,
    workDir: r.workDir ?? '',
    claudeSessionId: r.claudeSessionId ?? '',
    rootInjected: r.rootInjected ?? false,
    lastUserInput: r.lastUserInput ?? '',
    createdAt: r.createdAt ?? Date.now(),
    updatedAt: r.updatedAt ?? Date.now(),
  };
}
