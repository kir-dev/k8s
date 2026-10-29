// https://github.com/kir-dev/edenykolcsonzo
//
// https://edenykolcsonzo.kir-dev.hu
//
// The Edénykölcsönző Next.js app runs on Vercel; only its Postgres database
// lives here. The database is published on a fixed public IP because Vercel
// reaches it over the internet.

import * as kube from "../imports/k8s";
import * as environment from "../.dev/environment.ts";
import { createBackblaze, createKirDevApp } from "../.dev/kir-dev-app.ts";

const production = environment.environment == "Production";

// Database backups live in their own Backblaze B2 bucket. The credentials are
// filled in manually in the generated `edenykolcsonzo-backups-secrets` Secret
// (ACCESS_KEY_ID / ACCESS_SECRET_KEY).
const b2 = createBackblaze({
    endpoint: "https://s3.eu-central-003.backblazeb2.com",
    region: "eu-central-003",
    bucket: "edenykolcsonzo-backups",
});

const app = createKirDevApp("edenykolcsonzo", {
    namespace: "edenykolcsonzo",
    createNamespace: true,
});

const db = app.addPostgres({
    image: "ghcr.io/cloudnative-pg/postgresql:18.6-standard-trixie",
    // Keep the size of the old standalone PVC so the logical dump fits.
    size: "2Gi",
    backup: production
        ? {
              provider: b2.withPrefix("postgres/"),
              schedule: "0 24 3 * * *",
              backblazeCredentialsSecret: "edenykolcsonzo-backups-secrets",
          }
        : false,
});

// The cluster applies a host-level default-deny ingress policy to pods in the
// shared `vc2` namespace. Without this allow policy the DB is reachable from
// other pods but not through the LoadBalancer.
new kube.KubeNetworkPolicy(app.scope, "allow-postgres", {
    metadata: { name: "allow-postgres", labels: app.labels },
    spec: {
        podSelector: { matchLabels: { "cnpg.io/cluster": db.clusterName } },
        policyTypes: ["Ingress"],
        ingress: [
            {
                ports: [
                    {
                        protocol: "TCP",
                        port: kube.IntOrString.fromNumber(5432),
                    },
                ],
            },
        ],
    },
});

// CloudNativePG only creates ClusterIP Services. Expose the writable primary
// through a dedicated LoadBalancer Service: the external port stays 8084 (as
// with the old Helm release) while targeting Postgres on 5432.
new kube.KubeService(app.scope, "edenykolcsonzo-db-public", {
    metadata: {
        name: "edenykolcsonzo-db",
        labels: {
            ...app.labels,
            "app.kubernetes.io/component": "database",
        },
        annotations: {
            "lbipam.cilium.io/ips": "152.66.192.36",
            "lbipam.cilium.io/sharing-key": "kir-sharing-key",
        },
    },
    spec: {
        type: "LoadBalancer",
        selector: {
            "cnpg.io/cluster": db.clusterName,
            "cnpg.io/instanceRole": "primary",
        },
        ports: [
            {
                name: "postgres",
                port: 8084,
                protocol: "TCP",
                targetPort: kube.IntOrString.fromNumber(5432),
            },
        ],
    },
});

export default app.build();
