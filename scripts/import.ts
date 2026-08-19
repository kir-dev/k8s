#!/usr/bin/env bun
/**
 * Fast cdk8s import: download + generate .ts, in parallel.
 *
 * Runs each import from cdk8s.yaml in its own worker process (real multi-core
 * parallelism) and patches cdk8s-cli's buggy download() with `fetch`. An
 * output-level cache makes warm runs (unchanged cdk8s.yaml) O(1).
 *
 * Usage: bun scripts/import.ts [outdir]
 */
import { createHash } from 'node:crypto';
import { readFileSync, existsSync, mkdirSync, rmSync, symlinkSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { parse as parseYaml } from 'yaml';

const CACHE_DIR = process.env.CDK8S_IMPORT_CACHE ?? join(homedir(), '.cache', 'cdk8s-imports');
const CONCURRENCY = Number(process.env.CDK8S_IMPORT_PARALLELISM ?? 16);

const config = parseYaml(readFileSync('cdk8s.yaml', 'utf-8')) as { imports?: string[] };
const imports = config.imports ?? [];
const OUTDIR = process.argv[2] ?? 'imports';

// --- output cache: warm runs just link the previous result ---
const outputKey = createHash('sha256').update(readFileSync('cdk8s.yaml')).digest('hex');
const cachedImports = join(CACHE_DIR, 'out', outputKey, 'imports');
if (existsSync(cachedImports)) {
  rmSync(OUTDIR, { recursive: true, force: true });
  symlinkSync(cachedImports, OUTDIR, 'dir');
  console.error(`cached (${outputKey.slice(0, 8)}): linked -> ${OUTDIR}`);
  process.exit(0);
}

// --- worker pool: one process per import, bounded concurrency ---
const started = Date.now();
const queue = [...imports];
let running = 0;
let failed = 0;

function runWorker(spec: string): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn(
      'bun',
      ['scripts/import-one.ts', spec, OUTDIR],
      { stdio: ['ignore', 'inherit', 'inherit'] },
    );
    child.on('exit', (code) => {
      if (code !== 0) failed++;
      running--;
      resolve();
    });
  });
}

async function pump(): Promise<void> {
  while (queue.length > 0 && running < CONCURRENCY) {
    running++;
    void runWorker(queue.shift()!).then(() => pump());
  }
}

await pump();

// wait for any stragglers
while (running > 0) {
  await new Promise((r) => setTimeout(r, 100));
}

const wall = ((Date.now() - started) / 1000).toFixed(1);
console.error(`${imports.length - failed}/${imports.length} imports OK in ${wall}s`);
if (failed) process.exit(1);

// --- cache the generated output ---
mkdirSync(cachedImports, { recursive: true });
cpSync(OUTDIR, cachedImports, { recursive: true });
console.error(`cached -> ${cachedImports}`);
