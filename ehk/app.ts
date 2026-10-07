// https://github.com/kir-dev/ehk
//
// https://ehk.kir-dev.hu
//
// Next.js + Payload CMS (Postgres) application.

import * as kube from "../imports/k8s";
import * as environment from "../.dev/environment.ts";
import * as cnpg from "../imports/postgresql.cnpg.io.ts";
import * as barman from "../imports/barmancloud.cnpg.io.ts";
import * as garage from "../imports/garage.rajsingh.info.ts";
import * as traefik from "../imports/traefik.io.ts";
import { ApiObject } from "cdk8s";
import { versions } from "./versions.ts";
import { singletonApp } from "../.dev/cdk8s-utils.ts";
import { DevStorageClass, ProdStorageClass, storageClass } from "../.dev/storageClass.ts";

export default singletonApp({ namespace: "ehk", createNamespace: true }, (scope) => {
    const labels = {
        "app.kubernetes.io/name": "ehk",
        "app.kubernetes.io/instance": "ehk",
        "app.kubernetes.io/component": "server",
        "app.kubernetes.io/part-of": "ehk",
    };

    // Per-app Backblaze B2 bucket, shared by the CNPG/Barman DB backups and
    // the VolSync/restic garage-volume backups. The two keep their data apart
    // by prefix (`postgres/` for Barman, `restic/` for VolSync). The
    // credentials are per app too: the Barman ObjectStore uses
    // `ehk-backups-secrets` in this namespace, VolSync uses a per-volume
    // `garage-{data,metadata}-backup` secret (see below).
    const backupBucket = environment.environment == "Production" ? "kir-dev-ehk-backups" : "ehk-test";
    const backupEndpoint = "https://s3.eu-central-003.backblazeb2.com";
    const backupRegion = "eu-central-003";

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

    // CNPG/Barman backups of `ehk-db` into the shared per-app bucket.
    new kube.KubeSecret(scope, "ehk-backups-secrets", {
        metadata: {
            name: "ehk-backups-secrets",
            annotations: {
                "argocd.argoproj.io/sync-wave": "-22",
                // The credentials are filled in manually; keep ArgoCD from
                // pruning the extra `data` keys it doesn't declare.
                "argocd.argoproj.io/compare-options": "IgnoreExtraneous",
            },
        },
        // Set manually (Backblaze B2 application key for `ehk`):
        // stringData:
        //   ACCESS_KEY_ID:
        //   ACCESS_SECRET_KEY:
    });

    new barman.ObjectStore(scope, "ehk-backups", {
        metadata: {
            name: "ehk-backups",
            annotations: { "argocd.argoproj.io/sync-wave": "-21" },
        },
        spec: {
            instanceSidecarConfiguration: {
                resources: {
                    limits: {
                        cpu: barman.ObjectStoreSpecInstanceSidecarConfigurationResourcesLimits.fromString("1"),
                        memory: barman.ObjectStoreSpecInstanceSidecarConfigurationResourcesLimits.fromString("512Mi"),
                        "ephemeral-storage":
                            barman.ObjectStoreSpecInstanceSidecarConfigurationResourcesLimits.fromString("500Mi"),
                    },
                    requests: {
                        cpu: barman.ObjectStoreSpecInstanceSidecarConfigurationResourcesRequests.fromString("100m"),
                        memory: barman.ObjectStoreSpecInstanceSidecarConfigurationResourcesRequests.fromString("128Mi"),
                        "ephemeral-storage":
                            barman.ObjectStoreSpecInstanceSidecarConfigurationResourcesRequests.fromString("100Mi"),
                    },
                },
            },
            configuration: {
                destinationPath: `s3://${backupBucket}/postgres/`,
                endpointUrl: backupEndpoint,
                s3Credentials: {
                    accessKeyId: { name: "ehk-backups-secrets", key: "ACCESS_KEY_ID" },
                    secretAccessKey: { name: "ehk-backups-secrets", key: "ACCESS_SECRET_KEY" },
                },
                wal: {
                    compression: barman.ObjectStoreSpecConfigurationWalCompression.GZIP,
                    maxParallel: 8,
                },
            },
        },
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
            // Archive WAL to the shared bucket (see the ObjectStore above).
            plugins: [
                {
                    name: "barman-cloud.cloudnative-pg.io",
                    enabled: true, // needed otherwise ArgoCD complains
                    isWalArchiver: true,
                    parameters: { barmanObjectName: "ehk-backups" },
                },
            ],
            bootstrap: {
                initdb: {
                    database: "ehk",
                    owner: "ehk",
                },
            },
        },
    });

    new cnpg.ScheduledBackup(scope, "ehk-db-backup", {
        metadata: { name: "ehk-db-backup" },
        spec: {
            cluster: { name: "ehk-db" },
            schedule: "0 18 3 * * *", // At 3:18 every day
            backupOwnerReference: cnpg.ScheduledBackupSpecBackupOwnerReference.SELF,
            method: cnpg.ScheduledBackupSpecMethod.PLUGIN,
            pluginConfiguration: { name: "barman-cloud.cloudnative-pg.io" },
        },
    });

    // Migrations are applied at runtime by Payload (`prodMigrations`) during
    // Payload's first initialization, so no separate migration Job is needed.
    // The startup probe below deliberately hits a Payload route so the pod only
    // becomes Ready after that initialization (and thus the migrations) finishes.

    const garageLabels = {
        "app.kubernetes.io/name": "ehk-garage",
        "app.kubernetes.io/part-of": "ehk",
    };
    // Leftover from the abandoned Velero `Schedule`; nothing selects on it now
    // (VolSync picks the PVCs by name). It stays because the garage-operator
    // treats `storage.labels` as immutable while replicas are live, and the
    // running prod cluster already carries it — removing it is rejected
    // ("... labels ... are immutable while replicas are live"). Do not spread it
    // onto `garageLabels`: that part is mutable and unused.
    const garageBackupLabels = { "backup.kir-dev.hu/ehk-garage": "true" };
    const storageClassName = storageClass(ProdStorageClass.memorySsd, DevStorageClass.snapshottableHostPath);

    // VolSync restores a snapshot by creating a new volume from it, so it needs
    // an explicit VolumeSnapshotClass: the host's class is synced into the
    // vCluster but is not marked as the default.
    const volumeSnapshotClassName =
        environment.environment == "Production"
            ? // The `memory-ssd` StorageClass is Ceph RBD (`rbd.csi.ceph.com`), so
              // the matching (RBD) VolumeSnapshotClass is ironically called
              // `memory`; `memory-ssd` is the CephFS one. (There is no
              // `csi-rbdplugin-snapclass`.)
              "memory"
            : "csi-hostpath-snapclass";

    // Set to "recovery" to bootstrap garage from the latest VolSync backup
    // instead of creating it empty, then set it back to "init" once the restore
    // has completed. This is the restic equivalent of `startsch/app.ts`'s CNPG
    // `bootstrap.recovery` switch.
    const garageBootstrap = "init" as "init" | "recovery";

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
                // Declared explicitly (like the GarageKey defaults below):
                // the operator only defaults these, and ArgoCD would
                // otherwise see the GarageCluster as OutOfSync and trip the
                // operator's immutable-storage admission webhook.
                dataFsync: false,
                metadataFsync: false,
                metadata: {
                    type: garage.GarageClusterV1Beta2SpecStorageMetadataType.PERSISTENT_VOLUME_CLAIM,
                    size: garage.GarageClusterV1Beta2SpecStorageMetadataSize.fromString("1Gi"),
                    storageClassName,
                    labels: garageBackupLabels,
                    // On recovery the operator creates this PVC from the
                    // restored CSI snapshot instead of an empty one, so the PVC
                    // stays operator-owned (see the recovery branch below).
                    dataSourceRef:
                        garageBootstrap === "recovery"
                            ? {
                                  apiGroup: "snapshot.storage.k8s.io",
                                  kind: "VolumeSnapshot",
                                  name: "garage-metadata-restore-snap",
                              }
                            : undefined,
                },
                data: {
                    type: garage.GarageClusterV1Beta2SpecStorageDataType.PERSISTENT_VOLUME_CLAIM,
                    size: garage.GarageClusterV1Beta2SpecStorageDataSize.fromString("5Gi"),
                    storageClassName,
                    labels: garageBackupLabels,
                    dataSourceRef:
                        garageBootstrap === "recovery"
                            ? {
                                  apiGroup: "snapshot.storage.k8s.io",
                                  kind: "VolumeSnapshot",
                                  name: "garage-data-restore-snap",
                              }
                            : undefined,
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
            // These are the operator's defaults. Declaring them explicitly keeps
            // ArgoCD from reporting the resource as OutOfSync forever, since the
            // webhook writes them back into the spec.
            neverExpires: false,
            secretTemplate: {
                name: "ehk-garage-s3",
                type: "Opaque",
                accessKeyIdKey: "access-key-id",
                secretAccessKeyKey: "secret-access-key",
                endpointKey: "endpoint",
                hostKey: "host",
                schemeKey: "scheme",
                regionKey: "region",
                bucketNameKey: "bucket",
                websiteUrlKey: "website-url",
                credentialsFileKey: "credentials",
                credentialsFileProfile: "default",
            },
            bucketPermissions: [{ bucketRef: { name: "ehk-media" }, read: true, write: true, owner: false }],
        },
    });

    // Back up the garage volumes (data + metadata) to Backblaze B2 with VolSync
    // + restic, one repository per PVC (VolSync does not support shared repos).
    // Each backup takes a CSI snapshot of the PVC (`copyMethod: Snapshot`) and
    // restics it off-site. On recovery VolSync restores into a dedicated PVC
    // and snapshots it under a fixed name; the operator then creates its own
    // PVC from that VolumeSnapshot (the GarageCluster's `dataSourceRef`).
    //
    // The PVC names are the ones the garage-operator's StatefulSet creates:
    // `<volumeClaimTemplate>-<statefulset>-<ordinal>` = data-...-0-0 / metadata-...-0-0.
    const garageVolumes = [
        {
            name: "data",
            pvc: "data-ehk-garage-storage-0-0",
            size: "5Gi",
            restorePvc: "garage-data-restore",
            restoreSnapshot: "garage-data-restore-snap",
        },
        {
            name: "metadata",
            pvc: "metadata-ehk-garage-storage-0-0",
            size: "1Gi",
            restorePvc: "garage-metadata-restore",
            restoreSnapshot: "garage-metadata-restore-snap",
        },
    ] as const;

    for (const volume of garageVolumes) {
        const repository = `garage-${volume.name}-backup`;
        // The connection info is filled in manually (see README); only the
        // (non-secret) repository URL is declared here.
        new kube.KubeSecret(scope, `${repository}-secret`, {
            metadata: {
                name: repository,
                annotations: {
                    // The restic ReplicationSource/Destination below consumes this
                    // secret, so create it first.
                    "argocd.argoproj.io/sync-wave": "-26",
                    // Only (non-secret) connection info is declared in Git; the
                    // credentials are set manually. IgnoreExtraneous keeps ArgoCD
                    // from pruning those extra keys (same pattern as
                    // `ehk-backups-secrets`), so no global `ignoreDifferences` is
                    // needed.
                    "argocd.argoproj.io/compare-options": "IgnoreExtraneous",
                },
            },
            stringData: {
                RESTIC_REPOSITORY: `s3:${backupEndpoint}/${backupBucket}/restic/${volume.pvc}`,
                AWS_DEFAULT_REGION: backupRegion,
            },
            // Set manually:
            // stringData:
            //   RESTIC_PASSWORD:
            //   AWS_ACCESS_KEY_ID:
            //   AWS_SECRET_ACCESS_KEY:
        });

        if (garageBootstrap === "init") {
            new ApiObject(scope, `${repository}-source`, {
                apiVersion: "volsync.backube/v1alpha1",
                kind: "ReplicationSource",
                metadata: {
                    name: repository,
                    annotations: { "argocd.argoproj.io/sync-wave": "-25" },
                },
                spec: {
                    sourcePVC: volume.pvc,
                    trigger: { schedule: "45 3 * * *" },
                    restic: {
                        repository,
                        copyMethod: "Snapshot",
                        volumeSnapshotClassName,
                        // Pin the restic cache PVC's class: otherwise it falls
                        // back to the cluster default, and prod vc2 has none, so
                        // the cache sits Pending and the mover never runs.
                        cacheStorageClassName: storageClassName,
                        retain: { daily: 7, weekly: 4, monthly: 6 },
                        pruneIntervalDays: 7,
                    },
                },
            });
        } else {
            // On recovery: restore the repo into a dedicated PVC, then let
            // VolSync snapshot it under a fixed name (the destination PVC's
            // `volsync.backube/snapname` annotation pins the VolumeSnapshot
            // name). The GarageCluster's `dataSourceRef` points at that
            // snapshot, so the operator provisions its own PVC from the CSI
            // snapshot — which vCluster syncs correctly, unlike the populator.
            new kube.KubePersistentVolumeClaim(scope, `${repository}-restore-pvc`, {
                metadata: {
                    name: volume.restorePvc,
                    annotations: {
                        // The ReplicationDestination restores into this PVC
                        // (wave -24); create the PVC before it.
                        "argocd.argoproj.io/sync-wave": "-25",
                        "volsync.backube/snapname": volume.restoreSnapshot,
                    },
                },
                spec: {
                    accessModes: ["ReadWriteOnce"],
                    storageClassName,
                    resources: { requests: { storage: kube.Quantity.fromString(volume.size) } },
                },
            });

            new ApiObject(scope, `${repository}-destination`, {
                apiVersion: "volsync.backube/v1alpha1",
                kind: "ReplicationDestination",
                metadata: {
                    name: repository,
                    annotations: { "argocd.argoproj.io/sync-wave": "-24" },
                },
                spec: {
                    trigger: { manual: "restore-once" },
                    restic: {
                        repository,
                        destinationPVC: volume.restorePvc,
                        copyMethod: "Snapshot",
                        volumeSnapshotClassName,
                        cacheStorageClassName: storageClassName,
                    },
                },
            });
        }
    }

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

    // Temp domain, proxies /eszb to ehk.bme.hu
    if (environment.environment == "Production") {
        new kube.KubeIngress(scope, "ehk-temp-ingress", {
            metadata: {
                name: "ehk-temp",
                labels,
                annotations: {
                    "cert-manager.io/cluster-issuer": "letsencrypt",
                    "acme.cert-manager.io/http01-ingress-class": "traefik",
                },
            },
            spec: {
                ingressClassName: "traefik",
                tls: [{ hosts: ["ehk-de-most-mar-tenyleg.kir-dev.hu"], secretName: "ehk-temp-tls-cert" }],
                rules: [
                    {
                        host: "ehk-de-most-mar-tenyleg.kir-dev.hu",
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

        // Temporary: test the legacy `/eszb` proxy through the temp domain.
        // The old vhost only answers for `ehk.bme.hu` (verified: any other Host
        // gets a 404), so override the Host header on the way out. A separate
        // Ingress keeps this middleware off the `/` route above.
        new traefik.Middleware(scope, "ehk-eszb-host-override", {
            metadata: { name: "eszb-host-override", labels },
            spec: { headers: { customRequestHeaders: { Host: "ehk.bme.hu" } } },
        });

        new kube.KubeIngress(scope, "ehk-eszb-test-ingress", {
            metadata: {
                name: "ehk-eszb-test",
                labels,
                annotations: {
                    "cert-manager.io/cluster-issuer": "letsencrypt",
                    "acme.cert-manager.io/http01-ingress-class": "traefik",
                    "traefik.ingress.kubernetes.io/router.middlewares": "ehk-eszb-host-override@kubernetescrd",
                },
            },
            spec: {
                ingressClassName: "traefik",
                tls: [{ hosts: ["ehk-de-most-mar-tenyleg.kir-dev.hu"], secretName: "ehk-temp-tls-cert" }],
                rules: [
                    {
                        host: "ehk-de-most-mar-tenyleg.kir-dev.hu",
                        http: {
                            paths: [
                                {
                                    path: "/eszb",
                                    pathType: "Prefix",
                                    backend: { service: { name: "ehk-eszb", port: { name: "http" } } },
                                },
                            ],
                        },
                    },
                ],
            },
        });

        // The legacy `/eszb` pages are still served by the old EHK box. An
        // ExternalName Service points Traefik at the box's IP without a
        // manually-managed EndpointSlice, which Argo CD excludes from its
        // resource supervision. Traefik builds the backend URL directly from
        // this value, so no DNS is involved. The original Host header
        // (ehk.bme.hu) is passed through unchanged by the middleware above.
        new kube.KubeService(scope, "ehk-eszb-service", {
            metadata: { name: "ehk-eszb", labels },
            spec: {
                type: "ExternalName",
                externalName: "152.66.125.225",
                ports: [{ name: "http", port: 80 }],
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
                tls: [{ hosts: ["ehk.bme.hu"], secretName: "ehk-tls-cert" }],
                rules: [
                    {
                        host: "ehk.bme.hu",
                        http: {
                            paths: [
                                {
                                    path: "/eszb",
                                    pathType: "Prefix",
                                    backend: { service: { name: "ehk-eszb", port: { name: "http" } } },
                                },
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
    }
});
