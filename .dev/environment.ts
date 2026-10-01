const PRODUCTION_REPO_URL = "https://github.com/kir-dev/k8s";

// Set env based on ARGOCD env vars
// https://argo-cd.readthedocs.io/en/stable/user-guide/build-environment/
export const k8sRepoUrl = process.env.ARGOCD_APP_SOURCE_REPO_URL ?? PRODUCTION_REPO_URL;

export const environment: "Development" | "Production" = ((k8sRepoUrl === PRODUCTION_REPO_URL) || (k8sRepoUrl === PRODUCTION_REPO_URL + ".git"))
    ? "Production"
    : "Development";

export const k8sRepoRevision = process.env.ARGOCD_APP_SOURCE_TARGET_REVISION || undefined;
