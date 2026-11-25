import { describe, expect, test } from "bun:test";
import { parseAllDocuments } from "yaml";
import { createBackblaze, createKirDevApp, interpolate, manualSecret } from "./kir-dev-app.ts";

function synthObjects(app: { synthYaml(): string }): Record<string, any>[] {
    return parseAllDocuments(app.synthYaml())
        .map((doc) => doc.toJS())
        .filter((obj): obj is Record<string, any> => obj !== null && obj !== undefined);
}

describe("createBackblaze", () => {
    test("accepts bucket shorthand with default eu-central-003 endpoint and region", () => {
        const target = createBackblaze("my-bucket").withPrefix("postgres/");
        expect(target).toEqual({
            endpoint: "https://s3.eu-central-003.backblazeb2.com",
            region: "eu-central-003",
            bucket: "my-bucket",
            prefix: "postgres/",
        });
    });

    test("allows overriding endpoint and region", () => {
        const target = createBackblaze({
            bucket: "custom",
            endpoint: "https://s3.us-west-004.backblazeb2.com",
            region: "us-west-004",
        }).withPrefix("restic/");
        expect(target.endpoint).toBe("https://s3.us-west-004.backblazeb2.com");
        expect(target.region).toBe("us-west-004");
        expect(target.prefix).toBe("restic/");
    });
});

describe("KirDevApp", () => {
    test("creates namespace, workload, configmap, service, ingress, and manual secrets with annotations", () => {
        const app = createKirDevApp("demo");
        const db = app.addPostgres({ image: "ghcr.io/cloudnative-pg/postgresql:17.5" });
        const server = app.addDocker({
            image: "ghcr.io/kir-dev/demo:v1.0.0",
            env: {
                NODE_ENV: "production",
                DATABASE_URI: db.uri,
                API_KEY: manualSecret(),
                JWT_SECRET: manualSecret({ key: "SHARED_SECRET", optional: true }),
            },
            readinessProbe: { path: "/healthz" },
            livenessProbe: { path: "/livez" },
        });
        server.port(3000, "web").publish("demo.kir-dev.hu", {
            paths: [{ path: "/api" }],
        });

        const objs = synthObjects(app.build());

        const ns = objs.find((o) => o.kind === "Namespace");
        expect(ns?.metadata.name).toBe("demo");

        const secret = objs.find((o) => o.kind === "Secret" && o.metadata.name === "demo-secrets");
        expect(secret?.metadata.annotations["argocd.argoproj.io/compare-options"]).toBe("IgnoreExtraneous");
        expect(secret?.metadata.annotations["kir-dev.hu/required-keys"]).toBe("API_KEY,SHARED_SECRET");

        const cm = objs.find((o) => o.kind === "ConfigMap" && o.metadata.name === "demo-config");
        expect(cm?.data).toEqual({ NODE_ENV: "production" });

        const deploy = objs.find((o) => o.kind === "Deployment");
        const container = deploy?.spec.template.spec.containers[0];
        expect(container.livenessProbe.httpGet).toEqual({ path: "/livez", port: "web" });
        expect(container.livenessProbe.periodSeconds).toBe(20);
        expect(container.livenessProbe.failureThreshold).toBe(6);

        const ingress = objs.find((o) => o.kind === "Ingress");
        expect(ingress?.spec.rules[0].http.paths[0].backend.service.port.name).toBe("web");
    });

    test("uses tcpSocket for livenessProbe when path is omitted", () => {
        const app = createKirDevApp("tcp-app");
        app.addDocker({
            image: "ghcr.io/kir-dev/tcp:v1",
            livenessProbe: { periodSeconds: 15 },
        }).port(8080);

        const objs = synthObjects(app.build());
        const deploy = objs.find((o) => o.kind === "Deployment");
        const liveness = deploy?.spec.template.spec.containers[0].livenessProbe;
        expect(liveness.tcpSocket).toEqual({ port: "http" });
        expect(liveness.httpGet).toBeUndefined();
    });

    test("deduplicates shared SecretKeyRef env vars across multiple interpolate calls", () => {
        const app = createKirDevApp("dedup");
        const db = app.addPostgres({ image: "ghcr.io/cloudnative-pg/postgresql:17.5" });
        app.addDocker({
            image: "ghcr.io/kir-dev/dedup:v1",
            env: {
                CONN_A: db.dotnetConnectionString(),
                CONN_B: interpolate`postgres://${db.user}:${db.password}@${db.host}/${db.database}`,
            },
        });

        const objs = synthObjects(app.build());
        const deploy = objs.find((o) => o.kind === "Deployment");
        const envNames: string[] = deploy?.spec.template.spec.containers[0].env.map((e: any) => e.name);
        expect(new Set(envNames).size).toBe(envNames.length);
        expect(envNames).toContain("CONN_A");
        expect(envNames).toContain("CONN_B");
        expect(envNames.filter((n) => n === "DBHOST")).toHaveLength(1);
    });

    test("throws when env var collides with a ConfigMap entry", () => {
        const app = createKirDevApp("conflict");
        const db = app.addPostgres({ image: "ghcr.io/cloudnative-pg/postgresql:17.5" });
        app.addDocker({
            image: "ghcr.io/kir-dev/conflict:v1",
            env: {
                DBHOST: "hardcoded",
                CONN: db.dotnetConnectionString(),
            },
        });

        expect(() => app.build()).toThrow(/collides with ConfigMap/);
    });

    test("validates restore requires backup", () => {
        const app = createKirDevApp("bad-restore");
        expect(() =>
            app.addPostgres({
                image: "ghcr.io/cloudnative-pg/postgresql:17.5",
                restore: "latest",
                backup: false,
            }),
        ).toThrow(/requires backup/);
    });

    test("sets CNPG podAntiAffinityType for multi-instance clusters and omits for single-instance", () => {
        const multi = createKirDevApp("multi");
        multi.addPostgres({ image: "ghcr.io/cloudnative-pg/postgresql:17.5", instances: 2 });
        const multiCluster = synthObjects(multi.build()).find((o) => o.kind === "Cluster");
        expect(multiCluster?.spec.affinity.podAntiAffinityType).toBe("required");

        const single = createKirDevApp("single");
        single.addPostgres({ image: "ghcr.io/cloudnative-pg/postgresql:17.5", instances: 1 });
        const singleCluster = synthObjects(single.build()).find((o) => o.kind === "Cluster");
        expect(singleCluster?.spec.affinity).toBeUndefined();
    });

    test("db.publish creates NetworkPolicy and LoadBalancer Service", () => {
        const app = createKirDevApp("pubdb");
        app.addPostgres({ image: "ghcr.io/cloudnative-pg/postgresql:18.6-standard-trixie" }).publish({
            port: 8084,
            ip: "152.66.192.36",
            sharingKey: "kir-sharing-key",
        });

        const objs = synthObjects(app.build());
        const np = objs.find((o) => o.kind === "NetworkPolicy");
        expect(np?.metadata.name).toBe("allow-postgres");
        expect(np?.spec.podSelector.matchLabels).toEqual({ "cnpg.io/cluster": "pubdb-db" });
        expect(np?.spec.ingress[0].ports[0]).toEqual({ protocol: "TCP", port: 5432 });

        const svc = objs.find((o) => o.kind === "Service" && o.spec.type === "LoadBalancer");
        expect(svc?.metadata.name).toBe("pubdb-db");
        expect(svc?.metadata.annotations).toEqual({
            "lbipam.cilium.io/ips": "152.66.192.36",
            "lbipam.cilium.io/sharing-key": "kir-sharing-key",
        });
        expect(svc?.spec.selector).toEqual({
            "cnpg.io/cluster": "pubdb-db",
            "cnpg.io/instanceRole": "primary",
        });
        expect(svc?.spec.ports[0]).toEqual({
            name: "postgres",
            port: 8084,
            protocol: "TCP",
            targetPort: 5432,
        });
    });

    test("addGarage supports dataSize/metadataSize without backup and restore lifecycle with backup", () => {
        const noBackup = createKirDevApp("s3-only");
        noBackup.addGarage({ buckets: ["assets"], dataSize: "10Gi", metadataSize: "2Gi" });
        const gc = synthObjects(noBackup.build()).find((o) => o.kind === "GarageCluster");
        expect(gc?.spec.storage.data.size).toBe("10Gi");
        expect(gc?.spec.storage.metadata.size).toBe("2Gi");
        expect(gc?.spec.storage.dataFsync).toBe(false);
        expect(gc?.spec.storage.metadataFsync).toBe(false);

        const restoring = createKirDevApp("s3-restore");
        restoring.addGarage({
            buckets: ["media"],
            backup: {
                provider: createBackblaze("b").withPrefix("restic/"),
                lifecycle: "restore",
            },
        });
        const restoreObjs = synthObjects(restoring.build());
        expect(restoreObjs.filter((o) => o.kind === "ReplicationDestination")).toHaveLength(2);
        expect(restoreObjs.filter((o) => o.kind === "ReplicationSource")).toHaveLength(0);
        expect(restoreObjs.filter((o) => o.kind === "PersistentVolumeClaim")).toHaveLength(2);
        const restoredGc = restoreObjs.find((o) => o.kind === "GarageCluster");
        expect(restoredGc?.spec.storage.data.dataSourceRef.name).toBe("garage-data-restore-snap");
    });
});
