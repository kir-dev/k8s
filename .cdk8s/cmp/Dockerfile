# ArgoCD Config Management Plugin sidecar that renders cdk8s Applications.
#
# The heavy `cdk8s import` runs once here, baking the generated TypeScript
# types into the image. At sync time the plugin only has to run `cdk8s synth`
# (fast), so nothing is committed to git and nothing is generated in-cluster
# except the manifests ArgoCD applies.
#
# Build with the repository root as the build context, e.g.:
#   docker build -f .cdk8s/cmp/Dockerfile -t cdk8s-cmp .

FROM oven/bun:1-debian

# helm is required by `cdk8s import` to fetch the helm:... imports in cdk8s.yaml.
ARG HELM_VERSION=v3.18.3
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && curl -fsSL "https://get.helm.sh/helm-${HELM_VERSION}-linux-amd64.tar.gz" \
    | tar xz -C /usr/local/bin --strip-components=1 linux-amd64/helm \
 && apt-get purge -y curl \
 && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/cdk8s

# cdk8s toolchain + runtime deps, baked into the image (no node_modules in git).
COPY .cdk8s/cmp/package.json ./
RUN bun install

# Bake the generated import types (the "bloat" that would otherwise go in git).
# The root cdk8s.yaml is the union of imports used by every Application.
COPY cdk8s.yaml ./
RUN bun run cdk8s import && rm -f cdk8s.yaml

# Plugin entrypoint + ArgoCD plugin config.
COPY .cdk8s/cmp/generate.sh ./
COPY .cdk8s/cmp/plugin.yaml /home/argocd/cmp-server/config/plugin.yaml
RUN chmod +x generate.sh

# Repo-server runs as uid 999 and executes the plugin as that user.
USER 999
WORKDIR /home/argocd
