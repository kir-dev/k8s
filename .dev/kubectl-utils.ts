import { $ } from "bun";
import { App } from "cdk8s";

export interface KubectlApplyOptions {
    serverSide?: boolean;
}

export async function kubectlApplyYaml(yaml: string, options: KubectlApplyOptions = {}) {
    const flags = options.serverSide ? ["--server-side"] : [];
    await $`kubectl apply ${flags} -f - < ${Buffer.from(yaml)}`;
}

export async function kubectlApplyCdk8sApp(app: App, options: KubectlApplyOptions = {}) {
    await kubectlApplyYaml(app.synthYaml(), options);
}
