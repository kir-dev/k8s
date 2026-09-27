// https://github.com/kir-dev/ehk
//
// https://ehk.kir-dev.hu
//
// Next.js + Payload CMS (Postgres) application.

import * as kube from "../imports/k8s";
import * as environment from "../.dev/environment.ts";
import * as cnpg from "../imports/postgresql.cnpg.io.ts";
import * as garage from "../imports/garage.rajsingh.info.ts";
import { versions } from "./versions.ts";
import { singletonApp } from "../.dev/cdk8s-utils.ts";

export default singletonApp({ namespace: "ehk", createNamespace: true }, (scope) => {
    const labels = {
        "app.kubernetes.io/name": "ehk",
        "app.kubernetes.io/instance": "ehk",
        "app.kubernetes.io/component": "server",
        "app.kubernetes.io/part-of": "ehk",
    };

    new kube.KubeConfigMap(scope, "ehk-config", {
        metadata: {
            name: "ehk-config",
            annotations: { "argocd.argoproj.io/sync-wave": "-25" },
        },
        data: {
            NODE_ENV: "production",
            NEXT_TELEMETRY_DISABLED: "1",
            S3_BUCKET: "ehk-media",
            S3_REGION: "us-east-1",
            S3_ENDPOINT: "http://ehk-garage:3900",
        },
    });

    // Set manually in production:
    //   PAYLOAD_SECRET:
    // S3 credentials are managed by the garage-operator in the
    // `ehk-garage-s3` secret (see the Garage cluster below).
    new kube.KubeSecret(scope, "ehk-secrets", {
        metadata: {
            name: "ehk-secrets",
            annotations: { "argocd.argoproj.io/sync-wave": "-25" },
        },
        ...(environment.environment != "Production"
            ? {
                  stringData: {
                      PAYLOAD_SECRET: "local-development-secret",
                  },
              }
            : {}),
    });

    new cnpg.Cluster(scope, "ehk-db", {
        metadata: {
            name: "ehk-db",
            labels: {
                "app.kubernetes.io/name": "postgres",
                "app.kubernetes.io/instance": "postgres-ehk",
                "app.kubernetes.io/component": "database",
                "app.kubernetes.io/part-of": "ehk",
            },
            annotations: { "argocd.argoproj.io/sync-wave": "-20" },
        },
        spec: {
            primaryUpdateStrategy: cnpg.ClusterSpecPrimaryUpdateStrategy.UNSUPERVISED,
            primaryUpdateMethod: cnpg.ClusterSpecPrimaryUpdateMethod.SWITCHOVER,
            instances: 2,
            imageName: "ghcr.io/cloudnative-pg/postgresql:17.5",
            imagePullPolicy: "IfNotPresent",
            monitoring: { enablePodMonitor: true },
            postgresql: {
                parameters: {
                    wal_level: "replica",
                    shared_buffers: "128MB",
                },
            },
            resources: {
                limits: {
                    cpu: cnpg.ClusterSpecResourcesLimits.fromString("500m"),
                    memory: cnpg.ClusterSpecResourcesLimits.fromString("512Mi"),
                    "ephemeral-storage": cnpg.ClusterSpecResourcesLimits.fromString("500Mi"),
                },
                requests: {
                    cpu: cnpg.ClusterSpecResourcesRequests.fromString("100m"),
                    memory: cnpg.ClusterSpecResourcesRequests.fromString("128Mi"),
                    "ephemeral-storage": cnpg.ClusterSpecResourcesRequests.fromString("100Mi"),
                },
            },
            storage: {
                size: "1.5Gi",
                storageClass: "node-local-zfs",
            },
            bootstrap: {
                initdb: {
                    database: "ehk",
                    owner: "ehk",
                },
            },
        },
    });

    // Migrations are applied at runtime by Payload (`prodMigrations`) during
    // Payload's first initialization, so no separate migration Job is needed.
    // The startup probe below deliberately hits a Payload route so the pod only
    // becomes Ready after that initialization (and thus the migrations) finishes.

    // Self-hosted S3-compatible object storage for the `media` collection,
    // managed by the garage-operator (see the `garage-operator` app).
    //
    // Garage is designed for multi-node clusters, but supports a single node
    // with a replication factor of 1.
    const garageLabels = { "app.kubernetes.io/name": "ehk-garage", "app.kubernetes.io/part-of": "ehk" };
    const storageClassName = "node-local-zfs";

    // Static admin bootstrap token. The operator uses it to drive Garage's
    // Admin API; GarageAdminToken writes it into the `ehk-garage-admin` secret
    // (key `admin-token`), which the GarageCluster below selects. The sync-wave
    // makes ArgoCD create the secret before the cluster that consumes it.
    new garage.GarageAdminTokenV1Beta1(scope, "ehk-garage-admin", {
        metadata: {
            name: "ehk-garage-admin",
            labels: garageLabels,
            annotations: { "argocd.argoproj.io/sync-wave": "-30" },
        },
        spec: {
            clusterRef: { name: "ehk-garage" },
            secretTemplate: { name: "ehk-garage-admin", tokenKey: "admin-token" },
        },
    });

    new garage.GarageClusterV1Beta2(scope, "ehk-garage", {
        metadata: {
            name: "ehk-garage",
            labels: garageLabels,
            annotations: { "argocd.argoproj.io/sync-wave": "-20" },
        },
        spec: {
            zone: "default",
            replication: { factor: 1 },
            storage: {
                replicas: 1,
                metadata: {
                    size: garage.GarageClusterV1Beta2SpecStorageMetadataSize.fromString("1Gi"),
                    storageClassName,
                },
                data: {
                    size: garage.GarageClusterV1Beta2SpecStorageDataSize.fromString("5Gi"),
                    storageClassName,
                },
                // A single-node cluster cannot tolerate any disruption anyway,
                // and a PDB would block draining the node.
                podDisruptionBudget: { enabled: false },
                resources: {
                    requests: {
                        cpu: garage.GarageClusterV1Beta2SpecStorageResourcesRequests.fromString("50m"),
                        memory: garage.GarageClusterV1Beta2SpecStorageResourcesRequests.fromString("128Mi"),
                        "ephemeral-storage": garage.GarageClusterV1Beta2SpecStorageResourcesRequests.fromString("0"),
                    },
                    limits: {
                        cpu: garage.GarageClusterV1Beta2SpecStorageResourcesLimits.fromString("500m"),
                        memory: garage.GarageClusterV1Beta2SpecStorageResourcesLimits.fromString("512Mi"),
                        "ephemeral-storage": garage.GarageClusterV1Beta2SpecStorageResourcesLimits.fromString("500Mi"),
                    },
                },
            },
            network: {
                rpcBindPort: 3901,
                service: { type: garage.GarageClusterV1Beta2SpecNetworkServiceType.CLUSTER_IP },
            },
            s3Api: { bindPort: 3900, region: "us-east-1" },
            admin: {
                bindPort: 3903,
                adminTokenSecretRef: { name: "ehk-garage-admin", key: "admin-token" },
            },
        },
    });

    new garage.GarageBucketV1Beta1(scope, "ehk-media", {
        metadata: {
            name: "ehk-media",
            labels: garageLabels,
            annotations: { "argocd.argoproj.io/sync-wave": "-15" },
        },
        spec: { clusterRef: { name: "ehk-garage" }, globalAlias: "ehk-media" },
    });

    // S3 credentials. The operator generates the key pair into the
    // `ehk-garage-s3` secret (keys `access-key-id`/`secret-access-key`), which
    // the app mounts, and grants it read/write on the `ehk-media` bucket.
    new garage.GarageKeyV1Beta1(scope, "ehk-media-key", {
        metadata: {
            name: "ehk-media",
            labels: garageLabels,
            annotations: { "argocd.argoproj.io/sync-wave": "-10" },
        },
        spec: {
            clusterRef: { name: "ehk-garage" },
            name: "ehk-media",
            secretTemplate: {
                name: "ehk-garage-s3",
                accessKeyIdKey: "access-key-id",
                secretAccessKeyKey: "secret-access-key",
            },
            bucketPermissions: [{ bucketRef: { name: "ehk-media" }, read: true, write: true }],
        },
    });

    new kube.KubeService(scope, "ehk-service", {
        metadata: { name: "ehk", labels },
        spec: {
            selector: labels,
            ports: [{ name: "http", port: 80, targetPort: kube.IntOrString.fromString("http") }],
        },
    });

    new kube.KubeDeployment(scope, "ehk-deployment", {
        metadata: { name: "ehk", labels },
        spec: {
            replicas: 1,
            selector: { matchLabels: labels },
            template: {
                metadata: { labels },
                spec: {
                    automountServiceAccountToken: false,
                    containers: [
                        {
                            name: "ehk",
                            image: versions.image,
                            imagePullPolicy: "IfNotPresent",
                            ports: [{ containerPort: 3000, protocol: "TCP", name: "http" }],
                            env: [
                                {
                                    name: "DATABASE_URI",
                                    valueFrom: { secretKeyRef: { name: "ehk-db-app", key: "uri" } },
                                },
                                {
                                    name: "PAYLOAD_SECRET",
                                    valueFrom: { secretKeyRef: { name: "ehk-secrets", key: "PAYLOAD_SECRET" } },
                                },
                                {
                                    name: "S3_ACCESS_KEY_ID",
                                    valueFrom: { secretKeyRef: { name: "ehk-garage-s3", key: "access-key-id" } },
                                },
                                {
                                    name: "S3_SECRET_ACCESS_KEY",
                                    valueFrom: { secretKeyRef: { name: "ehk-garage-s3", key: "secret-access-key" } },
                                },
                            ],
                            envFrom: [{ configMapRef: { name: "ehk-config" } }],
                            // Hit a Payload route so Payload's initialization
                            // (including `prodMigrations`) completes before the
                            // pod reports Ready.
                            startupProbe: {
                                httpGet: { path: "/admin", port: kube.IntOrString.fromString("http") },
                                periodSeconds: 5,
                                timeoutSeconds: 3,
                                failureThreshold: 60,
                            },
                            readinessProbe: {
                                httpGet: { path: "/admin", port: kube.IntOrString.fromString("http") },
                                periodSeconds: 10,
                                timeoutSeconds: 3,
                                failureThreshold: 3,
                            },
                            livenessProbe: {
                                tcpSocket: { port: kube.IntOrString.fromString("http") },
                                periodSeconds: 20,
                                timeoutSeconds: 3,
                                failureThreshold: 6,
                            },
                            resources: {
                                limits: {
                                    cpu: kube.Quantity.fromString("1000m"),
                                    memory: kube.Quantity.fromString("1Gi"),
                                    "ephemeral-storage": kube.Quantity.fromString("500Mi"),
                                },
                                requests: {
                                    cpu: kube.Quantity.fromString("100m"),
                                    memory: kube.Quantity.fromString("256Mi"),
                                    "ephemeral-storage": kube.Quantity.fromString("0"),
                                },
                            },
                        },
                    ],
                    restartPolicy: "Always",
                },
            },
        },
    });

    new kube.KubeIngress(scope, "ehk-ingress", {
        metadata: {
            name: "ehk",
            labels,
            annotations: {
                "cert-manager.io/cluster-issuer": "letsencrypt",
                "acme.cert-manager.io/http01-ingress-class": "traefik",
            },
        },
        spec: {
            ingressClassName: "traefik",
            tls: [{ hosts: ["ehk.kir-dev.hu"], secretName: "ehk-tls-cert" }],
            rules: [
                {
                    host: "ehk.kir-dev.hu",
                    http: {
                        paths: [
                            {
                                path: "/",
                                pathType: "Prefix",
                                backend: { service: { name: "ehk", port: { name: "http" } } },
                            },
                        ],
                    },
                },
            ],
        },
    });
});
