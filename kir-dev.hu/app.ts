// https://github.com/kir-dev/kir-dev.hu
//
// https://kir-dev.hu
//
// Next.js + Payload CMS (Postgres + Garage S3) application.
// Kubernetes resources use `kir-dev-hu` because RFC 1035/1123 DNS labels
// (Namespaces, Services, CNPG/Garage clusters) and Postgres identifiers
// cannot contain dots.

import * as traefik from "../imports/traefik.io.ts";
import * as environment from "../.dev/environment.ts";
import { createBackblaze, createKirDevApp, manualSecret } from "../.dev/kir-dev-app.ts";
import { versions } from "./versions.ts";

const production = environment.environment == "Production";

// Per-app Backblaze B2 bucket, shared by the CNPG/Barman DB backups
// (`postgres/` prefix) and the VolSync/restic Garage-volume backups
// (`restic/` prefix).
const b2 = createBackblaze({
    endpoint: "https://s3.eu-central-003.backblazeb2.com",
    region: "eu-central-003",
    bucket: production ? "kir-dev-hu-backups" : "kir-dev-hu-test",
});

const app = createKirDevApp("kir-dev-hu", {
    namespace: "kir-dev-hu",
    createNamespace: true,
});

const db = app.addPostgres({
    image: "ghcr.io/cloudnative-pg/postgresql:17.5",
    backup: production
        ? {
              provider: b2.withPrefix("postgres/"),
              schedule: "0 20 3 * * *",
              backblazeCredentialsSecret: "kir-dev-hu-backups-secrets",
          }
        : false,
});

const s3 = app.addGarage({
    buckets: ["kir-dev-hu-media"],
    backup: production
        ? {
              provider: b2.withPrefix("restic/"),
              schedule: "40 3 * * *",
          }
        : false,
});

const server = app.addDocker({
    image: versions.image,
    env: {
        NODE_ENV: "production",
        NEXT_TELEMETRY_DISABLED: "1",
        NEXT_PUBLIC_SITE_URL: "https://kir-dev.hu",
        S3_ENDPOINT: s3.endpoint,
        S3_BUCKET: s3.bucket,
        S3_REGION: s3.region,
        S3_ACCESS_KEY_ID: s3.accessKeyId,
        S3_SECRET_ACCESS_KEY: s3.secretAccessKey,
        DATABASE_URI: db.uri,
        // Set manually in production (`kir-dev-hu-secrets`):
        //   PAYLOAD_SECRET:
        //   NEXT_PUBLIC_PLAUSIBLE_URL: (optional)
        PAYLOAD_SECRET: production ? manualSecret() : "local-development-secret",
        NEXT_PUBLIC_PLAUSIBLE_URL: manualSecret({ optional: true }),
    },
    // Hit a Payload route so Payload's initialization (including
    // `prodMigrations`) completes before the pod reports Ready.
    startupProbe: { path: "/admin", periodSeconds: 5, timeoutSeconds: 3, failureThreshold: 60 },
    readinessProbe: { path: "/admin", periodSeconds: 10, timeoutSeconds: 3, failureThreshold: 3 },
    livenessProbe: { periodSeconds: 20, timeoutSeconds: 3, failureThreshold: 6 },
});

const http = server.port(3000);
http.publish("kir-dev.hu");

// Permanent redirects from alias domains to `https://kir-dev.hu`.
// Each alias has its own Ingress + TLS secret so cert-manager issues its
// certificate independently of the primary `kir-dev.hu` certificate.
new traefik.Middleware(app.scope, "redirect-to-apex", {
    metadata: { name: "redirect-to-apex", labels: app.labels },
    spec: {
        redirectRegex: {
            regex: "^https?://(?:www\\.kir-dev\\.hu|kir-dev\\.sch\\.bme\\.hu)(?::\\d+)?(.*)",
            replacement: "https://kir-dev.hu${1}",
            permanent: true,
        },
    },
});

http.publish("www.kir-dev.hu", {
    name: "kir-dev-hu-www",
    middlewares: ["kir-dev-hu-redirect-to-apex@kubernetescrd"],
});
http.publish("kir-dev.sch.bme.hu", {
    name: "kir-dev-hu-sch-bme-hu",
    middlewares: ["kir-dev-hu-redirect-to-apex@kubernetescrd"],
});

export default app.build();
