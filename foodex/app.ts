// https://github.com/kir-dev/foodex-web
//
// https://foodex.sch.bme.hu
// https://api.foodex.sch.bme.hu
//
// Spring Boot backend (H2 file database) + Next.js frontend.

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

// AuthSCH client credentials are filled in manually:
//   FOODEX_AUTHSCH_ID
//   FOODEX_AUTHSCH_KEY
const secrets = app.appSecrets();

const backendName = "foodex-backend";
const backendLabels = {
    ...app.labels,
    "app.kubernetes.io/component": "backend",
};

// The backend keeps its H2 database on a volume, so it runs as a single-replica
// StatefulSet instead of a Deployment.
new kube.KubeService(app.scope, `${backendName}-service`, {
    metadata: { name: backendName, labels: backendLabels },
    spec: {
        selector: backendLabels,
        ports: [{ name: "http", port: 80, targetPort: kube.IntOrString.fromString("http") }],
    },
});

new kube.KubeStatefulSet(app.scope, `${backendName}-statefulset`, {
    metadata: { name: backendName, labels: backendLabels },
    spec: {
        serviceName: backendName,
        replicas: 1,
        selector: { matchLabels: backendLabels },
        template: {
            metadata: { labels: backendLabels },
            spec: {
                automountServiceAccountToken: false,
                containers: [
                    {
                        name: "backend",
                        image: versions.backend,
                        imagePullPolicy: "Always",
                        ports: [{ name: "http", containerPort: 8080, protocol: "TCP" }],
                        env: [
                            {
                                name: "FOODEX_AUTHSCH_ID",
                                valueFrom: {
                                    secretKeyRef: {
                                        name: secrets,
                                        key: "FOODEX_AUTHSCH_ID",
                                        optional: !production || undefined,
                                    },
                                },
                            },
                            {
                                name: "FOODEX_AUTHSCH_KEY",
                                valueFrom: {
                                    secretKeyRef: {
                                        name: secrets,
                                        key: "FOODEX_AUTHSCH_KEY",
                                        optional: !production || undefined,
                                    },
                                },
                            },
                            { name: "FOODEX_BASEURL", value: "https://api.foodex.sch.bme.hu/" },
                            { name: "FOODEX_FRONTEND_URL", value: "https://foodex.sch.bme.hu" },
                            { name: "FOODEX_DATA_SOURCE", value: "jdbc:h2:file:/data/foodex" },
                            { name: "LOGGING_LEVEL_HU_KIRDEV_FOODEX", value: "INFO" },
                        ],
                        startupProbe: {
                            httpGet: { path: "/api/homepage", port: kube.IntOrString.fromString("http") },
                            periodSeconds: 5,
                            timeoutSeconds: 3,
                            failureThreshold: 60,
                        },
                        readinessProbe: {
                            httpGet: { path: "/api/homepage", port: kube.IntOrString.fromString("http") },
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
                        volumeMounts: [{ name: "data", mountPath: "/data" }],
                    },
                ],
            },
        },
        volumeClaimTemplates: [
            {
                metadata: { name: "data", labels: backendLabels },
                spec: {
                    accessModes: ["ReadWriteOnce"],
                    storageClassName: storageClass(ProdStorageClass.memorySsd, DevStorageClass.localPath),
                    resources: {
                        requests: { storage: kube.Quantity.fromString("2Gi") },
                    },
                },
            },
        ],
    },
});

app.publish("api.foodex.sch.bme.hu", {
    name: backendName,
    paths: [{ path: "/", service: backendName, port: "http" }],
});

// NEXT_PUBLIC_API_URL is baked in at build time and defaults to the API host
// above, so the frontend needs no runtime environment.
const frontend = app.addDocker({
    name: "foodex-frontend",
    image: versions.frontend,
    imagePullPolicy: "Always",
    startupProbe: { path: "/", periodSeconds: 5, timeoutSeconds: 3, failureThreshold: 30 },
    readinessProbe: { path: "/", periodSeconds: 10, timeoutSeconds: 3, failureThreshold: 3 },
    livenessProbe: { periodSeconds: 20, timeoutSeconds: 3, failureThreshold: 6 },
    resources: {
        limits: {
            cpu: "500m",
            memory: "512Mi",
            "ephemeral-storage": "200Mi",
        },
        requests: {
            cpu: "50m",
            memory: "128Mi",
            "ephemeral-storage": "0",
        },
    },
});

frontend.port(3000).publish("foodex.sch.bme.hu");

export default app.build();
