#!/usr/bin/env node
// 一次性把所有"当前版本"硬编码位置从 package.json 的旧版本号升到新版本号。
// 用法：npm run bump                 自动 patch+1（0.1.2 → 0.1.3）
//      npm run bump <new-version>   显式指定新版本号
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkgPath = join(root, 'package.json');
const oldVersion = JSON.parse(readFileSync(pkgPath, 'utf8')).version;

const arg = process.argv[2];
let newVersion;
if (!arg) {
  // 默认 patch 递增，忽略预发布后缀
  const m = oldVersion.match(/^(\d+)\.(\d+)\.(\d+)(?:-.*)?$/);
  if (!m) {
    console.error(`Cannot auto-bump: unrecognized current version "${oldVersion}"`);
    process.exit(1);
  }
  newVersion = `${m[1]}.${m[2]}.${Number(m[3]) + 1}`;
} else {
  if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(arg)) {
    console.error(`Invalid semver: ${arg}`);
    process.exit(1);
  }
  newVersion = arg;
}
if (oldVersion === newVersion) {
  console.error(`Already at ${newVersion}; nothing to do.`);
  process.exit(1);
}

console.log(`[bump] ${oldVersion} → ${newVersion}`);

// 文本级精确替换，保留原文件格式与缩进；pattern 命中不到就报错退出。
const patches = [
  { path: '.claude-plugin/plugin.json',         from: `"version": "${oldVersion}"`,                  to: `"version": "${newVersion}"` },
  { path: '.claude-plugin/marketplace.json',    from: `"version": "${oldVersion}"`,                  to: `"version": "${newVersion}"` },
  { path: 'src/shared/protocol.ts',             from: `PROTOCOL_VERSION = '${oldVersion}'`,          to: `PROTOCOL_VERSION = '${newVersion}'` },
  { path: 'src/child/index.ts',                 from: `name: 'claude-lark-channel', version: '${oldVersion}'`, to: `name: 'claude-lark-channel', version: '${newVersion}'` },
  { path: 'tests/shared/protocol.test.ts',      from: `version: '${oldVersion}'`,                    to: `version: '${newVersion}'` },
  { path: 'CLAUDE.md',                          from: `lark-channel/${oldVersion}\``,                to: `lark-channel/${newVersion}\`` },
];

for (const p of patches) {
  const full = join(root, p.path);
  const txt = readFileSync(full, 'utf8');
  if (!txt.includes(p.from)) {
    console.error(`[bump] ERROR: pattern not found in ${p.path}\n  expected: ${p.from}`);
    process.exit(1);
  }
  // 只替换首个出现：以上 pattern 均唯一，多次出现要警觉
  const idx = txt.indexOf(p.from);
  if (txt.indexOf(p.from, idx + p.from.length) !== -1) {
    console.error(`[bump] ERROR: pattern appears more than once in ${p.path}; refusing to guess which one.`);
    process.exit(1);
  }
  writeFileSync(full, txt.slice(0, idx) + p.to + txt.slice(idx + p.from.length));
  console.log(`  ✓ ${p.path}`);
}

// package.json + package-lock.json 由 npm 自己改，保证 lockfile 一致
console.log('[bump] running: npm version --no-git-tag-version --allow-same-version');
execSync(`npm version ${newVersion} --no-git-tag-version --allow-same-version`, { cwd: root, stdio: 'inherit' });
console.log('  ✓ package.json');
console.log('  ✓ package-lock.json');

console.log(`\n[bump] done. now at v${newVersion}.`);
console.log('next steps:');
console.log('  npm run typecheck && npm test');
console.log(`  git add -A && git commit -m "chore: bump version to ${newVersion}"`);
