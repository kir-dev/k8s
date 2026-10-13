// https://github.com/kir-dev/ehk
//
// https://ehk.kir-dev.hu
//
// Next.js + Payload CMS (Postgres) application.

import * as kube from "../imports/k8s";
import * as traefik from "../imports/traefik.io.ts";
import * as environment from "../.dev/environment.ts";
import { createKirDevApp, manualSecret } from "../.dev/kir-dev-app.ts";
import { versions } from "./versions.ts";

// Per-app Backblaze B2 bucket, shared by the CNPG/Barman DB backups
// (`postgres/` prefix) and the VolSync/restic garage-volume backups
// (`restic/` prefix).
const backupBucket = environment.environment == "Production" ? "kir-dev-ehk-backups" : "ehk-test";
const backupEndpoint = "https://s3.eu-central-003.backblazeb2.com";
const backupRegion = "eu-central-003";

const app = createKirDevApp("ehk", {
    namespace: "ehk",
    createNamespace: true,
    backups: { endpoint: backupEndpoint, region: backupRegion, bucket: backupBucket },
    // Set manually in production:
    //   PAYLOAD_SECRET:
    devSecrets: { PAYLOAD_SECRET: "local-development-secret" },
});

const db = app.addPostgres({
    backup: { schedule: "0 18 3 * * *" },
});

const s3 = app.addGarage({
    buckets: ["ehk-media"],
    backup: { schedule: "45 3 * * *" },
});

const server = app
    .addDocker({
        image: versions.image,
        env: {
            ...s3.env(),
            NODE_ENV: "production",
            NEXT_TELEMETRY_DISABLED: "1",
            DATABASE_URI: db.uri,
            PAYLOAD_SECRET: manualSecret(),
        },
        // Hit a Payload route so Payload's initialization (including
        // `prodMigrations`) completes before the pod reports Ready.
        startupProbe: { path: "/admin", periodSeconds: 5, timeoutSeconds: 3, failureThreshold: 60 },
        readinessProbe: { path: "/admin", periodSeconds: 10, timeoutSeconds: 3, failureThreshold: 3 },
        livenessProbe: { periodSeconds: 20, timeoutSeconds: 3, failureThreshold: 6 },
    })
    .port(3000)
    // The new site at `ehk.bme.hu`. Everything is served by the Payload app
    // except the legacy `/eszb` pages, which are still only on the old box.
    .publish("ehk.bme.hu", {
        paths: [
            { path: "/eszb", service: "ehk-eszb" },
            { path: "/", service: "ehk" },
        ],
    })
    // The old site stays reachable at `ehk-regi.kir-dev.hu` while `ehk.bme.hu`
    // moves to the new app. Its DNS record points at the cluster, which
    // terminates TLS and proxies everything to the box with the Host it
    // expects.
    .publish("ehk-regi.kir-dev.hu", {
        name: "ehk-regi",
        middlewares: ["ehk-eszb-host-override@kubernetescrd"],
        paths: [{ path: "/", service: "ehk-eszb" }],
    });

app.configure(({ scope, app }) => {
    // The old EHK box at 152.66.125.225 only answers for the `ehk.bme.hu`
    // vhost (any other Host gets a 404), so every request proxied there must
    // carry that Host header; the `eszb-host-override` middleware below does
    // exactly that. An ExternalName Service points Traefik straight at the
    // box's IP without a manually managed EndpointSlice.
    new kube.KubeService(scope, "ehk-eszb-service", {
        metadata: { name: "ehk-eszb", labels: app.labels },
        spec: {
            type: "ExternalName",
            externalName: "152.66.125.225",
            ports: [{ name: "http", port: 80 }],
        },
    });

    new traefik.Middleware(scope, "ehk-eszb-host-override", {
        metadata: { name: "eszb-host-override", labels: app.labels },
        spec: { headers: { customRequestHeaders: { Host: "ehk.bme.hu" } } },
    });
});

// Temporary placeholder domain for the new site, used until the `ehk.bme.hu`
// DNS record points at the cluster. Production only: it resolves to the
// production load balancer.
if (environment.environment == "Production") {
    server
        .publish("ehk-de-most-mar-tenyleg.kir-dev.hu", { name: "ehk-temp" })
        // Test the legacy `/eszb` proxy through the temp domain. A separate
        // Ingress keeps the host-override middleware off the `/` route above.
        .publish("ehk-de-most-mar-tenyleg.kir-dev.hu", {
            name: "ehk-eszb-test",
            middlewares: ["ehk-eszb-host-override@kubernetescrd"],
            tlsSecretName: "ehk-temp-tls-cert",
            paths: [{ path: "/eszb", service: "ehk-eszb" }],
        });
}

export default app;
