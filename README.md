# Kir-Dev Kubernetes configuration

This repo contains our Kubernetes configuration,
deployed following GitOps principles using Argo CD.

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
