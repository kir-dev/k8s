# `createKirDevApp` Builder Reference

[`.dev/kir-dev-app.ts`](.dev/kir-dev-app.ts) provides a typed builder for standard Kir-Dev applications deployed with Argo CD and cdk8s.

## Minimal example

```ts
import { isProduction } from "../.dev/environment.ts";
import { createBackblaze, createKirDevApp, manualSecret } from "../.dev/kir-dev-app.ts";
import { versions } from "./versions.ts";

const b2 = createBackblaze("myapp-backups");
const app = createKirDevApp("myapp");

const db = app.addPostgres({
    image: "ghcr.io/cloudnative-pg/postgresql:17.5",
    backup: isProduction
        ? {
              provider: b2.withPrefix("postgres/"),
              schedule: "0 24 3 * * *",
          }
        : false,
});

const s3 = app.addGarage({
    buckets: ["myapp-media"],
    backup: isProduction
        ? {
              provider: b2.withPrefix("restic/"),
              schedule: "45 3 * * *",
          }
        : false,
});

app.addDocker({
    image: versions.image,
    env: {
        NODE_ENV: "production",
        DATABASE_URI: db.uri,
        S3_ENDPOINT: s3.endpoint,
        S3_BUCKET: s3.bucket,
        S3_REGION: s3.region,
        S3_ACCESS_KEY_ID: s3.accessKeyId,
        S3_SECRET_ACCESS_KEY: s3.secretAccessKey,
        APP_SECRET: manualSecret({ optional: !isProduction }),
    },
    startupProbe: { path: "/healthz", failureThreshold: 30 },
    readinessProbe: { path: "/healthz" },
    livenessProbe: { path: "/healthz" },
})
    .port(3000)
    .publish("myapp.kir-dev.hu");

export default app.build();
```

## Components

### `createKirDevApp(name, options?)`

Creates a cdk8s `App`, default `Chart` (`app.scope`), and `Namespace` (`createNamespace: true`, `namespace: name`).

- `syncWaves`: emit `argocd.argoproj.io/sync-wave` annotations (default `true`).
- `labels`: merged into standard `app.kubernetes.io/*` labels.
- Add arbitrary raw cdk8s resources directly to `app.scope`, then call `export default app.build()`.

### `createBackblaze(bucket | options)`

Creates a Backblaze B2 target defaulting to `https://s3.eu-central-003.backblazeb2.com` (`region: "eu-central-003"`). Call `.withPrefix("postgres/")` or `.withPrefix("restic/")` when passing to `addPostgres` / `addGarage`.

### `app.addPostgres(options)`

Creates a CloudNativePG `Cluster` (`<name>-db`, default 2 instances on `node-local-zfs`) with:
- Automatic `podAntiAffinityType: "required"` in Production (`"preferred"` in Development) when `instances > 1`.
- Optional Barman Cloud `ObjectStore`, `ScheduledBackup`, and `<name>-db-backup-secrets` Secret.
- Optional recovery (`restore: "latest"`, requires `backup`).
- Returned `PostgresHandle`: `host`, `port`, `database`, `user`, `password`, `uri`, `jdbcUri`, `dotnetConnectionString()`.
- `db.publish({ port, ip, sharingKey })`: exposes the primary through a `LoadBalancer` Service plus an `allow-postgres` `NetworkPolicy` (for apps hosted outside the cluster, e.g. Vercel).

### `app.addGarage(options)`

Creates a single-node `GarageCluster` (`<name>-garage`), `GarageAdminToken`, `GarageBucket`s, and `GarageKey` (writing S3 credentials into `<name>-garage-s3`).
- Optional VolSync/restic off-site backups and restore lifecycle (`fresh` | `restore` | `restored` — see [backup.md](backup.md)).
- Returned `S3Handle`: `endpoint`, `bucket`, `bucketNames`, `region`, `credentialsSecret`, `accessKeyId`, `secretAccessKey`.

### `app.addDocker(options)`

Creates a `Deployment`, optional `ConfigMap` (`<name>-config` for string `env` values), and `Service` (when `.port(...)` is called).
- `env`: string values go into the ConfigMap; `SecretKeyRef`s (`db.uri`, `s3.accessKeyId`), `manualSecret()`, and `interpolate\`...\`` become container `env` entries.
- `manualSecret({ key?, optional? })`: references `<app>-secrets` and records the key in the Secret's `kir-dev.hu/required-keys` annotation (with `argocd.argoproj.io/compare-options: IgnoreExtraneous`).
- `livenessProbe`: uses HTTP GET when `path` is set, TCP socket when omitted.
- `.port(containerPort, name?, servicePort?)`: registers a container + Service port (first port defaults to name `"http"`, servicePort `80`).
- `.publish(host, options?)`: creates a Traefik `Ingress` with cert-manager `letsencrypt` TLS.
