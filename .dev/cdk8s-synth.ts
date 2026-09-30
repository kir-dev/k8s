import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

const appName = process.argv[2];
if (!appName) {
    console.error("usage: bun run cdk8s:synth APP_NAME");
    process.exit(1);
}

const outDir = join("dist", appName);
process.env.CDK8S_OUTDIR = outDir;

const appPath = resolve(import.meta.dir, "..", appName, "app.ts");
if (!existsSync(appPath)) {
    console.error(`✗ ${appPath} does not exist`);
    process.exit(1);
}

const module = (await import(appPath)) as { default?: { synth(): void } };
if (!module.default || typeof module.default.synth !== "function") {
    console.error(`✗ ${appPath} must default-export a cdk8s App`);
    process.exit(1);
}

module.default.synth();
console.error(`✓ synthesized ${appName} -> ${outDir}`);
