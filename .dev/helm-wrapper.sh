#!/usr/bin/env bash
# cdk8s's Helm construct only reads stdout, but Helm 4 prints its OCI pull
# progress ("Pulled: ..." / "Digest: ...") to stdout, which cdk8s then tries to
# parse as YAML and chokes on. Strip those lines; Helm 3 prints them to stderr
# so this is a no-op there.
set -o pipefail
helm "$@" | sed -e '/^Pulled: /d' -e '/^Digest: /d'
