// https://github.com/kir-dev/ehk
//
// https://ehk.kir-dev.hu
//
// Next.js + Payload CMS (Postgres) application.

import * as kube from "../imports/k8s";
import * as environment from "../.dev/environment.ts";
import * as cnpg from "../imports/postgresql.cnpg.io.ts";
import * as seaweed from "../imports/seaweed.seaweedfs.com.ts";
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
            S3_ENDPOINT: "http://ehk-seaweed-filer:8333",
        },
    });

    // Set manually in production:
    //   PAYLOAD_SECRET:
    // S3 credentials are managed by the seaweedfs-operator in the
    // `ehk-seaweed-s3` secret (see the Seaweed cluster below).
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
    // managed by the seaweedfs-operator (see the `seaweedfs-operator` app).
    // S3 and IAM share the filer service on port 8333.
    //
    // The image is kept here (not in versions.ts, which Renovate owns) because
    // it must track the operator's supported SeaweedFS version. This matches
    // the dependency pinned by seaweedfs-operator 1.0.39.
    const seaweedfsImage = "chrislusf/seaweedfs:4.47";
    const seaweedLabels = { "app.kubernetes.io/name": "ehk-seaweed", "app.kubernetes.io/part-of": "ehk" };
    const storageClassName = "node-local-zfs";

    new seaweed.Seaweed(scope, "ehk-seaweed", {
        metadata: { name: "ehk-seaweed", labels: seaweedLabels },
        spec: {
            image: seaweedfsImage,
            imagePullPolicy: "IfNotPresent",
            volumeServerDiskCount: 1,
            master: {
                replicas: 1,

                // The volume server computes its max volume count from free disk
                // space divided by this limit. With the 30GB default and the
                // node's ~75GB free, only ~2 volumes fit, so new collections
                // (e.g. `ehk-media`) get no writable volume and S3 writes 500.
                // 1GB keeps plenty of headroom on the node's disk.
                // -- AI slop, idk if needed
                volumeSizeLimitMb: 1024,
                volumePreallocate: false,

                persistence: {
                    enabled: true,
                    storageClassName,
                    resources: {
                        requests: {
                            storage: seaweed.SeaweedSpecMasterPersistenceResourcesRequests.fromString("1Gi"),
                        },
                    },
                },
                requests: {
                    cpu: seaweed.SeaweedSpecMasterRequests.fromString("50m"),
                    memory: seaweed.SeaweedSpecMasterRequests.fromString("128Mi"),
                    "ephemeral-storage": seaweed.SeaweedSpecMasterRequests.fromString("0"),
                },
                limits: {
                    cpu: seaweed.SeaweedSpecMasterLimits.fromString("500m"),
                    memory: seaweed.SeaweedSpecMasterLimits.fromString("512Mi"),
                    "ephemeral-storage": seaweed.SeaweedSpecMasterLimits.fromString("200Mi"),
                },
            },
            volume: {
                replicas: 1,
                storageClassName,
                requests: {
                    storage: seaweed.SeaweedSpecVolumeRequests.fromString("2Gi"),
                    cpu: seaweed.SeaweedSpecVolumeRequests.fromString("50m"),
                    memory: seaweed.SeaweedSpecVolumeRequests.fromString("128Mi"),
                    "ephemeral-storage": seaweed.SeaweedSpecVolumeRequests.fromString("0"),
                },
                limits: {
                    cpu: seaweed.SeaweedSpecVolumeLimits.fromString("500m"),
                    memory: seaweed.SeaweedSpecVolumeLimits.fromString("512Mi"),
                    "ephemeral-storage": seaweed.SeaweedSpecVolumeLimits.fromString("500Mi"),
                },
            },
            filer: {
                replicas: 1,
                iam: true,
                s3: { enabled: true },
                // IAM objects created through the API (and the CRDs below) need
                // write access; without this the operator cannot register them.
                extraArgs: ["-s3.iam.readOnly=false"],
                persistence: {
                    enabled: true,
                    storageClassName,
                    resources: {
                        requests: {
                            storage: seaweed.SeaweedSpecFilerPersistenceResourcesRequests.fromString("1Gi"),
                        },
                    },
                },
                requests: {
                    cpu: seaweed.SeaweedSpecFilerRequests.fromString("50m"),
                    memory: seaweed.SeaweedSpecFilerRequests.fromString("128Mi"),
                    "ephemeral-storage": seaweed.SeaweedSpecFilerRequests.fromString("0"),
                },
                limits: {
                    cpu: seaweed.SeaweedSpecFilerLimits.fromString("500m"),
                    memory: seaweed.SeaweedSpecFilerLimits.fromString("512Mi"),
                    "ephemeral-storage": seaweed.SeaweedSpecFilerLimits.fromString("200Mi"),
                },
            },
        },
    });

    // S3 identity and credentials. The operator generates the key pair into the
    // `ehk-seaweed-s3` secret (keys `accessKey`/`secretKey`), which the app mounts.
    new seaweed.S3Identity(scope, "ehk-seaweed-identity", {
        metadata: { name: "ehk", labels: seaweedLabels },
        spec: { seaweedRef: { name: "ehk-seaweed" } },
    });

    new seaweed.S3Credentials(scope, "ehk-seaweed-credentials", {
        metadata: { name: "ehk-seaweed-credentials", labels: seaweedLabels },
        spec: {
            seaweedRef: { name: "ehk-seaweed" },
            identityRef: { name: "ehk" },
            secretRef: { name: "ehk-seaweed-s3" },
        },
    });

    new seaweed.Bucket(scope, "ehk-media-bucket", {
        metadata: { name: "ehk-media", labels: seaweedLabels },
        spec: { clusterRef: { name: "ehk-seaweed" } },
    });

    new seaweed.S3Policy(scope, "ehk-media-policy", {
        metadata: { name: "ehk-media", labels: seaweedLabels },
        spec: {
            seaweedRef: { name: "ehk-seaweed" },
            statements: [
                {
                    effect: seaweed.S3PolicySpecStatementsEffect.ALLOW,
                    actions: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket"],
                    resources: ["ehk-media", "ehk-media/*"],
                },
            ],
        },
    });

    new seaweed.S3PolicyBinding(scope, "ehk-media-policy-binding", {
        metadata: { name: "ehk-media", labels: seaweedLabels },
        spec: {
            seaweedRef: { name: "ehk-seaweed" },
            policyRef: { name: "ehk-media" },
            subjects: [{ kind: seaweed.S3PolicyBindingSpecSubjectsKind.S3_IDENTITY, name: "ehk" }],
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
                                    valueFrom: { secretKeyRef: { name: "ehk-seaweed-s3", key: "accessKey" } },
                                },
                                {
                                    name: "S3_SECRET_ACCESS_KEY",
                                    valueFrom: { secretKeyRef: { name: "ehk-seaweed-s3", key: "secretKey" } },
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
