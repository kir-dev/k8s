// https://github.com/kir-dev/sch-pincer
//
// https://schpincer.sch.bme.hu
//
// Maintainer: Bácsi Miklós
//
// Migrated from the hand-applied `kir-prod` deployment in `vc-kirdev`.
//
// Spring Boot (Kotlin) app with a CloudNativePG Postgres database. Uploaded
// images (item pictures, circle logos, ...) are files on a persistent volume.
// See README.md.

import * as kube from "../imports/k8s";
import * as traefik from "../imports/traefik.io.ts";
import * as environment from "../.dev/environment.ts";
import { createBackblaze, createKirDevApp, interpolate, manualSecret } from "../.dev/kir-dev-app.ts";
import { versions } from "./versions.ts";

const production = environment.environment == "Production";

// Dedicated bucket: CNPG/Barman DB backups under `postgres/`, VolSync/restic
// backups of the uploads volume under `restic/`.
const b2 = createBackblaze({
    endpoint: "https://s3.eu-central-003.backblazeb2.com",
    region: "eu-central-003",
    bucket: "schpincer-backups",
});

const app = createKirDevApp("schpincer", {
    namespace: "schpincer",
    createNamespace: true,
});

const db = app.addPostgres({
    image: "ghcr.io/cloudnative-pg/postgresql:18.6-standard-trixie",
    backup: production
        ? {
              provider: b2.withPrefix("postgres/"),
              schedule: "0 30 3 * * *",
          }
        : false,
});

app.addDocker({
    image: versions.image,
    // The image always enables the `env,production` Spring profiles
    // (`docker/Dockerfile`); `application-env.properties` reads these.
    env: {
        SCHPINCER_POSTGRES_IP: interpolate`${db.host}:${db.port}`,
        SCHPINCER_POSTGRES_DB: db.database,
        SCHPINCER_POSTGRES_USER: db.user,
        SCHPINCER_POSTGRES_PASSWORD: db.password,
        // Hibernate keeps the schema up to date; there are no migrations.
        SCHPINCER_POSTGRES_DDL: "update",
        SCHPINCER_BASEURL: "https://schpincer.sch.bme.hu/",
        SCHPINCER_AUTHSCH_ID: production ? manualSecret() : "local-development",
        SCHPINCER_AUTHSCH_KEY: production ? manualSecret() : "local-development",
        // Comma-separated AuthSCH UUIDs that get sysadmin on login, and tokens
        // for the `/api` endpoints. Both may be left unset.
        SCHPINCER_SYSADMINS: manualSecret({ optional: true }),
        API_TOKENS: manualSecret({ optional: true }),
        // Trust Traefik's `X-Forwarded-*` headers (https scheme, client IP).
        SERVER_FORWARD_HEADERS_STRATEGY: "native",
    },
    volumes: [
        {
            // `schpincer.external` in `application-env.properties`.
            name: "uploads",
            mountPath: "/permanent/external",
            size: "2Gi",
            backup: production
                ? {
                      provider: b2.withPrefix("restic/"),
                      schedule: "50 3 * * *",
                  }
                : false,
        },
    ],
    startupProbe: { path: "/actuator/health/readiness", periodSeconds: 5, timeoutSeconds: 3, failureThreshold: 60 },
    readinessProbe: { path: "/actuator/health/readiness", periodSeconds: 10, timeoutSeconds: 3, failureThreshold: 3 },
    livenessProbe: { periodSeconds: 20, timeoutSeconds: 3, failureThreshold: 6 },
    resources: {
        // The JVM sizes its heap from the limit (`-XX:MaxRAMPercentage=90`);
        // the old deployment had the same limits and used ~1Gi.
        limits: { cpu: "2", memory: "1536Mi", "ephemeral-storage": "500Mi" },
        requests: { cpu: "100m", memory: "1Gi", "ephemeral-storage": "0" },
    },
})
    .port(80)
    .publish("schpincer.sch.bme.hu");

// The app exposes every actuator endpoint (`env`, `heapdump`, ...) without
// authentication, so keep `/actuator` unreachable from outside, as the old
// deployment did. The probes hit the pod directly and are unaffected. The more
// specific path wins over the main Ingress's `/`; an allow list of only
// localhost makes Traefik answer 403 to everyone.
new traefik.Middleware(app.scope, "schpincer-deny-all", {
    metadata: { name: "deny-all", labels: app.labels },
    spec: { ipAllowList: { sourceRange: ["127.0.0.1/32"] } },
});

new kube.KubeIngress(app.scope, "schpincer-actuator", {
    metadata: {
        name: "schpincer-actuator",
        labels: app.labels,
        // No cert-manager annotations: reuse the main Ingress's certificate.
        annotations: { "traefik.ingress.kubernetes.io/router.middlewares": "schpincer-deny-all@kubernetescrd" },
    },
    spec: {
        ingressClassName: "traefik",
        tls: [{ hosts: ["schpincer.sch.bme.hu"], secretName: "schpincer-tls-cert" }],
        rules: [
            {
                host: "schpincer.sch.bme.hu",
                http: {
                    paths: [
                        {
                            path: "/actuator",
                            pathType: "Prefix",
                            backend: { service: { name: "schpincer", port: { name: "http" } } },
                        },
                    ],
                },
            },
        ],
    },
});

export default app.build();
