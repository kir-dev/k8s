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

import { createBackblaze, createKirDevApp, manualSecret } from "../.dev/kir-dev-app.ts";
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

// AuthSCH credentials are filled in by hand in the generated `foodex-secrets`
// Secret. Secrets do not replicate between vclusters, so they must be created
// again in `vc2`.
const backend = app.addDocker({
    name: "foodex-backend",
    labels: { ...app.labels, "app.kubernetes.io/component": "backend" },
    image: versions.backend,
    imagePullPolicy: "Always",
    env: {
        FOODEX_AUTHSCH_ID: manualSecret(),
        FOODEX_AUTHSCH_KEY: manualSecret(),
        FOODEX_BASEURL: "https://api.foodex.sch.bme.hu/",
        FOODEX_FRONTEND_URL: "https://foodex.sch.bme.hu",
        FOODEX_DATA_SOURCE: db.jdbcUri,
        SPRING_DATASOURCE_USERNAME: db.user,
        SPRING_DATASOURCE_PASSWORD: db.password,
    },
    startupProbe: { path: "/api/homepage", periodSeconds: 5, timeoutSeconds: 3, failureThreshold: 60 },
    readinessProbe: { path: "/api/homepage", periodSeconds: 10, timeoutSeconds: 3, failureThreshold: 3 },
    livenessProbe: { periodSeconds: 20, timeoutSeconds: 3, failureThreshold: 6 },
});

backend.port(8080).publish("api.foodex.sch.bme.hu", { name: "foodex-backend" });

const frontend = app.addDocker({
    name: "foodex-frontend",
    labels: { ...app.labels, "app.kubernetes.io/component": "frontend" },
    image: versions.frontend,
    imagePullPolicy: "Always",
    startupProbe: { path: "/", periodSeconds: 5, timeoutSeconds: 3, failureThreshold: 30 },
    readinessProbe: { path: "/", periodSeconds: 10, timeoutSeconds: 3, failureThreshold: 3 },
    livenessProbe: { periodSeconds: 20, timeoutSeconds: 3, failureThreshold: 6 },
});

frontend.port(3000).publish("foodex.sch.bme.hu", { name: "foodex-frontend" });

export default app.build();
