import { $ } from "bun";
import { dirname, join, resolve } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { check, confirm, have, ok, text } from "./shell-utils";
import applicationSet from "../application-set/app.ts";
import { kubectlApplyCdk8sApp } from "./kubectl-utils.ts";

const ROOT = resolve(import.meta.dir, "..");
const K3D_CLUSTER_NAME = "kirdev-local-cluster";
const K3S_IMAGE = "rancher/k3s:v1.36.2-k3s1";
const K3S_ARGS = [
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
        await check($`vcluster create ${vcluster.name} -n ${vcluster.namespace} -f ${vcluster.file} < /dev/null`); // < /dev/null stops dumb questions
        return;
    }
    console.log(`✓ vcluster ${vcluster.name} exists`);
    if (!(await currentContext()).includes(`vcluster_${vcluster.name}_`)) {
        await check($`vcluster connect ${vcluster.name} -n ${vcluster.namespace}`);
    }
}

async function currentContext(): Promise<string> {
    return text($`kubectl config current-context`);
}

async function assertLocalContext(): Promise<void> {
    const ctx = await currentContext();
    if (!ctx.includes("vcluster") || !ctx.includes(K3D_CLUSTER_NAME)) {
        console.error(`✗ current kubectl context "${ctx}" does not look like the local cluster (${K3D_CLUSTER_NAME}).`);
        console.error("  Run `bun run local-cluster:up`.");
        process.exit(1);
    }
}

async function installGitServer(): Promise<void> {
    await check($`kubectl apply -f ${join(ROOT, ".dev/git-server.yaml")}`);
    await check($`kubectl -n ${GIT_SERVER_NAMESPACE} rollout status deployment/${GIT_SERVER_SERVICE} --timeout=180s`);
}

/**
 * Push the current HEAD into the in-cluster bare repo as `main`.
 *
 * The local port-forward is the only path from the host into vc2, so the
 * cluster's own git daemon can't be reached directly.
 */
async function publishHead(): Promise<void> {
    const forward = Bun.spawn(
        ["kubectl", "-n", "argocd", "port-forward", `svc/git-server`, `${GIT_SERVER_PROXY_LOCAL_PORT}:9418`],
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
        await check($`git -C ${ROOT} push --force ${localUrl} HEAD:refs/heads/${GIT_SERVER_TARGET_BRANCH}`);
    } finally {
        forward.kill();
    }
}

// --- ArgoCD ---------------------------------------------------------------

async function installArgoCd(): Promise<void> {
    await check($`kubectl kustomize --enable-helm argocd/ | kubectl apply -f -`.cwd(ROOT));
    await check(
        $`kubectl wait --for=condition=Established --timeout=180s crd/applications.argoproj.io crd/applicationsets.argoproj.io`,
    );
    await check($`kubectl -n argocd rollout status deployment/argocd-applicationset-controller --timeout=180s`);
}

async function applyDevStorageClasses(): Promise<void> {
    await check($`kubectl apply -f ${join(ROOT, ".dev/dev-storage-classes.yaml")}`);
}

/**
 * Install a snapshot-capable CSI driver on the (host) k3d cluster so that
 * Velero's volume snapshots work locally. Production uses Ceph RBD instead.
 *
 * `memory-ssd` in `.dev/dev-storage-classes.yaml` points at this driver, and
 * the vClusters sync the VolumeSnapshotClass(es) into the tenant cluster
 * (where Velero runs).
 */
async function installHostPathCsiDriver(): Promise<void> {
    const snapshotter = `https://raw.githubusercontent.com/kubernetes-csi/external-snapshotter/${EXTERNAL_SNAPSHOTTER_VERSION}`;
    for (const crd of ["volumesnapshotclasses", "volumesnapshotcontents", "volumesnapshots"]) {
        await check($`kubectl apply -f ${snapshotter}/client/config/crd/snapshot.storage.k8s.io_${crd}.yaml`);
    }
    await check($`kubectl apply -f ${snapshotter}/deploy/kubernetes/snapshot-controller/rbac-snapshot-controller.yaml`);
    await check(
        $`kubectl apply -f ${snapshotter}/deploy/kubernetes/snapshot-controller/setup-snapshot-controller.yaml`,
    );

    mkdirSync(dirname(HOSTPATH_CSI_DIR), { recursive: true });
    if (!existsSync(HOSTPATH_CSI_DIR)) {
        await check(
            $`git clone --depth 1 --branch ${HOSTPATH_CSI_VERSION} https://github.com/kubernetes-csi/csi-driver-host-path ${HOSTPATH_CSI_DIR}`,
        );
    }
    await check($`${join(HOSTPATH_CSI_DIR, "deploy/kubernetes-latest/deploy.sh")}`);

    // Velero selects a VolumeSnapshotClass by the
    // `velero.io/csi-volumesnapshot-class: "true"` label (or a default
    // annotation); the stock hostpath class has neither.
    await check(
        $`kubectl label volumesnapshotclass csi-hostpath-snapclass velero.io/csi-volumesnapshot-class=true --overwrite`,
    );
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

    await check($`bun install`.cwd(ROOT));
    await check($`bun run cdk8s:import`.cwd(ROOT));

    if (!(await k3dClusterExists())) {
        await check($`k3d cluster create ${K3D_CLUSTER_NAME} --image ${K3S_IMAGE} ${K3S_ARGS}`);
    } else {
        console.log(`✓ k3d cluster ${K3D_CLUSTER_NAME} exists`);
    }

    await check($`kubectl config use-context k3d-${K3D_CLUSTER_NAME}`);
    await installHostPathCsiDriver();
    await applyDevStorageClasses();
    await ensureVcluster(VCLUSTERS[0]);
    await ensureVcluster(VCLUSTERS[1]);

    await installArgoCd();
    await installGitServer();
    await publishHead();
    await kubectlApplyCdk8sApp(applicationSet);

    await sync();
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
    );
    await check($`kubectl -n argocd annotate applications --all argocd.argoproj.io/refresh=normal --overwrite`);
}

async function down(): Promise<void> {
    await $`k3d cluster delete ${K3D_CLUSTER_NAME}`;
}

const command = process.argv[2];
const commands = { up, sync, down } as const;
if (!command || !(command in commands)) {
    console.error("usage: bun run local-cluster:{up,sync,down} [--yes]");
    process.exit(1);
}
await commands[command as keyof typeof commands]();
