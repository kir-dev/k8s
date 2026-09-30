export const environment: "Development" | "Production" = (() => {
    const e = process.env.KIRDEV_ENVIRONMENT;
    if (e == "Development" || e == "Production") return e;
    if (!e) return "Production";
    throw new Error("Invalid KIRDEV_ENVIRONMENT.");
})();

export const k8sRepoUrl =
    process.env.KIRDEV_K8S_REPO_URL ??
    (() => {
        if (environment == "Development") {
            return `git://git-server.argocd.svc.cluster.local:9418/k8s.git`;
        }
        return "https://github.com/kir-dev/k8s.git";
    })();

export const k8sRepoRevision = process.env.KIRDEV_K8S_REPO_REVISION;
