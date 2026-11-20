# Kir-Dev Kubernetes configuration and deployment documetation

This repo contains our Kubernetes configuration and deployment documentation,
deployed following GitOps principles using Argo CD.


## Documentation specification

The specification is written in accordance with [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119.txt).

All project documentation MUST be located in the `k8s` repository. Each project MUST have a folder named after the project in `kebab-case` (e.g., `pek-infinity`). If there are multiple variants or components of the same project, they MUST be distinguished using hyphens in the folder name, still in `kebab-case` (e.g., `<project-name>-<variant>`, such as `pek-v4` or `pek-v4-backend`).

Each project folder MUST contain an `app.ts` file. The folder SHOULD contain Markdown files (ending in `.md`) where the bulk of the documentation is written, and you MAY add any supplementary materials as you see fit. You MAY structure your documentation however you like using subfolders. If the documentation includes any images, they MUST be uploaded to Warp and referenced from there (they MUST NOT be committed directly to the repository).

You MUST update the documentation whenever anything changes.

In terms of project ownership and personal information:
- Each project MUST specify its **maintainer** (the person responsible for the project).
- Personal information (e.g., personal email addresses, phone numbers, or other private contact details) MUST NOT be stored in the repository; all personal information MUST be placed on the Simonyi Wiki instead, and you SHOULD link to the relevant Simonyi Wiki page.

In terms of the project's deployment documentation:
- It MUST contain the public URL(s) of the deployed project (e.g., `kir-dev.hu`).
- It MUST list what services are used.
- It MUST specify where the project is currently running, and you SHOULD add hyperlinks to the current deployment setup.
- It MUST specify where the running configuration files are located, or you MUST add hyperlinks to their locations. If the project uses a GUI-based platform (e.g., Vercel), you SHOULD add hyperlinks to the platform's settings.
- It MUST contain step-by-step deployment instructions for the project.
  - The instructions SHOULD include project-specific terminal commands.
- If the project isn't deployed by Kir-Dev, it MUST contain the name of the hosting organization and the name(s) of the person(s) responsible for the deployment. Any personal contact information (e.g., email, phone) MUST be stored on the Simonyi Wiki rather than in the repository, and you SHOULD link to the relevant Simonyi Wiki page.

In terms of the project's update/upgrade documentation:
- It MUST contain known incompatibilities with detailed descriptions (e.g., if the project does not run on a newer version of Node.js).
- It MUST document deliberate version pins (e.g., if the project only works with Node.js 22.10.x).
- It SHOULD specify the order of operations for updates/upgrades (i.e., in what order the project's components should be updated).

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

# creates a k3d cluster very similar to prod
bun run local-cluster:up

# update the local config, commit!,
# then run this to push your changes to the local cluster
bun run local-cluster:sync

# delete the local k3d cluster
bun run local-cluster:down
```

If you encounter any issues, [open a GitHub issue](https://github.com/kir-dev/k8s/issues/new),
so that others won't have to run into them again.

## Adding a new app

Create a new directory containing

- a cdk8s app:
  - `app.ts`:
    ```ts
    import { versions } from "./versions.ts";
    import * as kube from "../imports/k8s";
    import * as environment from "../.dev/environment.ts";
    import * as cnpg from "../imports/postgresql.cnpg.io.ts";
    class MyApp extends Chart {
        constructor(scope: Construct, id: string) {
            super(scope, id);
            new cnpg.Cluster(this, /*...*/);
            new kube.KubeDeployment(this, /*...*/);
            /*...*/
        }
    }
    const app = new App();
    new MyApp(app, "myapp");
    export default app;
    // or use singletonApp()
    // TODO
    ```
  - `renovate.ts`:
    ```ts
    import { appConfig } from "../.dev/renovate-config.ts";
    export default appConfig("myapp");
    ```
  - `versions.ts`:
    ```ts
    export const versions = {
        image: "ghcr.io/kir-dev/myapp:0.0.1@sha256:aaaaaaaaaaaaaa",
    };
    ```
- or `.yaml` files defining Kubernetes resources,
- or a `kustomization.yaml`.
    - You can use
      [`helmCharts:`](https://kubectl.docs.kubernetes.io/references/kustomize/builtins/#_helmchartinflationgenerator_)
      to install Helm charts. Set values either using `valuesInline:` or by creating a `values.yaml` and referencing it
      using `valuesFile:`.

ArgoCD checks each top-level directory except the ones starting with a `.`. If it sees `kustomization.yaml`, it
`kubectl apply --kustomize`s it, otherwise it applies `.yaml` files using `kubectl apply`.

> [!IMPORTANT]
> Ensure that every single deployment/pod has CPU/memory/ephemeral-storage requests/limits specified (even for resources created by a Helm chart!).
> Missing it anywhere causes ArgoCD to crash due to a bug with nested vClusters.

## Notes

- Some Helm charts put CRDs into `templates/` instead `crds/` so `includeCRDs: true/false` in `kustomization.yaml` has
  no effect
- Some Helm charts include a schema for `values.yaml`. https://artifacthub.io shows whether there is one.
    - To get code completion, put a
      ```yaml
      # yaml-language-server: $schema=https://.../values.schema.json
      ```
      at the top of the `values.yaml`. Find the `values.schema.json` file in the chart's GitHub repository, then press
      the *Raw* button to get a link.
- Set `resources.{limits,requests}.ephemeral-storage`, as the default (1GiB) uses up too much of our quota.
- Always specify the Postgres image version for CNPG `Cluster`s, otherwise backups can't be restored due to the version
  mismatch
- Don't forget `database`/`owner` fields when restoring a CNPG DB from a backup

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

A snapshot of `vc-kirdev`'s config is in `./.vclusters/vc-kirdev/vcluster.yaml`. It might be outdated and differ from the live config.

`vc2`'s config is `./.vclusters/vc-kirdev/vcluster.yaml`. It is managed by Kir-Dev and is up to date.

The root KSZK cluster has some defaults that can cause problems:
- There is a NetworkPolicy that limits resources to only be reachable inside their own vCluster by default.
  This is needed, otherwise all resources would be reachable from anyone on the dormitory's network.
  This policy is not visible from inside the vCluster.
