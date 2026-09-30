import type { AllConfig } from "renovate/dist/config/types";

export interface RenovateAppOptions {
    /** Repository that holds the ArgoCD Applications. */
    repository?: string;
    /** Bot identity used for commits/PRs. */
    gitAuthor?: string;
}

// Renovate config that configures it to only look for Docker image references in the specified app's versions.ts
// in the specified repo, then to open/update a GitHub PR.
export function appConfig(app: string, options: RenovateAppOptions = {}): AllConfig {
    const repository = options.repository ?? "kir-dev/k8s";
    const gitAuthor = options.gitAuthor ?? "Kir-Dev Bot <258595904+kir-dev-bot@users.noreply.github.com>";

    return {
        platform: "github",
        onboarding: false,
        requireConfig: "optional",
        gitAuthor,
        token: process.env.RENOVATE_TOKEN,
        repositories: [
            {
                repository,
                enabledManagers: ["custom.regex"],
                customManagers: [
                    {
                        customType: "regex",
                        managerFilePatterns: [`/^${app}\\/versions\\.ts$/`],
                        matchStrings: [
                            // docker image ref looking strings surrounded by "", examples:
                            // nginx:1.21.6
                            // node:18-alpine@sha256:d48d085dfb2c8a2b535d4d3d191afdbff8efd23be578bc40bfed5242d50e82be
                            // ghcr.io/username/repo:v1.0.0
                            `['"](?<depName>[^@'"\\s]+):(?<currentValue>[^@'"\\s]+)(?:@(?<currentDigest>sha256:[a-f0-9]{64}))?['"]`,
                        ],
                        datasourceTemplate: "docker",
                        versioningTemplate: "docker",
                    },
                ],
                packageRules: [
                    {
                        matchManagers: ["custom.regex"],
                        groupName: `${app} images`,
                        pinDigests: true,
                    },
                ],
            },
        ],
    };
}
