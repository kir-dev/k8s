# Kir-Dev Kubernetes configuration and deployment documetation

This repo contains our Kubernetes configuration
deployed following GitOps principles using Argo CD,
and documentation for deploying our other projects.


## Documentation specification

The documentation specification can be found in [`DOCUMENTATION_SPEC.md`](https://github.com/kir-dev/k8s/blob/main/DOCUMENTATION_SPEC.md)

## Running locally

This setup requires installing quite a few tools:
[docker](https://docs.docker.com/engine/install/),
[kubectl](https://kubernetes.io/docs/tasks/tools/#kubectl),
[bun](https://bun.com/docs/installation),
[k3d](https://k3d.io/stable/#installation),
[helm](https://helm.sh/docs/intro/install),
and [vcluster](https://www.vcluster.com/install).
The recommended way is to:
- [install the Nix package manager](https://nixos.org/download/#download-nix),
- [install Docker](https://docs.docker.com/engine/install/),
- then `nix develop` in the repo root to enter a shell with all the necessary tools:

```bash
git clone https://github.com/kir-dev/k8s
cd k8s

# enter the nix dev shell (if using nix)
nix develop

# install JS dependencies,
# rerun anytime dependencies in package.json change!
bun install

# install Kubernetes Custom Resource Definitions so that they are usable through TypeScript,
# rerun anytime cdk8s.yaml changes!
bun run cdk8s:import

# run typecheck, formatting, unit tests, and manifest validation
bun run check

# creates a k3d cluster very similar to prod
bun run local-cluster:up

# inspect Argo CD app sync/health, unhealthy pods, and missing manual secrets
bun run local-cluster:status

# open the Argo CD UI (prints admin password and port-forwards https://localhost:8080)
bun run local-cluster:argocd

# update the local config, commit!,
# then run this to push your changes to the local cluster
bun run local-cluster:sync

# reconnect nested vCluster port-forwards if they dropped (e.g. after sleep/reboot)
bun run local-cluster:connect

# delete the local k3d cluster
bun run local-cluster:down
```

If you encounter any issues, [open a GitHub issue](https://github.com/kir-dev/k8s/issues/new),
so that others won't have to run into them again.

## Adding a new app

Create a new top-level directory containing:

- a cdk8s app (recommended — see [kir-dev-app.md](kir-dev-app.md) for the full API):
  - `app.ts`:
    ```ts
    import { isProduction } from "../.dev/environment.ts";
    import { createBackblaze, createKirDevApp, manualSecret } from "../.dev/kir-dev-app.ts";
    import { versions } from "./versions.ts";

    const b2 = createBackblaze("myapp-backups");
    const app = createKirDevApp("myapp");

    const db = app.addPostgres({
        image: "ghcr.io/cloudnative-pg/postgresql:17.5",
        backup: isProduction
            ? {
                  provider: b2.withPrefix("postgres/"),
                  schedule: "0 24 3 * * *",
              }
            : false,
    });

    app.addDocker({
        image: versions.image,
        env: {
            NODE_ENV: "production",
            DATABASE_URI: db.uri,
            APP_SECRET: manualSecret({ optional: !isProduction }),
        },
        readinessProbe: { path: "/healthz" },
        livenessProbe: { path: "/healthz" },
    })
        .port(3000)
        .publish("myapp.kir-dev.hu");

    export default app.build();
    ```
  - `renovate.ts`:
    ```ts
    import { appConfig } from "../.dev/renovate-config.ts";

    export default appConfig("myapp");
    ```
  - `versions.ts`:
    ```ts
    export const versions = {
        image: "ghcr.io/kir-dev/myapp:v0.0.1@sha256:aaaaaaaaaaaaaa",
    };
    ```
- or `.yaml` files defining Kubernetes resources,
- or a `kustomization.yaml` (e.g. using [`helmCharts:`](https://kubectl.docs.kubernetes.io/references/kustomize/builtins/#_helmchartinflationgenerator_) to install Helm charts, with values in `values.yaml` or `valuesInline:`).

Argo CD checks every top-level directory except ones starting with a `.`. If it sees `app.ts`, it synthesizes it with the `cdk8s` CMP; if it sees `kustomization.yaml`, it builds it with `kustomize --enable-helm`; otherwise it applies plain `.yaml` files.

Run `bun run check` (or `bun run validate:all` to also check Kustomize/Helm charts) before opening a PR.

> [!IMPORTANT]
> Ensure that every single deployment/pod has CPU/memory/ephemeral-storage requests and limits specified (even for resources created by a Helm chart!).
> Missing it anywhere causes Argo CD to crash due to a bug with nested vClusters. `bun run validate:all` enforces this automatically.

## Notes

- Some Helm charts put CRDs into `templates/` instead of `crds/` so `includeCRDs: true/false` in `kustomization.yaml` has no effect.
- Some Helm charts include a schema for `values.yaml`. https://artifacthub.io shows whether there is one.
  - To get code completion, put a
    ```yaml
    # yaml-language-server: $schema=https://.../values.schema.json
    ```
    at the top of `values.yaml`. Find the `values.schema.json` file in the chart's GitHub repository, then press *Raw* to get a link.
- Set `resources.{limits,requests}.ephemeral-storage`, as the default (`1Gi`) uses up too much of our quota.
- Always specify the exact Postgres image version for CNPG `Cluster`s, otherwise backups can't be restored due to version mismatch.
- Don't forget `database`/`owner` fields when restoring a CNPG DB from a backup.
- Manual secrets: leave `data`/`stringData` empty in Git and populate them with `kubectl`. Secrets created by `createKirDevApp` are annotated with `argocd.argoproj.io/compare-options: IgnoreExtraneous` and `kir-dev.hu/required-keys` so Argo CD preserves manual keys and `bun run local-cluster:status` can list missing ones.

## Documentation links

- ArgoCD `Application` resource reference: https://argo-cd.readthedocs.io/en/stable/user-guide/application-specification/
- Manage Argo CD Using Argo CD:
  https://argo-cd.readthedocs.io/en/stable/operator-manual/declarative-setup/#manage-argo-cd-using-argo-cd
- `kustomization.yaml` documentation: https://kubectl.docs.kubernetes.io/references/kustomize/kustomization/
- KSZK vCluster docs: https://git.sch.bme.hu/kszk/sysadmin/k8s/vcluster-docs

## Production cluster

`vc-kirdev` vCluster at [KSZK](https://kszk.bme.hu). This repo is deployed into a `vc2` vCluster inside `vc-kirdev`.

### Bootstrapping the production cluster

Given `kubectl config current-context` == `vc-kirdev`, the following installs the inner vCluster, Argo CD, and the ApplicationSet.

```bash
bun install
bun run bootstrap-prod
```

### Updating the `vc2` vCluster

```sh
vcluster create --upgrade vc2 -n vc2 -f .vclusters/vc2/vcluster.yaml
```

### Production cluster notes

KSZK has a Kubernetes cluster with 7 worker nodes. `vc-kirdev` is Kir-Dev's vCluster inside that. `vc2` is a vCluster inside `vc-kirdev`.

- A snapshot of `vc-kirdev`'s config is in [`./.vclusters/vc-kirdev/vcluster.yaml`](.vclusters/vc-kirdev/vcluster.yaml). It might be outdated and differ from the live config.
- `vc2`'s config is [`./.vclusters/vc2/vcluster.yaml`](.vclusters/vc2/vcluster.yaml). It is managed by Kir-Dev and is up to date.

#### Host-level policies & limits (not always visible from inside `vc2`)

- **Default-deny ingress `NetworkPolicy`**: The root KSZK cluster blocks external ingress to pods in the vCluster by default (so workloads aren't exposed on the dormitory network). Anything exposed via a `LoadBalancer` Service (like Traefik or public Postgres DBs) **must** include an ingress `NetworkPolicy` allowing its target port (`db.publish(...)` creates this automatically).
- **`PodSecurityStandard: baseline`**: Enforced on both `vc-kirdev` and `vc2`. Privileged containers, hostNetwork/hostPath, etc. are rejected.
- **`LimitRange` defaults (on `vc-kirdev`)**: Containers that omit requests/limits inherit default limits (`cpu: 1`, `memory: 1Gi`, `ephemeral-storage: 1Gi`) and default requests (`cpu: 100m`, `memory: 128Mi`, `ephemeral-storage: 40Mi`). Always specify explicit requests and limits on every container.
- **`ResourceQuota` (on `vc-kirdev`)**: Total quota across `vc-kirdev` is capped (100 CPU, 80Gi RAM, 40Gi/100Gi ephemeral storage, 1000Gi total PVC storage, 200 pods, 16 LoadBalancers, 400 Secrets/ConfigMaps/Services).
- **StorageClasses & `VolumeSnapshotClass` mapping**:
  - `memory-ssd`: Ceph RBD SSD network storage (snapshot class: `memory`)
  - `memory-ssd-rwx`: Ceph RBD RWX SSD network storage (snapshot class: `memory-ssd`)
  - `memory-hdd`: Ceph RBD HDD network storage (snapshot class: `memory`)
  - `node-local-zfs`: Local node NVMe/SSD — fastest, used for multi-replica CNPG Postgres (snapshot class: `node-local-zfs`). Always pair with `podAntiAffinityType: required` for `instances > 1` so replicas land on different nodes.
- **LoadBalancer IPs (Cilium LB IPAM)**: Request fixed public IPs with annotations `lbipam.cilium.io/ips` and `lbipam.cilium.io/sharing-key` (not `spec.loadBalancerIP`).
  - `152.66.192.38` (`sharing-key: traefik`): Traefik HTTP/HTTPS/HTTP3 ingress.
  - `152.66.192.36` (`sharing-key: kir-sharing-key`): Shared IP for externally exposed Postgres databases (distinct TCP ports per app).
