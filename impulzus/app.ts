// https://github.com/kir-dev/impulzus
//
// https://impulzus.com
//
// The Impulzus Next.js app runs on Vercel; only its Postgres database lives
// here. The database is published on a fixed public IP because Vercel reaches
// it over the internet.

import { isProduction } from "../.dev/environment.ts";
import { createBackblaze, createKirDevApp } from "../.dev/kir-dev-app.ts";

// Database backups live in their own Backblaze B2 bucket. The credentials are
// filled in manually in the generated `impulzus-backups-secrets` Secret
// (ACCESS_KEY_ID / ACCESS_SECRET_KEY).
const b2 = createBackblaze("impulzus-backups");

const app = createKirDevApp("impulzus");

app.addPostgres({
    image: "ghcr.io/cloudnative-pg/postgresql:18.6-standard-trixie",
    // Keep the size of the old standalone PVC so the logical dump fits.
    size: "2Gi",
    backup: isProduction
        ? {
              provider: b2.withPrefix("postgres/"),
              schedule: "0 24 3 * * *",
              backblazeCredentialsSecret: "impulzus-backups-secrets",
          }
        : false,
}).publish({
    port: 8085,
    ip: "152.66.192.36",
    sharingKey: "kir-sharing-key",
});

export default app.build();
