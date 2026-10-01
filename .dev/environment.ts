export const KIRDEV_K8S_ENVIRONMENT = "KIRDEV_K8S_ENVIRONMENT";
export const KIRDEV_K8S_REPO_URL = "KIRDEV_K8S_REPO_URL";
export const KIRDEV_K8S_REPO_REVISION = "KIRDEV_K8S_REPO_REVISION";

// Argo CD prefixes env vars from `spec.source.plugin.env` with `ARGOCD_ENV_`
// before invoking the CMP, while local scripts export them unprefixed.
// https://argo-cd.readthedocs.io/en/stable/operator-manual/config-management-plugins/#using-environment-variables-in-your-plugin
function readEnv(name: string): string | undefined {
    return process.env[name] ?? process.env[`ARGOCD_ENV_${name}`];
}

export const environment: "Development" | "Production" = (() => {
    const e = readEnv(KIRDEV_K8S_ENVIRONMENT);
    if (e == "Development" || e == "Production") return e;
    if (!e) return "Production";
    throw new Error(`Invalid ${KIRDEV_K8S_ENVIRONMENT}.`);
})();

export const k8sRepoUrl =
    readEnv(KIRDEV_K8S_REPO_URL) ??
    (() => {
        if (environment == "Development") {
            return `git://git-server.argocd.svc.cluster.local:9418/k8s.git`;
        }
        return "https://github.com/kir-dev/k8s.git";
    })();

export const k8sRepoRevision = readEnv(KIRDEV_K8S_REPO_REVISION);
