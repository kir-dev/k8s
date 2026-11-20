// https://github.com/kir-dev/tanulo-next
//
// https://tanulo.sch.bme.hu/
//
// Maintainer: Fekete Sámuel

import { createKirDevApp } from "../.dev/kir-dev-app.ts";

const app = createKirDevApp("tanulosch", {
    namespace: "tanulosch",
    createNamespace: true,
});

export default app.build();
