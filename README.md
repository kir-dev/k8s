
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
- a cdk8s app: a `cdk8s.yaml` + `app.ts` (see below).

ArgoCD checks each directory (except the ones starting with a `.`). If it sees `kustomization.yaml`, it `kubectl apply --kustomize`s it, otherwise it applies
`.yaml` files using `kubectl apply`.

### cdk8s apps

Directories containing an `app.ts` are synthesized with cdk8s by an ArgoCD
[Config Management Plugin](https://argo-cd.readthedocs.io/en/stable/operator-manual/config-management-plugins/)
(sidecar on the repo-server, see `argocd/kustomization.yaml`). There is a single
cdk8s project for the whole repo: the shared `cdk8s.yaml` (imports) and
`package.json` (deps) live at the top level, and each cdk8s app is just a
directory with an `app.ts`:

```
<repo root>/
  cdk8s.yaml        # language: typescript + imports (shared)
  package.json      # deps: cdk8s, constructs; devDeps: cdk8s-cli (shared)
  imports/          # generated (gitignored)
  my-app/
    app.ts          # the cdk8s app entrypoint (Chart(s) + app.synth())
```

`app.ts` imports from `../imports/k8s`. The CMP runs from the repo root:
`bun install`, `cdk8s import`, then synthesizes *only that app's* `app.ts` into a
per-app `dist/<app>/` and feeds `dist/<app>/*.k8s.yaml` to ArgoCD. The sidecar
image is `nixery.dev/bun/kubernetes-helm/bash/coreutils/cacert/nodejs` (nixery
bundles `bun`, `helm`, `node`, and a shell). See `demo/` for a minimal example.

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