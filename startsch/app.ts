// https://github.com/kir-dev/StartSCH
//
// https://start.sch.bme.hu

import * as kube from "../imports/k8s";
import * as environment from "../.dev/environment.ts";
import * as cnpg from "../imports/postgresql.cnpg.io.ts";
import * as barman from "../imports/barmancloud.cnpg.io.ts";
import { versions } from "./versions.ts";
import { singletonApp } from "../.dev/cdk8s-utils.ts";

export default singletonApp({ namespace: "startsch", createNamespace: true }, (scope) => {
    new kube.KubeConfigMap(scope, "startsch-config", {
        metadata: { name: "startsch-config" },
        data: {
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
            StartSch__EnabledModules__All: environment.environment == "Production" ? "true" : "false",
        },
    });

    new kube.KubeSecret(scope, "startsch-secrets", {
        metadata: { name: "startsch-secrets" },
        // Set manually:
        // stringData:
        //   AuthSch__ClientId:
        //   AuthSch__ClientSecret:
        //   KirMail__ApiKey:
        //   Push__PrivateKey:
        //   Push__PublicKey:
        //   Push__Subject: mailto:
    });

    const labels = {
        "app.kubernetes.io/name": "startsch",
        "app.kubernetes.io/component": "server",
    };

    new kube.KubeService(scope, "startsch-service", {
        metadata: { name: "startsch" },
        spec: {
            selector: labels,
            ports: [{ name: "http", port: 80, targetPort: kube.IntOrString.fromString("http") }],
        },
    });

    new kube.KubeSecret(scope, "startsch-backups-secrets", {
        metadata: { name: "startsch-backups-secrets" },
        // Set manually:
        // stringData:
        //   ACCESS_KEY_ID:
        //   ACCESS_SECRET_KEY:
    });

    const bootstrapMode: "initdb" | "recovery" = environment.environment == "Production" ? "recovery" : "initdb";
    // Set to false while restoring from a backup
    const enableBackup = environment.environment == "Production";

    // Configure where the backups are
    if (enableBackup) {
        new barman.ObjectStore(scope, "startsch-backups", {
            metadata: { name: "startsch-backups" },
            spec: {
                instanceSidecarConfiguration: {
                    resources: {
                        limits: {
                            cpu: barman.ObjectStoreSpecInstanceSidecarConfigurationResourcesLimits.fromString("1"),
                            memory: barman.ObjectStoreSpecInstanceSidecarConfigurationResourcesLimits.fromString(
                                "512Mi",
                            ),
                            "ephemeral-storage":
                                barman.ObjectStoreSpecInstanceSidecarConfigurationResourcesLimits.fromString("500Mi"),
                        },
                        requests: {
                            cpu: barman.ObjectStoreSpecInstanceSidecarConfigurationResourcesRequests.fromString("100m"),
                            memory: barman.ObjectStoreSpecInstanceSidecarConfigurationResourcesRequests.fromString(
                                "128Mi",
                            ),
                            "ephemeral-storage":
                                barman.ObjectStoreSpecInstanceSidecarConfigurationResourcesRequests.fromString("100Mi"),
                        },
                    },
                },
                configuration: {
                    destinationPath: "s3://startsch-backups/",
                    endpointUrl: "https://s3.eu-central-003.backblazeb2.com",
                    s3Credentials: {
                        accessKeyId: { name: "startsch-backups-secrets", key: "ACCESS_KEY_ID" },
                        secretAccessKey: { name: "startsch-backups-secrets", key: "ACCESS_SECRET_KEY" },
                    },
                    wal: {
                        compression: barman.ObjectStoreSpecConfigurationWalCompression.GZIP,
                        maxParallel: 8,
                    },
                },
            },
        });
    }

    const clusterProps: cnpg.ClusterProps = {
        metadata: {
            name: "startsch-db",
            labels: {
                "app.kubernetes.io/name": "postgres",
                "app.kubernetes.io/instance": "postgres-startsch",
                "app.kubernetes.io/component": "database",
                "app.kubernetes.io/part-of": "startsch",
            },
        },
        spec: {
            primaryUpdateStrategy: cnpg.ClusterSpecPrimaryUpdateStrategy.UNSUPERVISED,
            primaryUpdateMethod: cnpg.ClusterSpecPrimaryUpdateMethod.SWITCHOVER,
            instances: 2,
            imageName: "ghcr.io/cloudnative-pg/postgresql:17.5",
            imagePullPolicy: "Always",
            monitoring: { enablePodMonitor: true },
            postgresql: {
                parameters: {
                    wal_level: "replica",
                    shared_buffers: "128MB",
                    // only force wal archiving every 20 minutes if the current segment is not full
                    // (only 2500 requests/day are free in backblaze, the original value of 5 minutes ran out of requests just before the reset)
                    archive_timeout: "1200",
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
        },
    };

    const spec: cnpg.ClusterSpec = {
        ...clusterProps.spec,
        ...(environment.environment == "Production"
            ? {
                  externalClusters: [
                      {
                          name: "backblaze-backup",
                          plugin: {
                              name: "barman-cloud.cloudnative-pg.io",
                              enabled: true, // needed otherwise ArgoCD complains about being OutOfSync
                              isWalArchiver: false, // needed otherwise ArgoCD complains about being OutOfSync
                              parameters: { barmanObjectName: "startsch-backups", serverName: "startsch-db" },
                          },
                      },
                  ],
              }
            : {}),
        bootstrap:
            bootstrapMode == "initdb"
                ? {
                      initdb: {
                          database: "startsch",
                          owner: "startsch",
                      },
                  }
                : {
                      recovery: {
                          source: "backblaze-backup",
                          database: "startsch",
                          owner: "startsch",
                      },
                  },
        ...(enableBackup
            ? {
                  plugins: [
                      {
                          name: "barman-cloud.cloudnative-pg.io",
                          enabled: true, // needed otherwise ArgoCD complains
                          isWalArchiver: true,
                          parameters: { barmanObjectName: "startsch-backups" },
                      },
                  ],
              }
            : {}),
    };

    new cnpg.Cluster(scope, "startsch-db", { ...clusterProps, spec });

    if (enableBackup) {
        new cnpg.ScheduledBackup(scope, "startsch-backup", {
            metadata: { name: "startsch-backup" },
            spec: {
                cluster: { name: "startsch-db" },
                schedule: "0 24 3 * * *", // At 3:24 every day
                backupOwnerReference: cnpg.ScheduledBackupSpecBackupOwnerReference.SELF,
                method: cnpg.ScheduledBackupSpecMethod.PLUGIN,
                pluginConfiguration: { name: "barman-cloud.cloudnative-pg.io" },
            },
        });
    }

    new kube.KubeDeployment(scope, "startsch-deployment", {
        metadata: { name: "startsch", labels },
        spec: {
            replicas: 1,
            selector: { matchLabels: labels },
            template: {
                metadata: { labels },
                spec: {
                    containers: [
                        {
                            name: "startsch",
                            image: versions.image,
                            imagePullPolicy: "Always",
                            ports: [{ containerPort: 8080, protocol: "TCP", name: "http" }],
                            env: [
                                {
                                    name: "DBHOST",
                                    valueFrom: { secretKeyRef: { name: "startsch-db-app", key: "host" } },
                                },
                                {
                                    name: "DBNAME",
                                    valueFrom: { secretKeyRef: { name: "startsch-db-app", key: "dbname" } },
                                },
                                {
                                    name: "DBUSER",
                                    valueFrom: { secretKeyRef: { name: "startsch-db-app", key: "user" } },
                                },
                                {
                                    name: "DBPASSWORD",
                                    valueFrom: { secretKeyRef: { name: "startsch-db-app", key: "password" } },
                                },
                                {
                                    name: "ConnectionStrings__Postgres",
                                    value: "Host=$(DBHOST); Database=$(DBNAME); Username=$(DBUSER); Password=$(DBPASSWORD);",
                                },
                            ],
                            envFrom: [
                                { configMapRef: { name: "startsch-config" } },
                                { secretRef: { name: "startsch-secrets" } },
                            ],
                            resources: {
                                limits: {
                                    cpu: kube.Quantity.fromString("500m"),
                                    memory: kube.Quantity.fromString("500Mi"),
                                    "ephemeral-storage": kube.Quantity.fromString("200Mi"),
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

    new kube.KubeIngress(scope, "startsch-ingress", {
        metadata: {
            name: "startsch",
            annotations: {
                "cert-manager.io/cluster-issuer": "letsencrypt",
                "acme.cert-manager.io/http01-ingress-class": "traefik",
            },
        },
        spec: {
            ingressClassName: "traefik",
            tls: [{ hosts: ["start.sch.bme.hu"], secretName: "startsch-tls-cert" }],
            rules: [
                {
                    host: "start.sch.bme.hu",
                    http: {
                        paths: [
                            {
                                path: "/",
                                pathType: "Prefix",
                                backend: {
                                    service: {
                                        name: "startsch",
                                        port: { name: "http" },
                                    },
                                },
                            },
                        ],
                    },
                },
            ],
        },
    });
});
