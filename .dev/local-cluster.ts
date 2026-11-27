import { $ } from "bun";
import { dirname, join, resolve } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { check, confirm, have, ok, text } from "./shell-utils.ts";
import { kubectlApplyCdk8sApp } from "./kubectl-utils.ts";

const ROOT = resolve(import.meta.dir, "..");
const K3D_CLUSTER_NAME = "kirdev-local-cluster";
const K3S_IMAGE = "rancher/k3s:v1.36.2-k3s1";
const K3S_ARGS = [
    // Disable k3s's bundled Traefik so it doesn't bind host ports 80/443 and
    // block our own Traefik LoadBalancer inside vc2.
    "--disable=traefik",
    // Use absolute disk-eviction thresholds instead of k3s's 5%/10% of the whole
    // (shared, 500GB) disk, which evicted pods at ~24/48GB free: only evict below
    // 10Gi free, reclaim just to that line, and drop the taint 30s after recovery.
    "--kubelet-arg=eviction-hard=nodefs.available<10Gi,imagefs.available<10Gi",
    "--kubelet-arg=eviction-minimum-reclaim=nodefs.available=0,imagefs.available=0",
    "--kubelet-arg=eviction-pressure-transition-period=30s",
].flatMap((arg) => ["--k3s-arg", `${arg}@server:*`]);
const GIT_SERVER_TARGET_BRANCH = "main";
const GIT_SERVER_NAMESPACE = "argocd";
const GIT_SERVER_SERVICE = "git-server";
const GIT_SERVER_PROXY_LOCAL_PORT = 19418;
const ARGOCD_UI_LOCAL_PORT = 8080;

// CSI snapshot support for local development. Production uses Ceph RBD.
const EXTERNAL_SNAPSHOTTER_VERSION = "v8.6.0";
const HOSTPATH_CSI_VERSION = "v1.18.0";
const HOSTPATH_CSI_DIR = join(ROOT, ".dev", ".cache", "csi-driver-host-path");

const VCLUSTERS = [
    { name: "vc-kirdev", namespace: "vc-kirdev", file: join(ROOT, ".vclusters/vc-kirdev/vcluster.yaml") },
    { name: "vc2", namespace: "vc2", file: join(ROOT, ".vclusters/vc2/vcluster.yaml") },
];

async function isDirty(): Promise<boolean> {
    return (await text($`git -C ${ROOT} status --porcelain`)) !== "";
}

// --- cluster --------------------------------------------------------------

async function k3dClusterExists(): Promise<boolean> {
    const r = await $`k3d cluster list -o json`.quiet().nothrow();
    if (r.exitCode !== 0) return false;
    try {
        const clusters = JSON.parse(r.text()) as { name: string }[];
        return clusters.some((c) => c.name === K3D_CLUSTER_NAME);
    } catch {
        return false;
    }
}

async function vclusterExists(name: string): Promise<boolean> {
    const r = await $`vcluster list --output json`.quiet().nothrow();
    if (r.exitCode !== 0) return false;
    try {
        const vcs = JSON.parse(r.text()) as { Name?: string; name?: string }[];
        return vcs.some((v) => (v.Name ?? v.name) === name);
    } catch {
        return false;
    }
}

/** Create the vCluster on the current context, or connect to it if it exists. */
async function ensureVcluster(vcluster: (typeof VCLUSTERS)[number]): Promise<void> {
    if (!(await vclusterExists(vcluster.name))) {
        await check(
            $`vcluster create ${vcluster.name} -n ${vcluster.namespace} -f ${vcluster.file} < /dev/null`,
            `create vcluster ${vcluster.name}`,
        );
        return;
    }
    console.log(`✓ vcluster ${vcluster.name} exists`);
    if (!(await currentContext()).includes(`vcluster_${vcluster.name}_`)) {
        await check($`vcluster connect ${vcluster.name} -n ${vcluster.namespace}`, `connect vcluster ${vcluster.name}`);
    }
}

async function currentContext(): Promise<string> {
    return text($`kubectl config current-context`);
}

async function assertLocalContext(): Promise<void> {
    const ctx = await currentContext();
    if (!ctx.includes("vcluster") || !ctx.includes(K3D_CLUSTER_NAME)) {
        console.error(`✗ current kubectl context "${ctx}" does not look like the local cluster (${K3D_CLUSTER_NAME}).`);
        console.error("  Run `bun run local-cluster:up` or `bun run local-cluster:connect`.");
        process.exit(1);
    }
}

async function installGitServer(): Promise<void> {
    await check($`kubectl apply -f ${join(ROOT, ".dev/git-server.yaml")}`, "apply git-server");
    await check(
        $`kubectl -n ${GIT_SERVER_NAMESPACE} rollout status deployment/${GIT_SERVER_SERVICE} --timeout=180s`,
        "wait for git-server",
    );
}

/**
 * Push the current HEAD into the in-cluster bare repo as `main`.
 *
 * The local port-forward is the only path from the host into vc2, so the
 * cluster's own git daemon can't be reached directly.
 */
async function publishHead(): Promise<void> {
    const forward = Bun.spawn(
        [
            "kubectl",
            "-n",
            GIT_SERVER_NAMESPACE,
            "port-forward",
            `svc/${GIT_SERVER_SERVICE}`,
            `${GIT_SERVER_PROXY_LOCAL_PORT}:9418`,
        ],
        { stdout: "ignore", stderr: "ignore" },
    );
    try {
        const localUrl = `git://127.0.0.1:${GIT_SERVER_PROXY_LOCAL_PORT}/k8s.git`;
        let ready = false;
        for (let i = 0; i < 40 && !ready; i++) {
            ready = await ok($`timeout 2 git ls-remote ${localUrl}`);
            if (!ready) await Bun.sleep(500);
        }
        if (!ready) {
            console.error(`✗ could not reach the in-cluster git server on 127.0.0.1:${GIT_SERVER_PROXY_LOCAL_PORT}`);
            process.exit(1);
        }
        await check(
            $`git -C ${ROOT} push --force ${localUrl} HEAD:refs/heads/${GIT_SERVER_TARGET_BRANCH}`,
            "push HEAD to git-server",
        );
    } finally {
        forward.kill();
    }
}

// --- ArgoCD ---------------------------------------------------------------

async function installArgoCd(): Promise<void> {
    await check(
        $`kubectl kustomize --enable-helm argocd/ | kubectl apply --server-side -f -`.cwd(ROOT),
        "install Argo CD",
    );
    await check(
        $`kubectl wait --for=condition=Established --timeout=180s crd/applications.argoproj.io crd/applicationsets.argoproj.io`,
        "wait for Argo CD CRDs",
    );
    await check(
        $`kubectl -n argocd rollout status deployment/argocd-applicationset-controller --timeout=180s`,
        "wait for argocd-applicationset-controller",
    );
}

async function applyDevStorageClasses(): Promise<void> {
    await check($`kubectl apply -f ${join(ROOT, ".dev/dev-storage-classes.yaml")}`, "apply dev storage classes");
}

/**
 * Install a snapshot-capable CSI driver on the (host) k3d cluster so that
 * VolSync's CSI volume snapshots work locally. Production uses Ceph RBD instead.
 *
 * `memory-ssd` in `.dev/dev-storage-classes.yaml` points at this driver, and
 * the vClusters sync the VolumeSnapshotClass(es) into the tenant cluster
 * (where VolSync runs).
 */
async function installHostPathCsiDriver(): Promise<void> {
    const snapshotter = `https://raw.githubusercontent.com/kubernetes-csi/external-snapshotter/${EXTERNAL_SNAPSHOTTER_VERSION}`;
    for (const crd of ["volumesnapshotclasses", "volumesnapshotcontents", "volumesnapshots"]) {
        await check(
            $`kubectl apply -f ${snapshotter}/client/config/crd/snapshot.storage.k8s.io_${crd}.yaml`,
            `apply ${crd} CRD`,
        );
    }
    await check(
        $`kubectl apply -f ${snapshotter}/deploy/kubernetes/snapshot-controller/rbac-snapshot-controller.yaml`,
        "apply snapshot-controller RBAC",
    );
    await check(
        $`kubectl apply -f ${snapshotter}/deploy/kubernetes/snapshot-controller/setup-snapshot-controller.yaml`,
        "apply snapshot-controller",
    );

    mkdirSync(dirname(HOSTPATH_CSI_DIR), { recursive: true });
    if (!existsSync(HOSTPATH_CSI_DIR)) {
        await check(
            $`git clone --depth 1 --branch ${HOSTPATH_CSI_VERSION} https://github.com/kubernetes-csi/csi-driver-host-path ${HOSTPATH_CSI_DIR}`,
            "clone csi-driver-host-path",
        );
    }
    await check($`${join(HOSTPATH_CSI_DIR, "deploy/kubernetes-latest/deploy.sh")}`, "deploy csi-driver-host-path");
}

async function up(): Promise<void> {
    for (const bin of ["k3d", "vcluster", "kubectl", "helm", "git", "curl", "bun"]) {
        if (!(await have(bin))) {
            console.error(`✗ missing required tool: ${bin}`);
            process.exit(1);
        }
    }

    if (await isDirty()) {
        console.warn("⚠ the working tree has uncommitted changes.");
        console.warn("  ArgoCD only sees committed work; run `bun run local-cluster:sync` to publish HEAD.");
    }

    await check($`bun install`.cwd(ROOT), "bun install");
    await check($`bun run cdk8s:import`.cwd(ROOT), "cdk8s:import");

    if (!(await k3dClusterExists())) {
        await check($`k3d cluster create ${K3D_CLUSTER_NAME} --image ${K3S_IMAGE} ${K3S_ARGS}`, "create k3d cluster");
    } else {
        console.log(`✓ k3d cluster ${K3D_CLUSTER_NAME} exists`);
    }

    await check($`kubectl config use-context k3d-${K3D_CLUSTER_NAME}`, "switch to k3d context");
    await installHostPathCsiDriver();
    await applyDevStorageClasses();
    await ensureVcluster(VCLUSTERS[0]);
    await ensureVcluster(VCLUSTERS[1]);

    await installArgoCd();
    await installGitServer();
    await publishHead();

    // Dynamic import so `cdk8s:import` can generate `imports/` before loading the app.
    const { default: applicationSet } = await import("../application-set/app.ts");
    await kubectlApplyCdk8sApp(applicationSet, { serverSide: true });

    await sync();
}

/** Reconnect nested vCluster port-forwards (k3d -> vc-kirdev -> vc2). */
async function connect(): Promise<void> {
    if (!(await k3dClusterExists())) {
        console.error(`✗ k3d cluster "${K3D_CLUSTER_NAME}" does not exist. Run \`bun run local-cluster:up\`.`);
        process.exit(1);
    }
    await check($`kubectl config use-context k3d-${K3D_CLUSTER_NAME}`, "switch to k3d context");
    for (const vc of VCLUSTERS) {
        await check($`vcluster connect ${vc.name} -n ${vc.namespace}`, `connect vcluster ${vc.name}`);
    }
    console.log(`✓ connected to ${await currentContext()}`);
}

async function sync(): Promise<void> {
    await assertLocalContext();

    if (await isDirty()) {
        console.warn("⚠ the working tree is dirty. Only committed work is pushed to");
        console.warn(`  ${GIT_SERVER_TARGET_BRANCH}, so ArgoCD will not see your uncommitted changes.`);
        if (!(await confirm("Continue anyway?"))) process.exit(1);
    }

    await publishHead();

    // Refresh Argo CD
    await check(
        $`kubectl -n argocd annotate applicationset/apps argocd.argoproj.io/application-set-refresh=true --overwrite`,
        "refresh ApplicationSet",
    );
    await check(
        $`kubectl -n argocd annotate applications --all argocd.argoproj.io/refresh=normal --overwrite`,
        "refresh Applications",
    );
}

/** Print a concise status overview of Argo CD apps, unhealthy pods, and manual secrets. */
async function status(): Promise<void> {
    await assertLocalContext();

    const appsRaw = await text($`kubectl -n argocd get applications -o json`);
    const apps = (JSON.parse(appsRaw).items ?? []) as {
        metadata: { name: string };
        status?: {
            sync?: { status?: string };
            health?: { status?: string };
            operationState?: { phase?: string; message?: string };
        };
    }[];

    const healthyCount = apps.filter(
        (a) => a.status?.sync?.status === "Synced" && a.status?.health?.status === "Healthy",
    ).length;
    console.log(`Argo CD Applications (${healthyCount}/${apps.length} Synced & Healthy):`);
    for (const app of apps) {
        const syncStatus = app.status?.sync?.status ?? "Unknown";
        const healthStatus = app.status?.health?.status ?? "Unknown";
        const icon = syncStatus === "Synced" && healthStatus === "Healthy" ? "✓" : "!";
        const extra =
            icon === "!" && app.status?.operationState?.message ? `  (${app.status.operationState.message})` : "";
        console.log(`  ${icon} ${app.metadata.name.padEnd(26)} ${syncStatus.padEnd(10)} ${healthStatus}${extra}`);
    }

    const podsRaw = await text($`kubectl get pods -A -o json`);
    const pods = (JSON.parse(podsRaw).items ?? []) as {
        metadata: { namespace: string; name: string };
        status?: {
            phase?: string;
            containerStatuses?: { ready: boolean; restartCount: number; state?: Record<string, { reason?: string }> }[];
        };
    }[];
    const problemPods = pods.filter((p) => {
        const phase = p.status?.phase;
        if (phase === "Succeeded") return false;
        const statuses = p.status?.containerStatuses ?? [];
        const allReady = statuses.length > 0 && statuses.every((c) => c.ready);
        const restarts = statuses.reduce((acc, c) => acc + c.restartCount, 0);
        return phase !== "Running" || !allReady || restarts > 0;
    });
    console.log(`\nPods (${pods.length} total, ${problemPods.length} with issues/restarts):`);
    for (const p of problemPods) {
        const statuses = p.status?.containerStatuses ?? [];
        const ready = `${statuses.filter((c) => c.ready).length}/${statuses.length}`;
        const restarts = statuses.reduce((acc, c) => acc + c.restartCount, 0);
        const reason =
            statuses.map((c) => c.state?.waiting?.reason ?? c.state?.terminated?.reason).find(Boolean) ??
            p.status?.phase ??
            "Unknown";
        console.log(
            `  ! ${(p.metadata.namespace + "/" + p.metadata.name).padEnd(55)} ready=${ready} restarts=${restarts} ${reason}`,
        );
    }

    const secretsRaw = await text($`kubectl get secrets -A -o json`);
    const secrets = (JSON.parse(secretsRaw).items ?? []) as {
        metadata: { namespace: string; name: string; annotations?: Record<string, string> };
        data?: Record<string, string>;
    }[];
    const manualSecrets = secrets.filter((s) => s.metadata.annotations?.["kir-dev.hu/required-keys"]);
    if (manualSecrets.length > 0) {
        console.log(`\nManual Secrets (${manualSecrets.length}):`);
        for (const s of manualSecrets) {
            const required = (s.metadata.annotations?.["kir-dev.hu/required-keys"] ?? "")
                .split(",")
                .map((k) => k.trim())
                .filter(Boolean);
            const present = new Set(Object.keys(s.data ?? {}));
            const missing = required.filter((k) => !present.has(k));
            const icon = missing.length === 0 ? "✓" : "!";
            const detail = missing.length === 0 ? "all keys set" : `missing: ${missing.join(", ")}`;
            console.log(`  ${icon} ${(s.metadata.namespace + "/" + s.metadata.name).padEnd(42)} ${detail}`);
        }
    }
}

/** Print the Argo CD admin password and port-forward the UI to localhost. */
async function argocd(): Promise<void> {
    await assertLocalContext();

    const encoded = await text(
        $`kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath={.data.password}`,
    );
    const password = encoded ? Buffer.from(encoded, "base64").toString("utf-8") : "(secret not found)";
    console.log(`Argo CD UI:  https://localhost:${ARGOCD_UI_LOCAL_PORT}`);
    console.log(`Username:    admin`);
    console.log(`Password:    ${password}`);
    console.log(`\nPress Ctrl-C to stop port-forwarding...`);

    const proc = Bun.spawn(
        ["kubectl", "-n", "argocd", "port-forward", "svc/argocd-server", `${ARGOCD_UI_LOCAL_PORT}:443`],
        { stdout: "inherit", stderr: "inherit" },
    );
    process.on("SIGINT", () => proc.kill());
    process.on("SIGTERM", () => proc.kill());
    await proc.exited;
}

async function down(): Promise<void> {
    await $`k3d cluster delete ${K3D_CLUSTER_NAME}`;
}

const command = process.argv[2];
const commands = { up, connect, sync, status, argocd, down } as const;
if (!command || !(command in commands)) {
    console.error(`usage: bun run local-cluster:{${Object.keys(commands).join(",")}} [--yes]`);
    process.exit(1);
}
await commands[command as keyof typeof commands]();
