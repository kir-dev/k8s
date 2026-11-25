import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");

const args = process.argv.slice(2);
const stdout = args.includes("--stdout");
const all = args.includes("--all");
const positional = args.filter((arg) => !arg.startsWith("--"));

if (all && stdout) {
    console.error("✗ --all and --stdout cannot be combined");
    process.exit(1);
}

if (!all && positional.length !== 1) {
    console.error("usage: bun run cdk8s:synth [--stdout] APP_NAME | --all");
    process.exit(1);
}

function discoverCdk8sApps(): string[] {
    return readdirSync(ROOT, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules")
        .map((entry) => entry.name)
        .filter((name) => existsSync(join(ROOT, name, "app.ts")))
        .sort();
}

async function synthApp(appName: string): Promise<void> {
    const appPath = resolve(ROOT, appName, "app.ts");
    if (!existsSync(appPath)) {
        console.error(`✗ ${appPath} does not exist`);
        process.exit(1);
    }

    const outDir = join("dist", appName);
    if (!stdout) {
        process.env.CDK8S_OUTDIR = outDir;
    }

    const module = (await import(appPath)) as { default?: { synth(): void; synthYaml(): string } };
    if (!module.default || typeof module.default.synth !== "function") {
        console.error(`✗ ${appPath} must default-export a cdk8s App`);
        process.exit(1);
    }

    if (stdout) {
        process.stdout.write(module.default.synthYaml());
    } else {
        module.default.synth();
        console.error(`✓ synthesized ${appName} -> ${outDir}`);
    }
}

const targets = all ? discoverCdk8sApps() : [positional[0]];
for (const appName of targets) {
    await synthApp(appName);
}
