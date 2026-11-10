// https://github.com/kir-dev/foodex-web
//
// https://foodex.sch.bme.hu
// https://api.foodex.sch.bme.hu
//
// Spring Boot backend + Next.js frontend.
//
// The production instance in `vc-kirdev` runs an embedded H2 file database
// (`jdbc:h2:file:/storage/db`) on a 1 GiB `memory-ssd` PVC, backed up weekly to
// Google Drive. This app mirrors that layout so the H2 file can be copied over
// when the domain moves to `vc2`.

import * as kube from "../imports/k8s";
import * as environment from "../.dev/environment.ts";
import { createKirDevApp } from "../.dev/kir-dev-app.ts";
import { DevStorageClass, ProdStorageClass, storageClass } from "../.dev/storageClass.ts";
import { versions } from "./versions.ts";

const production = environment.environment == "Production";

const app = createKirDevApp("foodex", {
    namespace: "foodex",
    createNamespace: true,
});

const backendName = "foodex-backend";
const backendLabels = { app: backendName, "app.kubernetes.io/name": backendName };
const frontendLabels = { app: "foodex-frontend", "app.kubernetes.io/name": "foodex-frontend" };

// The same Secret names as the existing `vc-kirdev` deployment, so the
// manually filled values and the Drive backup credentials carry over.
new kube.KubeSecret(app.scope, "foodex-backend-secrets", {
    metadata: {
        name: "foodex-backend-secrets",
        annotations: {
            "argocd.argoproj.io/sync-wave": "-25",
            "argocd.argoproj.io/compare-options": "IgnoreExtraneous",
            "kir-dev.hu/required-keys": "FOODEX_AUTHSCH_ID,FOODEX_AUTHSCH_KEY",
        },
    },
});

new kube.KubeSecret(app.scope, "foodex-backend-filesystem-backup-secrets", {
    metadata: {
        name: "foodex-backend-filesystem-backup-secrets",
        annotations: {
            "argocd.argoproj.io/sync-wave": "-25",
            "argocd.argoproj.io/compare-options": "IgnoreExtraneous",
            "kir-dev.hu/required-keys": "DRIVE_ID,DRIVE_PARENT_ID,GOOGLE_SERVICE_ACCOUNT_KEY",
        },
    },
});

new kube.KubeService(app.scope, `${backendName}-service`, {
    metadata: { name: backendName, labels: backendLabels },
    spec: {
        selector: backendLabels,
        ports: [{ name: "web", port: 8080, targetPort: kube.IntOrString.fromString("web") }],
    },
});

// H2 keeps its data in a single file, so the backend must be a single-replica
// StatefulSet with a stable PVC.
new kube.KubeStatefulSet(app.scope, `${backendName}-statefulset`, {
    metadata: { name: backendName, labels: backendLabels },
    spec: {
        serviceName: "",
        replicas: 1,
        selector: { matchLabels: backendLabels },
        template: {
            metadata: {
                labels: {
                    ...backendLabels,
                    // Used by the backup CronJob's pod affinity and monitoring.
                    "foodex-backend-backup-assets": "true",
                    "monitor-spring-boot": "true",
                },
            },
            spec: {
                automountServiceAccountToken: false,
                containers: [
                    {
                        name: backendName,
                        image: versions.backend,
                        imagePullPolicy: "Always",
                        ports: [{ name: "web", containerPort: 8080, protocol: "TCP" }],
                        envFrom: [{ secretRef: { name: "foodex-backend-secrets" } }],
                        env: [
                            { name: "FOODEX_FRONTEND_URL", value: "https://foodex.sch.bme.hu" },
                            { name: "FOODEX_BASEURL", value: "https://api.foodex.sch.bme.hu/" },
                            { name: "FOODEX_DATA_SOURCE", value: "jdbc:h2:file:/storage/db" },
                        ],
                        startupProbe: {
                            httpGet: { path: "/api/homepage", port: kube.IntOrString.fromString("web") },
                            periodSeconds: 5,
                            timeoutSeconds: 3,
                            failureThreshold: 60,
                        },
                        readinessProbe: {
                            httpGet: { path: "/api/homepage", port: kube.IntOrString.fromString("web") },
                            periodSeconds: 10,
                            timeoutSeconds: 3,
                            failureThreshold: 3,
                        },
                        livenessProbe: {
                            tcpSocket: { port: kube.IntOrString.fromString("web") },
                            periodSeconds: 20,
                            timeoutSeconds: 3,
                            failureThreshold: 6,
                        },
                        resources: {
                            limits: {
                                cpu: kube.Quantity.fromString("750m"),
                                memory: kube.Quantity.fromString("1Gi"),
                                "ephemeral-storage": kube.Quantity.fromString("50Mi"),
                            },
                            requests: {
                                cpu: kube.Quantity.fromString("750m"),
                                memory: kube.Quantity.fromString("1Gi"),
                                "ephemeral-storage": kube.Quantity.fromString("50Mi"),
                            },
                        },
                        volumeMounts: [{ name: "foodex-backend-pvc", mountPath: "/storage" }],
                    },
                ],
            },
        },
        // Keep the existing template name and size: StatefulSet
        // `volumeClaimTemplates` cannot be changed after creation.
        volumeClaimTemplates: [
            {
                metadata: { name: "foodex-backend-pvc", labels: backendLabels },
                spec: {
                    accessModes: ["ReadWriteOnce"],
                    storageClassName: storageClass(ProdStorageClass.memorySsd, DevStorageClass.localPath),
                    volumeMode: "Filesystem",
                    resources: {
                        requests: { storage: kube.Quantity.fromString("1Gi") },
                    },
                },
            },
        ],
    },
});

// The existing H2 file backup: copy /storage to Google Drive every Saturday.
new kube.KubeCronJob(app.scope, "foodex-backend-filesystem-backup", {
    metadata: {
        name: "foodex-backend-filesystem-backup",
        labels: { "app.kubernetes.io/name": backendName },
    },
    spec: {
        schedule: "0 4 * * 6",
        concurrencyPolicy: "Allow",
        failedJobsHistoryLimit: 1,
        successfulJobsHistoryLimit: 3,
        jobTemplate: {
            spec: {
                template: {
                    spec: {
                        restartPolicy: "Never",
                        // Run on the node that has the backend's RWO volume.
                        affinity: {
                            podAffinity: {
                                requiredDuringSchedulingIgnoredDuringExecution: [
                                    {
                                        labelSelector: {
                                            matchLabels: { "foodex-backend-backup-assets": "true" },
                                        },
                                        topologyKey: "kubernetes.io/hostname",
                                    },
                                ],
                            },
                        },
                        containers: [
                            {
                                name: "filesystem-backup",
                                image: "harbor.sch.bme.hu/org-kir-dev/folder-backup:latest",
                                imagePullPolicy: "IfNotPresent",
                                env: [{ name: "DRIVE_FILE_NAME", value: backendName }],
                                envFrom: [{ secretRef: { name: "foodex-backend-filesystem-backup-secrets" } }],
                                volumeMounts: [{ name: "assets", mountPath: "/mounted-folder" }],
                                resources: {
                                    limits: {
                                        cpu: kube.Quantity.fromString("100m"),
                                        memory: kube.Quantity.fromString("128Mi"),
                                        "ephemeral-storage": kube.Quantity.fromString("50Mi"),
                                    },
                                    requests: {
                                        cpu: kube.Quantity.fromString("10m"),
                                        memory: kube.Quantity.fromString("64Mi"),
                                        "ephemeral-storage": kube.Quantity.fromString("0"),
                                    },
                                },
                            },
                        ],
                        volumes: [
                            {
                                name: "assets",
                                persistentVolumeClaim: {
                                    claimName: "foodex-backend-pvc-foodex-backend-0",
                                },
                            },
                        ],
                    },
                },
            },
        },
    },
});

app.publish("api.foodex.sch.bme.hu", {
    name: backendName,
    labels: { "app.kubernetes.io/name": backendName },
    tlsSecretName: "foodex-backend-api-cert",
    paths: [{ path: "/", service: backendName, port: "web" }],
});

// NEXT_PUBLIC_API_URL is baked in at build time, but keeping the ConfigMap
// matches the existing deployment.
const frontend = app.addDocker({
    name: "foodex-frontend",
    labels: frontendLabels,
    image: versions.frontend,
    imagePullPolicy: "Always",
    env: { NEXT_PUBLIC_API_URL: "https://api.foodex.sch.bme.hu" },
    startupProbe: { path: "/", periodSeconds: 5, timeoutSeconds: 3, failureThreshold: 30 },
    readinessProbe: { path: "/", periodSeconds: 10, timeoutSeconds: 3, failureThreshold: 3 },
    livenessProbe: { periodSeconds: 20, timeoutSeconds: 3, failureThreshold: 6 },
    resources: {
        limits: {
            cpu: "1",
            memory: "500Mi",
            "ephemeral-storage": "200Mi",
        },
        requests: {
            cpu: "1",
            memory: "500Mi",
            "ephemeral-storage": "0",
        },
    },
});

frontend.port(3000, "web", 3000).publish("foodex.sch.bme.hu", {
    name: "foodex-frontend",
    labels: { "app.kubernetes.io/name": "foodex" },
    tlsSecretName: "foodex-frontend-cert",
});

export default app.build();
