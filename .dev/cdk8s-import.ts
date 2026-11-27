/**
 * Default `cdk8s import` is slow and has a bug when receiving and redirect that makes it even slower.
 * This script runs each import in parallel and patches cdk8s's download().
 */
import { $ } from "bun";
import { createHash } from "node:crypto";
import { cpSync, existsSync, linkSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { parse as parseYaml } from "yaml";

/**
 * Recreate `srcDir` at `destDir`, hardlinking files where the filesystem allows
 * it (same inode, so no extra disk writes) and copying otherwise.
 *
 * Hardlinks are transparent to module resolution — unlike symlinks, the file
 * keeps the path it was opened through, so the generated imports resolve
 * `cdk8s`/`constructs` from the project's `node_modules`.
 */
function linkOrCopyTree(srcDir: string, destDir: string): void {
    mkdirSync(destDir, { recursive: true });
    for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
        const src = join(srcDir, entry.name);
        const dest = join(destDir, entry.name);
        if (entry.isDirectory()) {
            linkOrCopyTree(src, dest);
        } else {
            try {
                linkSync(src, dest);
            } catch {
                cpSync(src, dest);
            }
        }
    }
}

const cacheDir = process.env.CDK8S_IMPORT_CACHE ?? join(homedir(), ".cache", "cdk8s-imports");

const cdk8sConfig = parseYaml(readFileSync("cdk8s.yaml", "utf-8")) as { imports: string[] };
const cdk8sImports = cdk8sConfig.imports;
const importsDir = "imports";

// Reuse cached imports dir if cdk8s.yaml hasn't changed
const cdk8sConfigHash = createHash("sha256").update(readFileSync("cdk8s.yaml")).digest("hex");
const cachedImportsDir = join(cacheDir, "out", cdk8sConfigHash, "imports");
if (existsSync(cachedImportsDir)) {
    rmSync(importsDir, { recursive: true, force: true });
    // Hardlink (not symlink) into the project: symlinks make Bun resolve the
    // generated files' `cdk8s`/`constructs` imports against the cache path,
    // where there is no `node_modules`, so it silently auto-installs a wrong
    // cdk8s version. Hardlinks keep the project path, and share inodes so the
    // import cache costs no extra disk writes.
    linkOrCopyTree(cachedImportsDir, importsDir);
    process.exit(0);
}

// cdk8s.yaml changed, create new imports dir
rmSync(importsDir, { recursive: true, force: true });
const started = Date.now();

// cdk8s-cli writes one module per API group, so CRDs spread over several files
// in the same group overwrite each other unless they are imported together.
// Aggregate every raw manifest import into one CRD importer (patched cli) and
// run the rest (k8s + helm) in parallel.
const isCrd = (spec: string) => !spec.startsWith("helm:") && !spec.startsWith("k8s@");
const crdSources = cdk8sImports.filter(isCrd);
const otherImports = cdk8sImports.filter((spec) => !isCrd(spec));

const [otherOutputs, crdOutput] = await Promise.all([
    Promise.all(otherImports.map((spec) => $`bun .dev/cdk8s-import-one.ts ${spec}`.nothrow())),
    crdSources.length > 0 ? $`bun .dev/cdk8s-import-crds.ts ${crdSources}`.nothrow() : Promise.resolve(null),
]);
const shellOutputs = [...otherOutputs, ...(crdOutput ? [crdOutput] : [])];

const failed = shellOutputs.filter((result) => result.exitCode !== 0).length;
const wall = ((Date.now() - started) / 1000).toFixed(1);
console.error(`${shellOutputs.length - failed}/${shellOutputs.length} imports OK in ${wall}s`);
if (failed) process.exit(1);

// Cache atomically so concurrent runs or crashes never leave a half-written cache entry
const stagingDir = `${cachedImportsDir}.tmp-${process.pid}-${Date.now()}`;
mkdirSync(dirname(cachedImportsDir), { recursive: true });
cpSync(importsDir, stagingDir, { recursive: true });
try {
    renameSync(stagingDir, cachedImportsDir);
    console.error(`cached -> ${cachedImportsDir}`);
} catch {
    rmSync(stagingDir, { recursive: true, force: true });
}
