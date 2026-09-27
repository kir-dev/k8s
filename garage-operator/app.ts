// https://rajsinghtech.github.io/garage-operator/
// https://github.com/rajsinghtech/garage-operator
//
// Garage is the self-hosted S3-compatible object storage used by `ehk`.

import { resolve } from "node:path";
import { App, Chart } from "cdk8s";
import { KubeNamespace } from "../imports/k8s";
import { Garageoperator } from "../imports/garage-operator.ts";

const app = new App();

const namespaceChart = new Chart(app, "namespace");
new KubeNamespace(namespaceChart, "namespace", { metadata: { name: "garage-operator" } });

// Note: no Chart namespace. The Helm construct already namespaces the chart's
// own resources (`--namespace garage-operator`), and a Chart namespace would
// additionally be stamped onto cluster-scoped objects (CRDs, ClusterRoles,
// webhooks), which Kubernetes rejects.
const chart = new Chart(app, "chart");
new Garageoperator(chart, "garage-operator", {
    namespace: "garage-operator",
    releaseName: "garage-operator",
    // Helm 4 prints its OCI pull progress to stdout, which cdk8s can't parse;
    // the wrapper strips it and is a no-op on Helm 3. (Absolute so it works
    // regardless of the synth's working directory.)
    helmExecutable: resolve(import.meta.dir, "..", ".dev/helm-wrapper.sh"),
    // The chart keeps its CRDs in `crds/`, which `helm template` omits unless
    // asked for. Without `--include-crds` the `Garage*` resources in the `ehk`
    // app would have no CRDs to apply against.
    helmFlags: ["--include-crds"],
    values: {
        // The operator enables admission/conversion webhooks by default and
        // uses the cert-manager already installed in this repo for their
        // serving certificates.
        webhooks: {
            enabled: true,
            certManager: { enabled: true },
        },
        resources: {
            requests: {
                cpu: "50m",
                memory: "128Mi",
                "ephemeral-storage": "0",
            },
            limits: {
                cpu: "500m",
                memory: "256Mi",
                "ephemeral-storage": "200Mi",
            },
        },
    },
});

export default app;
