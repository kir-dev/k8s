/**
 * Validate all Kubernetes manifests in this repository:
 *  - Synthesize every cdk8s app in both Production and Development modes
 *  - Parse raw YAML app directories (and `.dev/git-server.yaml`)
 *  - With `--kustomize`, build every `kustomization.yaml` (via `kubectl kustomize --enable-helm`)
 *  - Enforce cluster invariants:
 *      * Every container/initContainer defines cpu, memory, and ephemeral-storage requests & limits
 *      * Container requests <= limits
 *      * No duplicate env var names on any container
 *      * Cluster-scoped objects do not set `metadata.namespace`
 *      * GarageCluster/GarageKey declare operator defaults to prevent ArgoCD drift
 *      * `versions.ts` image strings match the Renovate custom regex
 */
import { $ } from "bun";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseAllDocuments } from "yaml";
import { appConfig } from "./renovate-config.ts";

const ROOT = resolve(import.meta.dir, "..");
const includeKustomize = process.argv.includes("--kustomize");

const CLUSTER_SCOPED_KINDS = new Set([
    "APIService",
    "ClusterIssuer",
    "ClusterRole",
    "ClusterRoleBinding",
    "CSIDriver",
    "CustomResourceDefinition",
    "GatewayClass",
    "IngressClass",
    "MutatingWebhookConfiguration",
    "Namespace",
    "Node",
    "PersistentVolume",
    "PriorityClass",
    "RuntimeClass",
    "StorageClass",
    "ValidatingWebhookConfiguration",
    "VolumeSnapshotClass",
]);

const errors: string[] = [];

function parseQuantity(raw: string | number): number | null {
    if (typeof raw === "number") return raw;
    const str = String(raw).trim();
    const match = /^([0-9]*\.?[0-9]+)(Ki|Mi|Gi|Ti|Pi|Ei|m|k|K|M|G|T|P|E)?$/.exec(str);
    if (!match) return null;
    const value = Number(match[1]);
    const unit = match[2] ?? "";
    const multipliers: Record<string, number> = {
        "": 1,
        m: 1e-3,
        k: 1e3,
        K: 1e3,
        M: 1e6,
        G: 1e9,
        T: 1e12,
        P: 1e15,
        E: 1e18,
        Ki: 1024,
        Mi: 1024 ** 2,
        Gi: 1024 ** 3,
        Ti: 1024 ** 4,
        Pi: 1024 ** 5,
        Ei: 1024 ** 6,
    };
    return value * (multipliers[unit] ?? 1);
}

function validateContainer(source: string, workload: string, container: any, isInit: boolean): void {
    const label = `${source} | ${workload} [${isInit ? "init:" : ""}${container.name}]`;
    const req = container.resources?.requests ?? {};
    const lim = container.resources?.limits ?? {};

    for (const key of ["cpu", "memory", "ephemeral-storage"] as const) {
        if (req[key] === undefined) {
            errors.push(`${label}: missing resources.requests.${key}`);
        }
        if (lim[key] === undefined) {
            errors.push(`${label}: missing resources.limits.${key}`);
        }
        if (req[key] !== undefined && lim[key] !== undefined) {
            const reqVal = parseQuantity(req[key]);
            const limVal = parseQuantity(lim[key]);
            if (reqVal !== null && limVal !== null && reqVal > limVal) {
                errors.push(`${label}: requests.${key} (${req[key]}) > limits.${key} (${lim[key]})`);
            }
        }
    }

    const seenEnv = new Set<string>();
    for (const env of container.env ?? []) {
        if (seenEnv.has(env.name)) {
            errors.push(`${label}: duplicate env var "${env.name}"`);
        }
        seenEnv.add(env.name);
    }
}

function validateManifests(source: string, yamlText: string): number {
    let count = 0;
    for (const doc of parseAllDocuments(yamlText)) {
        if (doc.errors.length > 0) {
            for (const err of doc.errors) {
                errors.push(`${source}: YAML parse error: ${err.message}`);
            }
            continue;
        }
        const obj = doc.toJS();
        if (!obj || typeof obj !== "object" || !obj.kind) continue;
        count++;

        const kind: string = obj.kind;
        const name: string = obj.metadata?.name ?? "<unnamed>";
        const ns: string | undefined = obj.metadata?.namespace;
        const id = `${kind}/${ns ?? "_"}/${name}`;

        if (CLUSTER_SCOPED_KINDS.has(kind) && ns) {
            errors.push(`${source} | ${id}: cluster-scoped resource should not set metadata.namespace`);
        }

        let podSpec: any = null;
        if (["Deployment", "StatefulSet", "DaemonSet", "ReplicaSet", "Job"].includes(kind)) {
            podSpec = obj.spec?.template?.spec;
        } else if (kind === "CronJob") {
            podSpec = obj.spec?.jobTemplate?.spec?.template?.spec;
        } else if (kind === "Pod") {
            podSpec = obj.spec;
        }
        if (podSpec) {
            for (const c of podSpec.initContainers ?? []) validateContainer(source, id, c, true);
            for (const c of podSpec.containers ?? []) validateContainer(source, id, c, false);
        }

        if (kind === "GarageCluster") {
            if (obj.spec?.storage?.dataFsync === undefined || obj.spec?.storage?.metadataFsync === undefined) {
                errors.push(
                    `${source} | ${id}: GarageCluster must declare storage.dataFsync and storage.metadataFsync`,
                );
            }
        }
        if (kind === "GarageKey") {
            if (obj.spec?.neverExpires === undefined) {
                errors.push(`${source} | ${id}: GarageKey must declare spec.neverExpires`);
            }
        }
    }
    return count;
}

const topDirs = readdirSync(ROOT, { withFileTypes: true })
    .filter(
        (entry) =>
            entry.isDirectory() &&
            !entry.name.startsWith(".") &&
            !["node_modules", "dist", "imports"].includes(entry.name),
    )
    .map((entry) => entry.name)
    .sort();

let totalResources = 0;

// 1. Validate cdk8s apps in both Production and Development environments
for (const dir of topDirs) {
    if (!existsSync(join(ROOT, dir, "app.ts"))) continue;

    for (const [envLabel, repoUrl] of [
        ["prod", "https://github.com/kir-dev/k8s"],
        ["dev", "git://git-server.argocd.svc.cluster.local:9418/k8s.git"],
    ] as const) {
        const result = await $`bun .dev/cdk8s-synth.ts --stdout ${dir}`
            .cwd(ROOT)
            .env({ ...process.env, ARGOCD_APP_SOURCE_REPO_URL: repoUrl })
            .quiet()
            .nothrow();
        if (result.exitCode !== 0) {
            errors.push(`${dir} (${envLabel}): synth failed:\n${result.stderr.toString()}`);
            continue;
        }
        totalResources += validateManifests(`${dir} (${envLabel})`, result.stdout.toString());
    }
}

// 2. Validate raw YAML directories and `.dev/git-server.yaml`
for (const dir of topDirs) {
    if (existsSync(join(ROOT, dir, "app.ts")) || existsSync(join(ROOT, dir, "kustomization.yaml"))) continue;
    for (const file of readdirSync(join(ROOT, dir))) {
        if (!file.endsWith(".yaml") && !file.endsWith(".yml")) continue;
        const fullPath = join(ROOT, dir, file);
        totalResources += validateManifests(`${dir}/${file}`, readFileSync(fullPath, "utf-8"));
    }
}
totalResources += validateManifests(".dev/git-server.yaml", readFileSync(join(ROOT, ".dev/git-server.yaml"), "utf-8"));

// 3. Optionally validate Kustomize + Helm charts
if (includeKustomize) {
    for (const dir of topDirs) {
        if (!existsSync(join(ROOT, dir, "kustomization.yaml"))) continue;
        const result = await $`kubectl kustomize --enable-helm ${dir}`.cwd(ROOT).quiet().nothrow();
        if (result.exitCode !== 0) {
            errors.push(`${dir} (kustomize): build failed:\n${result.stderr.toString()}`);
            continue;
        }
        totalResources += validateManifests(`${dir} (kustomize)`, result.stdout.toString());
    }
}

// 4. Validate Renovate regex matches all image refs in versions.ts
const renovateSample = appConfig("sample") as any;
const imageRegex = new RegExp(renovateSample.repositories[0].customManagers[0].matchStrings[0]);
for (const dir of topDirs) {
    const versionsFile = join(ROOT, dir, "versions.ts");
    const renovateFile = join(ROOT, dir, "renovate.ts");
    if (!existsSync(versionsFile)) continue;
    if (!existsSync(renovateFile)) {
        errors.push(`${dir}: has versions.ts without renovate.ts`);
    }
    const mod = (await import(versionsFile)) as { versions?: Record<string, string> };
    for (const [key, ref] of Object.entries(mod.versions ?? {})) {
        if (!imageRegex.test(`"${ref}"`)) {
            errors.push(`${dir}/versions.ts: versions.${key} ("${ref}") does not match Renovate regex`);
        }
    }
}

if (errors.length > 0) {
    console.error(`✗ validation failed with ${errors.length} error(s):`);
    for (const err of errors) console.error(`  - ${err}`);
    process.exit(1);
}

console.log(
    `✓ validated ${totalResources} Kubernetes resources across ${topDirs.length} directories${includeKustomize ? " (including kustomize)" : ""}`,
);
