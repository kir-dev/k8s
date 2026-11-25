import { $ } from "bun";
import { check, confirm, text } from "./shell-utils.ts";
import { kubectlApplyCdk8sApp } from "./kubectl-utils.ts";

const ctx = await text($`kubectl config current-context`);
if (ctx !== "vc-kirdev") {
    console.error(`✗ expected kubectl context "vc-kirdev", got "${ctx}"`);
    console.error("  Switch to the vc-kirdev context before bootstrapping production.");
    process.exit(1);
}

if (!(await confirm(`Bootstrap vc2, Argo CD, and ApplicationSet in "${ctx}"?`))) {
    process.exit(1);
}

await check($`bun run cdk8s:import`, "cdk8s:import");
await check($`vcluster create vc2 -n vc2 -f .vclusters/vc2/vcluster.yaml`, "vcluster create vc2");
await check($`kubectl kustomize --enable-helm argocd/ | kubectl apply --server-side -f -`, "install Argo CD");
await check(
    $`kubectl wait --for=condition=Established --timeout=180s crd/applications.argoproj.io crd/applicationsets.argoproj.io`,
    "wait for Argo CD CRDs",
);

// Dynamic import so `cdk8s:import` can generate `imports/` before loading the app.
const { default: applicationSet } = await import("../application-set/app.ts");
await kubectlApplyCdk8sApp(applicationSet, { serverSide: true });
