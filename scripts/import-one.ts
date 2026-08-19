#!/usr/bin/env bun
/**
 * Worker: import a single spec. Spawned in parallel by scripts/import.ts so
 * that each import's download + codegen runs on its own process (real
 * multi-core parallelism; in-process Promise.all serializes sync codegen).
 *
 * Usage: bun scripts/import-one.ts <spec> <outdir>
 */
import { createRequire } from 'node:module';
import { patchCdk8sDownload } from './lib/fetch-download';

const require = createRequire(import.meta.url);
patchCdk8sDownload(require);

const { matchImporter } = require('../node_modules/cdk8s-cli/lib/import/dispatch');

const spec = process.argv[2];
const outdir = process.argv[3] ?? 'imports';

const importSpec = { source: spec };
const importer = await matchImporter(importSpec, { exclude: [] });
if (!importer) throw new Error(`unable to determine import type for "${spec}"`);

process.stderr.write(`Importing ${spec}...\n`);
await importer.import({
  moduleNamePrefix: importSpec.moduleNamePrefix,
  outdir,
  targetLanguage: 'typescript',
  classNamePrefix: undefined,
});
process.exit(0);
