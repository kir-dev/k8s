// https://github.com/GRA0007/crab.fit
//
// https://fit.kir-dev.hu
//
// Self-hosted instance of Crab Fit (Rust API + Next.js frontend + Postgres).
// The frontend can connect to the viewer's own Google Calendar, which is why
// the Kir-Dev instance runs its own frontend and API instead of using
// crab.fit directly.
//
// Images are built from the `Kir-Dev` fork:
// https://github.com/albi005/crab.fit (public fork of GRA0007/crab.fit).
//
// The frontend image bakes `NEXT_PUBLIC_API_URL` and the optional Google
// Calendar client id/API key in at build time. To enable Google Calendar
// sync, create an OAuth web client and API key for https://fit.kir-dev.hu,
// then set the `GOOGLE_CLIENT_ID` / `GOOGLE_API_KEY` repository variables in
// the fork and rerun its "Build images" workflow.

import * as environment from "../.dev/environment.ts";
import { createBackblaze, createKirDevApp, manualSecret } from "../.dev/kir-dev-app.ts";
import { versions } from "./versions.ts";

const production = environment.environment == "Production";

const b2 = createBackblaze({
    endpoint: "https://s3.eu-central-003.backblazeb2.com",
    region: "eu-central-003",
    bucket: "crabfit-backups",
});

const app = createKirDevApp("crabfit", {
    namespace: "crabfit",
    createNamespace: true,
});

const db = app.addPostgres({
    image: "ghcr.io/cloudnative-pg/postgresql:18.6-standard-trixie",
    size: "2Gi",
    backup: production
        ? {
              provider: b2.withPrefix("postgres/"),
              schedule: "0 32 3 * * *",
              backblazeCredentialsSecret: "crabfit-backups-secrets",
          }
        : false,
});

// Rust API. `DATABASE_URL` comes from the CNPG-generated app Secret; the API
// runs its SeaORM migrations on startup.
const api = app.addDocker({
    name: "api",
    image: versions.api,
    imagePullPolicy: "Always",
    env: {
        FRONTEND_URL: "https://fit.kir-dev.hu",
        DATABASE_URL: db.uri,
        // Set manually in `${app}-secrets` to protect /tasks/cleanup.
        CRON_KEY: manualSecret({ optional: true }),
    },
    startupProbe: { path: "/", periodSeconds: 5, timeoutSeconds: 3, failureThreshold: 60 },
    readinessProbe: { path: "/", periodSeconds: 10, timeoutSeconds: 3, failureThreshold: 3 },
    livenessProbe: { periodSeconds: 20, timeoutSeconds: 3, failureThreshold: 6 },
    resources: {
        limits: { cpu: "500m", memory: "256Mi", "ephemeral-storage": "200Mi" },
        requests: { cpu: "50m", memory: "64Mi", "ephemeral-storage": "0" },
    },
});

api.port(3000).publish("api.fit.kir-dev.hu", { name: "crabfit-api" });

// Next.js frontend. All NEXT_PUBLIC_* configuration is baked into the image.
app.addDocker({
    name: "web",
    image: versions.frontend,
    imagePullPolicy: "Always",
    startupProbe: { path: "/", periodSeconds: 5, timeoutSeconds: 3, failureThreshold: 60 },
    readinessProbe: { path: "/", periodSeconds: 10, timeoutSeconds: 3, failureThreshold: 3 },
    livenessProbe: { periodSeconds: 20, timeoutSeconds: 3, failureThreshold: 6 },
    resources: {
        limits: { cpu: "500m", memory: "512Mi", "ephemeral-storage": "200Mi" },
        requests: { cpu: "50m", memory: "128Mi", "ephemeral-storage": "0" },
    },
}).port(3000).publish("fit.kir-dev.hu", { name: "crabfit-web" });

export default app.build();
