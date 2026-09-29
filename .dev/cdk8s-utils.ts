import { App, Chart } from "cdk8s";
import { Construct } from "constructs";
import { KubeNamespace } from "../imports/k8s";

interface SingletonAppOptions {
    namespace: string;
    createNamespace?: boolean;
}

// Helper for cdk8s apps that can only have a single instance in the cluster.
//
// Always specify resource metadata.name so that cdk8s doesn't generate it.
export function singletonApp(options: SingletonAppOptions, factory: (scope: Construct) => void): App {
    const app = new App();
    const chart = new Chart(app, "chart", { namespace: options.namespace });
    if (options.createNamespace) {
        const namespaceChart = new Chart(app, "namespace");
        new KubeNamespace(namespaceChart, "namespace", { metadata: { name: options.namespace } });
    }
    factory(chart);
    return app;
}
