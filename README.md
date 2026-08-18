
TODO: Update README

# Kir-Dev Kubernetes configuration

## Bootstrapping

Install
[kubectl](https://kubernetes.io/docs/tasks/tools/#kubectl),
[k3d](https://k3d.io), and
the [vCluster CLI](https://www.vcluster.com/install)
(`nix-shell -p kubectl k3d vcluster` if you have Nix),
then:

```bash
# Create a cluster
k3d cluster create mycluster --image rancher/k3s:v1.35.0-k3s1

git clone https://github.com/kir-dev/k8s
cd k8s

# Create nested vClusters
# Outer vCluster, should be identical to vc-kirdev
vcluster create vc1 -n vc1 -f .vclusters/vc1/vcluster.yaml
# Inner vCluster with workarounds for nested vCluster stuff.
# ⚠️ Comment out the memory-ssd section in .vclusters/vc2/vcluster.yaml when deploying locally
vcluster create vc2 -n vc2 -f .vclusters/vc2/vcluster.yaml

# Install ArgoCD
kubectl kustomize --enable-helm argocd/ | kubectl apply -f -

# Install an ArgoCD ApplicationSet for this repository
kubectl apply -f application-set/
```

## Adding a new app

Create a new directory containing
- `.yaml` files defining Kubernetes resources, or
- a `kustomization.yaml`.
  - You can use
    [`helmCharts:`](https://kubectl.docs.kubernetes.io/references/kustomize/builtins/#_helmchartinflationgenerator_)
    to install Helm charts. Set values either using `valuesInline:` or by creating a `values.yaml` and
    referencing it using `valuesFile:`.

ArgoCD checks each directory (except the ones starting with a `.`). If it sees `kustomization.yaml`, it `kubectl apply --kustomize`s it, otherwise it applies
`.yaml` files using `kubectl apply`.

## cdk8s apps

Apps written in [cdk8s](https://cdk8s.io) are just a directory containing a `cdk8s.yaml` (optional) and an
`app.ts`/`main.ts` entry point, e.g.:

```
my-app/
├── cdk8s.yaml     # optional: which imports this app needs
└── app.ts          # defines the cdk8s App / Charts
```

The generated `imports/` and `node_modules/` are **not** committed to git. Instead they are baked into the
ArgoCD [Config Management Plugin](https://argo-cd.readthedocs.io/en/stable/operator-manual/config-management-plugins/)
sidecar image (`.cdk8s/cmp/`), which renders manifests in-cluster on every sync. Nothing generated is committed —
`cdk8s import` (the slow, bloat-producing step) runs only at image build time.

### Adding a cdk8s app

1. Create a top-level directory with an `app.ts` that imports from `./imports/...`.
2. If it uses imports not already covered by the root `cdk8s.yaml` (the union baked into the image), add them
   there, then rebuild the plugin image (or run `cdk8s import` locally to check the types exist).

The ArgoCD `ApplicationSet` scans top-level directories, so a cdk8s directory is picked up automatically —
discovery matches directories containing `app.ts`/`main.ts`.

### Rebuilding the plugin image

`cdk8s import` regenerates `imports/` from `cdk8s.yaml`; bumping a version there means the image must be rebuilt
so the baked types match. This happens automatically via
[`.github/workflows/cdk8s-cmp.yml`](.github/workflows/cdk8s-cmp.yml) on pushes touching `cdk8s.yaml` — e.g. after a
Renovate bump PR merges.

## Documentation

- https://kubectl.docs.kubernetes.io/references/kustomize/kustomization/
- ArgoCD `Application` reference: https://argo-cd.readthedocs.io/en/stable/user-guide/application-specification/
- Manage Argo CD Using Argo CD:
  https://argo-cd.readthedocs.io/en/stable/operator-manual/declarative-setup/#manage-argo-cd-using-argo-cd
- Kustomization file documentation: https://kubectl.docs.kubernetes.io/references/kustomize/kustomization/

## Notes

- Some Helm charts put CRDs into `templates/` instead `crds/` so `includeCRDs: true/false` in `kustomization.yaml` has
  no effect
- Some Helm charts include a schema for `values.yaml`. https://artifacthub.io shows whether there is one.
    - To get code completion, put a
      ```yaml
      # yaml-language-server: $schema=https://.../values.schema.json
      ```
      at the top of the `values.yaml`. Find the `values.schema.json` file in the chart's GitHub repository,
      then press the *Raw* button to get a link.
- Set `resources.{limits,requests}.ephemeral-storage`, as the default (1GiB) uses more than allowed by the quota
  (especially for the limit)
- Always specify the Postgres image version for CNPG `Cluster`s, otherwise backups can't be restored
  due to the version mismatch
- Don't forget `database`/`owner` fields when restoring a CNPG DB from a backup