#!/bin/sh
# CMP generate entrypoint for cdk8s Applications.
# ArgoCD runs this in the Application source directory. It must print the
# rendered Kubernetes manifests to stdout (logs go to stderr).
set -o pipefail

export PATH="/opt/cdk8s/node_modules/.bin:$PATH"

# Pick the cdk8s app entry point. `cdk8s synth` requires an explicit `--app`.
entry=""
for f in app.ts main.ts; do
  [ -f "$f" ] && entry="$f" && break
done
if [ -z "$entry" ]; then
  echo "cdk8s: no app.ts or main.ts found in $(pwd)" >&2
  exit 1
fi

# Render manifests. bun runs .ts natively (no ts-node needed).
# Logs to stderr; only the manifests end up on stdout.
cdk8s synth --output .generated --app "bun $entry" >&2 || exit $?

# Emit the manifests to stdout for ArgoCD.
if ! find .generated -name '*.k8s.yaml' -exec cat {} +; then
  echo "cdk8s: no manifests synthesized in .generated/" >&2
  exit 1
fi
