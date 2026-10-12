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

ideas:
- string interpolation for connection strings
  ```ts
  function f(strings: TemplateStringsArray, ...params: SecretRef) { }
  ```
