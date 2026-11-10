// https://github.com/kir-dev/foodex-web
//
// https://foodex.sch.bme.hu
// https://api.foodex.sch.bme.hu
//
// Spring Boot backend (Postgres via CloudNativePG) + Next.js frontend.
//
// The old `vc-kirdev` deployment used an embedded H2 file. This app replaces
// it with a CNPG cluster; see the FoodEx repo's `migrateH2ToPostgres` Gradle
// task for copying the existing rows over.

import * as kube from "../imports/k8s";
import { createBackblaze, createKirDevApp, SecretKeyRef } from "../.dev/kir-dev-app.ts";
import { versions } from "./versions.ts";

// Per-app Backblaze B2 bucket for the CNPG/Barman database backups.
const b2 = createBackblaze({
    endpoint: "https://s3.eu-central-003.backblazeb2.com",
    region: "eu-central-003",
    bucket: "foodex-backups",
});

const app = createKirDevApp("foodex", {
    namespace: "foodex",
    createNamespace: true,
});

const db = app.addPostgres({
    image: "ghcr.io/cloudnative-pg/postgresql:17.5",
    instances: 1,
    backup: {
        provider: b2.withPrefix("postgres/"),
        schedule: "0 24 3 * * *",
        backblazeCredentialsSecret: "foodex-db-backup-secrets",
    },
});

// AuthSCH credentials are filled in by hand. This keeps the name used by the
// old `vc-kirdev` deployment for familiarity, but secrets do NOT replicate
// between vclusters: the values must be recreated in `vc2`.
new kube.KubeSecret(app.scope, "foodex-backend-secrets", {
    metadata: {
        name: "foodex-backend-secrets",
        annotations: {
            "argocd.argoproj.io/sync-wave": "-25",
            "argocd.argoproj.io/compare-options": "IgnoreExtraneous",
            "kir-dev.hu/required-keys": "FOODEX_AUTHSCH_ID,FOODEX_AUTHSCH_KEY",
        },
    },
});

const authschId = new SecretKeyRef("foodex-backend-secrets", "FOODEX_AUTHSCH_ID", "FOODEX_AUTHSCH_ID");
const authschKey = new SecretKeyRef("foodex-backend-secrets", "FOODEX_AUTHSCH_KEY", "FOODEX_AUTHSCH_KEY");

const backend = app.addDocker({
    name: "foodex-backend",
    labels: { app: "foodex-backend", "app.kubernetes.io/name": "foodex-backend" },
    image: versions.backend,
    imagePullPolicy: "Always",
    env: {
        FOODEX_AUTHSCH_ID: authschId,
        FOODEX_AUTHSCH_KEY: authschKey,
        FOODEX_BASEURL: "https://api.foodex.sch.bme.hu/",
        FOODEX_FRONTEND_URL: "https://foodex.sch.bme.hu",
        FOODEX_DATA_SOURCE: db.jdbcUri,
        SPRING_DATASOURCE_USERNAME: db.user,
        SPRING_DATASOURCE_PASSWORD: db.password,
    },
    startupProbe: { path: "/api/homepage", periodSeconds: 5, timeoutSeconds: 3, failureThreshold: 60 },
    readinessProbe: { path: "/api/homepage", periodSeconds: 10, timeoutSeconds: 3, failureThreshold: 3 },
    livenessProbe: { periodSeconds: 20, timeoutSeconds: 3, failureThreshold: 6 },
    resources: {
        limits: {
            cpu: "750m",
            memory: "1Gi",
            "ephemeral-storage": "50Mi",
        },
        requests: {
            cpu: "750m",
            memory: "1Gi",
            "ephemeral-storage": "50Mi",
        },
    },
});

backend.port(8080, "web", 8080).publish("api.foodex.sch.bme.hu", {
    name: "foodex-backend",
    labels: { "app.kubernetes.io/name": "foodex-backend" },
    tlsSecretName: "foodex-backend-api-cert",
});

// NEXT_PUBLIC_API_URL is baked in at build time, but keeping the ConfigMap
// matches the existing deployment.
const frontend = app.addDocker({
    name: "foodex-frontend",
    labels: { app: "foodex-frontend", "app.kubernetes.io/name": "foodex-frontend" },
    image: versions.frontend,
    imagePullPolicy: "Always",
    env: { NEXT_PUBLIC_API_URL: "https://api.foodex.sch.bme.hu" },
    startupProbe: { path: "/", periodSeconds: 5, timeoutSeconds: 3, failureThreshold: 30 },
    readinessProbe: { path: "/", periodSeconds: 10, timeoutSeconds: 3, failureThreshold: 3 },
    livenessProbe: { periodSeconds: 20, timeoutSeconds: 3, failureThreshold: 6 },
    resources: {
        limits: {
            cpu: "1",
            memory: "500Mi",
            "ephemeral-storage": "200Mi",
        },
        requests: {
            cpu: "1",
            memory: "500Mi",
            "ephemeral-storage": "0",
        },
    },
});

frontend.port(3000, "web", 3000).publish("foodex.sch.bme.hu", {
    name: "foodex-frontend",
    labels: { "app.kubernetes.io/name": "foodex" },
    tlsSecretName: "foodex-frontend-cert",
});

export default app.build();
