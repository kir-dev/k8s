/**
 * Shared: patch cdk8s-cli's `download()` to use `fetch` + a content cache.
 *
 * cdk8s-cli's own `download()` (src/util.ts) never drains 301/302 redirect
 * bodies, so a redirecting URL holds a socket open and the process hangs ~30s.
 * `fetch` follows and drains redirects correctly. The cache avoids re-fetching
 * unchanged sources (k8s schema + CRD URLs).
 */
import { createHash } from 'node:crypto';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const CACHE_DIR = process.env.CDK8S_IMPORT_CACHE ?? join(homedir(), '.cache', 'cdk8s-imports');

/**
 * Must be called with the same `require` used to load cdk8s-cli so we mutate
 * the exact module instance its crd.js / k8s.js call into.
 */
export function patchCdk8sDownload(require: NodeRequire): void {
  const util = require('../node_modules/cdk8s-cli/lib/util');
  const original = util.download;
  util.download = async (url: string): Promise<string> => {
    if (!/^https?:/i.test(url)) {
      return original(url); // file: / relative paths -> passthrough
    }
    const key = createHash('sha256').update(url).digest('hex');
    const cacheFile = join(CACHE_DIR, key);
    if (existsSync(cacheFile)) {
      return readFileSync(cacheFile, 'utf-8');
    }
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${url}`);
    const text = await res.text();
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(cacheFile, text);
    return text;
  };
}

export function sourceCacheDir(): string {
  return CACHE_DIR;
}
