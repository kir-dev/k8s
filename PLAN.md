we are working on a comprehensive GitOps setup.

the current version uses ArgoCD with each ArgoCD Application stored in a top-level directory in the repo,
as either classic K8s .yaml files or a kustomize.yaml.

i want to add support for cdk8s-based apps, with automatic update PRs using Renovate.
additionally i want to be able to deploy a cluster locally for testing.

## plan

- [x] keep the same top-level setup and add support for cdk8s apps using a `app.ts` file as the entry-point
      (done via an ArgoCD Config Management Plugin sidecar, see `argocd/kustomization.yaml`; sample in `demo/`)
- [ ] the current setup uses some Renovate magic to open PRs from other repositories from GitHub Actions.
  see kir-dev/k8s and kir-dev/StartSCH (both already in ~/src).
  create a script that can be run from the CI/CD pipelines of other repositories that opens an update PR for that specific app.

## rules
- top-level directories other than the ones starting with a `.` are ArgoCD Applications.
  keep non-Application files either in a dir like `.cdk8s` (or something else) or at the top-level.
- use bun. don't add dependencies unless necessary.

## notes
- there is a very basic cdk8s sample in ~/Desktop/f using bun
