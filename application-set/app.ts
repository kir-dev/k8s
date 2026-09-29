import { ApplicationSet } from "../imports/argoproj.io";
import * as environment from "../.dev/environment.ts";
import { singletonApp } from "../.dev/cdk8s-utils.ts";

export default singletonApp({ namespace: "argocd" }, (scope) => {
    new ApplicationSet(scope, "application-set", {
        metadata: {
            name: "application-set",
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
                            // TODO: undo before merge to prod!!!!!!!!!!!!!!!!!!!
                            {path: "sprint-review-ha5kfu", exclude: true},
                            {path: "place", exclude: true},
                        ],
                    },
                },
            ],
            template: {
                metadata: {
                    name: "{{.path.basename}}",
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
                    syncPolicy: {
                        automated: {
                            prune: true,
                            selfHeal: true,
                        },
                        syncOptions: ["ServerSideApply=true", "CreateNamespace=true"],
                    },
                },
            },
        },
    });
});
