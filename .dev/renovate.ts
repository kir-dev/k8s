/**
 * Run Renovate for a single app from that app's own CI pipeline.
 *
 * Usage (in an app repository's GitHub Actions):
 *
 *   git clone https://github.com/kir-dev/k8s --depth 1
 *   cd k8s
 *   bun install
 *   bun run renovate APP_NAME
 *
 * This renders `<APP_NAME>/renovate.ts` and hands it to Renovate.
 */
import { $ } from "bun";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

// Renovate's native `re2` addon is built against Node's V8 ABI and crashes
// under bun, so we can't use `bunx --bun` to force it to use bun instead of node.

const RENOVATE_VERSION = "44.103.0";

const app = process.argv[2];
if (!app) {
    console.error("usage: bun run renovate APP_NAME");
    process.exit(1);
}

const configFile = resolve(import.meta.dir, "..", app, "renovate.ts");
if (!existsSync(configFile)) {
    console.error(`✗ ${configFile} does not exist`);
    process.exit(1);
}

process.env.RENOVATE_CONFIG_FILE = configFile;
const result = await $`bunx renovate@${RENOVATE_VERSION}`.nothrow();
process.exit(result.exitCode ?? 1);
