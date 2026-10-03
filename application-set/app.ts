import { ApplicationSet } from "../imports/argoproj.io";
import * as environment from "../.dev/environment.ts";
import { singletonApp } from "../.dev/cdk8s-utils.ts";

export default singletonApp({ namespace: "argocd" }, (scope) => {
    new ApplicationSet(scope, "application-set", {
        metadata: {
            name: "apps",
        },
        spec: {
            goTemplate: true,
            goTemplateOptions: ["missingkey=error"],
            generators: [
                {
                    git: {
                        repoUrl: environment.k8sRepoUrl,
                        revision: environment.k8sRepoRevision ?? "HEAD",
                        directories: [
                            // include all directories
                            {
                                path: "*",
                            },
                            // exclude .directories
                            {
                                path: ".*",
                                exclude: true,
                            },
                        ],
                    },
                },
            ],
            template: {
                metadata: {
                    name: "{{.path.basename}}",
                    // Delete the resources created by an Application when it's deleted
                    // https://argo-cd.readthedocs.io/en/stable/user-guide/app_deletion/#about-the-deletion-finalizer
                    finalizers: ["resources-finalizer.argocd.argoproj.io"],
                },
                spec: {
                    project: "default",
                    source: {
                        repoUrl: environment.k8sRepoUrl,
                        targetRevision: environment.k8sRepoRevision,
                        path: "{{.path.path}}",
                    },
                    destination: { name: "in-cluster" },
                    // The backup credentials are filled in manually into the
                    // Secret `data`; keep ArgoCD from pruning/reverting them.
                    ignoreDifferences: [
                        {
                            group: "",
                            kind: "Secret",
                            jsonPointers: ["/data"],
                        },
                    ],
                    syncPolicy: {
                        automated: {
                            prune: true,
                            selfHeal: true,
                        },
                        syncOptions: ["ServerSideApply=true", "CreateNamespace=true", "ApplyOutOfSyncOnly=true"],
                    },
                },
            },
        },
    });
});
