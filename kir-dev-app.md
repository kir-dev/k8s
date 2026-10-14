minimal required config:
- app name: startsch
- docker image: ghcr.io/... from versions.ts
- http port
- public URL: start.sch.bme.hu
- backblaze:
  - key id, key (in a secret)
  - endpoint, bucket name (I assume region is not needed)
- postgres connection: which env var(s), which format
- s3 connection: which env var(s), which format
- backups: cron
- postgres version
- resources: app, db, s3

additional config when restoring:
- restore phase

everything else implicit?

example:
```ts
const app = createKirDevApp("startsch");
const backblaze = createBackblaze({
    ...
});
const db = app.addPostgres("db", {
    backup: {
        provider: backblaze.withPrefix("postgres"),
        phase: "runningAfterRestore",
    }
});
const s3 = app.addGarage("s3", {
    backup: {
        provider: backblaze.withPrefix("garage"),
        phase: "runningAfterRestore",
    },
});
const server = app.addDocker("server", {
    env: {
        Logging: "Warning",
        S3: s3.whatever,
        ConnectionString: `Host=${db.host}...`,
        AuthSch__Secret: manualSecret(),
    }
});
```
