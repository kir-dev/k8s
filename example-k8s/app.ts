// https://github.com/kir-dev/example
//
// https://example.sch.bme.hu
// https://api.example.sch.bme.hu
//
// Maintainer: Tamáskovits Gyula Ákos

import { createKirDevApp } from "../.dev/kir-dev-app.ts";

const app = createKirDevApp("example-k8s", {
    namespace: "example-k8s",
    createNamespace: true,
});

export default app.build();
