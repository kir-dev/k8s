// https://github.com/kir-dev/StartSCH
//
// https://start.sch.bme.hu

import * as environment from "../.dev/environment.ts";
import { createKirDevApp, manualSecret } from "../.dev/kir-dev-app.ts";
import { versions } from "./versions.ts";

const production = environment.environment == "Production";

const app = createKirDevApp("startsch", {
    namespace: "startsch",
    createNamespace: true,
    syncWaves: false,
    backups: {
        endpoint: "https://s3.eu-central-003.backblazeb2.com",
        region: "eu-central-003",
        bucket: "startsch-backups",
        // `startsch-backups` is a dedicated bucket, not a shared one.
        postgresPrefix: "",
    },
});

const db = app.addPostgres({
    imagePullPolicy: "Always",
    externalClusterName: "backblaze-backup",
    parameters: {
        // Only force WAL archiving every 20 minutes if the current segment is
        // not full (only 2500 requests/day are free in Backblaze, the original
        // 5 minutes ran out just before the reset).
        archive_timeout: "1200",
    },
    // In production the cluster was bootstrapped from the Backblaze backup, so
    // it recovers; in development it starts empty.
    restore: production ? "latest" : false,
    backup: production ? { schedule: "0 24 3 * * *", name: "startsch-backup" } : false,
});

const server = app
    .addDocker({
        image: versions.image,
        imagePullPolicy: "Always",
        labels: {
            "app.kubernetes.io/name": "startsch",
            "app.kubernetes.io/component": "server",
        },
        // Set manually:
        //   AuthSch__ClientId:
        //   AuthSch__ClientSecret:
        //   KirMail__ApiKey:
        //   Push__PrivateKey:
        //   Push__PublicKey:
        //   Push__Subject: mailto:
        env: {
            ConnectionStrings__Postgres: db.dotnetConnectionString(),
            AuthSch__ClientId: manualSecret(),
            AuthSch__ClientSecret: manualSecret(),
            KirMail__ApiKey: manualSecret(),
            Push__PrivateKey: manualSecret(),
            Push__PublicKey: manualSecret(),
            Push__Subject: manualSecret(),
            "Logging__LogLevel__Microsoft.AspNetCore.Authentication": "Warning",
            "Logging__LogLevel__Microsoft.AspNetCore.Authorization": "Warning",
            "Logging__LogLevel__Microsoft.AspNetCore.Components": "Warning",
            "Logging__LogLevel__Microsoft.AspNetCore.Hosting.Diagnostics": "Warning",
            "Logging__LogLevel__Microsoft.AspNetCore.Hosting": "Information",
            "Logging__LogLevel__Microsoft.AspNetCore.HttpOverrides": "Warning",
            "Logging__LogLevel__Microsoft.AspNetCore.Routing.EndpointMiddleware": "Information",
            "Logging__LogLevel__Microsoft.AspNetCore.Server": "Information",
            "Logging__LogLevel__Microsoft.AspNetCore": "Warning",
            "Logging__LogLevel__Microsoft.EntityFrameworkCore.Migrations": "Information",
            "Logging__LogLevel__Microsoft.EntityFrameworkCore": "Information",
            "Logging__LogLevel__Microsoft.Hosting": "Information",
            Logging__LogLevel__StartSch: "Trace",
            OTEL_EXPORTER_OTLP_ENDPOINT: "http://opentelemetry-collector.monitoring.svc.cluster.local:4317",
            StartSch__PublicUrl: "https://start.sch.bme.hu",
            StartSch__EnabledModules__All: production ? "true" : "false",
        },
        resources: {
            limits: { cpu: "500m", memory: "500Mi", "ephemeral-storage": "200Mi" },
            requests: { cpu: "100m", memory: "256Mi", "ephemeral-storage": "0" },
        },
    })
    .port(8080)
    .publish("start.sch.bme.hu", { labels: {} });

export default app;
