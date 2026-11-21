// https://github.com/kir-dev/konzisite-frontend
// https://github.com/kir-dev/konzisite-api
//
// https://konzi.vik.hk/
// https://api.konzisite.kir-dev.hu/
//
// Maintainer: Fekete Sámuel

import { createKirDevApp } from "../.dev/kir-dev-app.ts";

const app = createKirDevApp("konzisite", {
    namespace: "konzisite",
    createNamespace: true,
});

export default app.build();
