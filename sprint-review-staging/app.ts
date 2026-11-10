// https://github.com/kir-dev/sprint-review-app-v2
//
// Staging instance: https://sprint-review-staging.kir-dev.hu
//
// Next.js frontend + NestJS backend (Prisma/Postgres). The images are public
// ghcr.io packages so no registry pull Secret is needed.

import * as kube from "../imports/k8s";
import { createKirDevApp, manualSecret } from "../.dev/kir-dev-app.ts";
import { versions } from "./versions.ts";

const backendHost = "api.sprint-review-staging.kir-dev.hu";
const frontendHost = "sprint-review-staging.kir-dev.hu";

const app = createKirDevApp("sprint-review-staging", {
    namespace: "sprint-review-staging",
    createNamespace: true,
});

const db = app.addPostgres({
    image: "ghcr.io/cloudnative-pg/postgresql:17.5",
    backup: false,
});

// Distinct labels per workload: the builder defaults every workload to the
// app's labels, which would make the frontend and backend Service selectors
// overlap.
const labels = (component: string) => ({
    "app.kubernetes.io/name": `sprint-review-${component}`,
    "app.kubernetes.io/instance": "sprint-review-staging",
    "app.kubernetes.io/component": component,
    "app.kubernetes.io/part-of": "sprint-review-staging",
});

const backend = app.addDocker({
    image: versions.backend,
    name: "sprint-review-staging-backend",
    containerName: "backend",
    labels: labels("backend"),
    env: {
        NODE_ENV: "production",
        PORT: "3001",
        DATABASE_URL: db.uri,
        AUTHSCH_CLIENT_ID: manualSecret(),
        AUTHSCH_CLIENT_SECRET: manualSecret(),
        JWT_SECRET: manualSecret(),
        SESSION_SECRET: manualSecret(),
        FRONTEND_URL: `https://${frontendHost}`,
        BACKEND_PUBLIC_URL: `https://${backendHost}`,
        ENABLE_SWAGGER: "false",
    },
    startupProbe: { path: "/health/live", periodSeconds: 2, failureThreshold: 30 },
    readinessProbe: { path: "/health/ready", periodSeconds: 10, timeoutSeconds: 3, failureThreshold: 3 },
    livenessProbe: { periodSeconds: 20, timeoutSeconds: 3, failureThreshold: 6 },
    resources: {
        requests: { cpu: "100m", memory: "128Mi", "ephemeral-storage": "50Mi" },
        limits: { cpu: "150m", memory: "192Mi", "ephemeral-storage": "50Mi" },
    },
});

// Only AuthSCH's redirect endpoints are published directly; regular API calls
// go through the frontend's same-origin `/api/*` proxy.
backend.port(3001, "http", 3001).publish(backendHost, {
    name: "sprint-review-staging-backend",
    paths: [
        { path: "/auth/login", pathType: "Exact" },
        { path: "/auth/callback", pathType: "Exact" },
    ],
});

const frontend = app.addDocker({
    image: versions.frontend,
    name: "sprint-review-staging-frontend",
    containerName: "frontend",
    labels: labels("frontend"),
    env: {
        BACKEND_INTERNAL_URL: "http://sprint-review-staging-backend:3001",
        BACKEND_PUBLIC_URL: `https://${backendHost}`,
    },
    startupProbe: { path: "/healthz", periodSeconds: 2, failureThreshold: 30 },
    readinessProbe: { path: "/healthz", periodSeconds: 10, timeoutSeconds: 3, failureThreshold: 3 },
    livenessProbe: { periodSeconds: 20, timeoutSeconds: 3, failureThreshold: 6 },
    resources: {
        requests: { cpu: "25m", memory: "96Mi", "ephemeral-storage": "20Mi" },
        limits: { cpu: "150m", memory: "192Mi", "ephemeral-storage": "50Mi" },
    },
});

frontend.port(3000).publish(frontendHost, { name: "sprint-review-staging-frontend" });

// Prisma migrations. A blocking `Sync` hook with a negative wave (rather than a
// `PreSync` hook) is intentional: the CNPG cluster is provisioned by this same
// Application, so a `PreSync` Job would deadlock on the first sync. The backend
// Deployment cannot roll out until this Job succeeds.
const quantities = (spec: Record<string, string>) =>
    Object.fromEntries(Object.entries(spec).map(([key, value]) => [key, kube.Quantity.fromString(value)]));

const podSecurityContext: kube.PodSecurityContext = {
    runAsNonRoot: true,
    runAsUser: 1000,
    runAsGroup: 1000,
    fsGroup: 1000,
    seccompProfile: { type: "RuntimeDefault" },
};

const containerSecurityContext: kube.SecurityContext = {
    allowPrivilegeEscalation: false,
    capabilities: { drop: ["ALL"] },
    readOnlyRootFilesystem: true,
};

new kube.KubeJob(app.scope, "sprint-review-staging-migrate", {
    metadata: {
        name: "sprint-review-staging-migrate",
        labels: labels("backend"),
        annotations: {
            "argocd.argoproj.io/hook": "Sync",
            "argocd.argoproj.io/hook-delete-policy": "BeforeHookCreation,HookSucceeded",
            "argocd.argoproj.io/sync-wave": "-10",
        },
    },
    spec: {
        backoffLimit: 1,
        activeDeadlineSeconds: 300,
        template: {
            metadata: { labels: labels("backend") },
            spec: {
                restartPolicy: "Never",
                automountServiceAccountToken: false,
                securityContext: podSecurityContext,
                initContainers: [
                    {
                        name: "wait-for-database",
                        image: "ghcr.io/cloudnative-pg/postgresql:17.5",
                        imagePullPolicy: "IfNotPresent",
                        command: ["/bin/sh", "-ec"],
                        args: [`until pg_isready -h ${db.clusterName}-rw -p 5432 -U postgres; do sleep 2; done`],
                        resources: {
                            requests: quantities({ cpu: "10m", memory: "16Mi", "ephemeral-storage": "5Mi" }),
                            limits: quantities({ cpu: "50m", memory: "32Mi", "ephemeral-storage": "20Mi" }),
                        },
                        securityContext: containerSecurityContext,
                    },
                ],
                containers: [
                    {
                        name: "migrate",
                        // Kustomize/versions.ts applies the same tag as the backend Deployment.
                        image: versions.backend,
                        imagePullPolicy: "IfNotPresent",
                        command: ["yarn"],
                        args: ["workspace", "backend", "prisma:migrate:deploy"],
                        env: [
                            { name: "NODE_ENV", value: "production" },
                            {
                                name: "DATABASE_URL",
                                valueFrom: { secretKeyRef: { name: db.secretName, key: "uri" } },
                            },
                        ],
                        resources: {
                            requests: quantities({ cpu: "50m", memory: "128Mi", "ephemeral-storage": "20Mi" }),
                            limits: quantities({ cpu: "250m", memory: "256Mi", "ephemeral-storage": "100Mi" }),
                        },
                        securityContext: containerSecurityContext,
                        volumeMounts: [{ name: "tmp", mountPath: "/tmp" }],
                    },
                ],
                volumes: [{ name: "tmp", emptyDir: {} }],
            },
        },
    },
});

export default app.build();
