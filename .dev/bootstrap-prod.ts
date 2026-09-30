import { $ } from "bun";
import { kubectlApplyCdk8sApp } from "./kubectl-utils.ts";
import applicationSet from "../application-set/app.ts";

await $`bun run cdk8s:import`;
await $`vcluster create vc2 -n vc2 -f .vclusters/vc2/vcluster.yaml`;
await $`kubectl kustomize --enable-helm argocd/ | kubectl apply -f -`;
await kubectlApplyCdk8sApp(applicationSet);
