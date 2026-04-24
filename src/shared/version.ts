import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 读取本插件自身的 package.json version 字段。
 * - src/shared/version.ts 在插件根下；package.json 在 ../../package.json
 * - 读取失败（路径不符合预期 / json 坏）统一返回 'unknown'，永不抛错
 */
export function readPackageVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkgPath = join(here, '..', '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    return typeof pkg.version === 'string' ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
}
