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
const db = app.addPostgres({

});
const s3 = app.addGarage();
const server = app.addDocker({
    env: {
        Logging: "Warning",
        S3:
        ConnectionString: `Host=${db.host}...`,
        ...manualSecrets([
            "AuthSch__Secret"
        ])
    }
});
```
