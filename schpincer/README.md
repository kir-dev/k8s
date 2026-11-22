# SCH-PINCÉR (`schpincer`)

> **Maintenance Rule:** Update this documentation whenever infrastructure, configuration, dependencies, or deployment workflows change.
> **Last Updated:** 2026-11-22 by [@MiklosBacsi](https://github.com/MiklosBacsi)

---

## 1. Overview & Public URLs

- **Repository:** [github.com/kir-dev/sch-pincer](https://github.com/kir-dev/sch-pincer)
- **Production URL(s):** [schpincer.sch.bme.hu](https://schpincer.sch.bme.hu)
- **Maintainer:** Bácsi Miklós
- **Personal & Private Info:** Simonyi Wiki (TODO: link the SCH-PINCÉR page once it exists)

Food ordering website for the Schönherz Dormitory: circles (Americano, PizzaSCH, Lángosch, ...) open
time windows and residents order from them.

---

## 2. Deployment Documentation

### Services Used

| Component | Technology / Service | Purpose |
| :--- | :--- | :--- |
| **Web app** | Spring Boot 4 (Kotlin, Java 25), server-side rendered with Thymeleaf | UI and `/api` (`schpincer.sch.bme.hu`) |
| **Database** | PostgreSQL 18 (CloudNativePG, 2 instances) | Primary data store; schema managed by Hibernate (`ddl-auto=update`) |
| **File storage** | `schpincer-uploads` PVC (`memory-ssd`, 2Gi) mounted at `/permanent/external` | Uploaded item images, circle logos/backgrounds, avatars, served from `/cdn/**` |
| **Backups** | Backblaze B2 bucket `schpincer-backups` | Barman (`postgres/`) and VolSync/restic (`restic/schpincer-uploads`) |
| **Auth** | AuthSCH (OAuth2/OIDC) | Login |
| **Ingress** | Traefik + cert-manager (Let's Encrypt) | `schpincer.sch.bme.hu`; `/actuator` is blocked with a `deny-all` middleware because the app exposes every actuator endpoint without authentication |
| **Container image** | `ghcr.io/kir-dev/schpincer` | Built by the app repo's GitHub Actions |
| **Orchestration** | Kir-Dev Kubernetes (`vc2` vCluster) & Argo CD | Hosting & GitOps deployment |

### Hosting Environment

- **Host / Environment:** Kir-Dev Kubernetes cluster (`vc2` vCluster inside `vc-kirdev` at [KSZK](https://kszk.bme.hu),
  see the [repo README](../README.md#production-cluster)), namespace `schpincer`, Argo CD Application `schpincer`
- **Hosted By:** Kir-Dev

### Configuration Files

- **Repository Configs:**
  - [`./app.ts`](./app.ts): Postgres, the Deployment, the uploads volume, backups, Ingress
  - [`./versions.ts`](./versions.ts): the image version; updated by Renovate PRs
  - [`./renovate.ts`](./renovate.ts): Renovate config, run from the app repo's CI
  - App repo: [`docker/Dockerfile`](https://github.com/kir-dev/sch-pincer/blob/master/docker/Dockerfile),
    [`application.properties`](https://github.com/kir-dev/sch-pincer/blob/master/src/main/resources/config/application.properties),
    [`application-env.properties`](https://github.com/kir-dev/sch-pincer/blob/master/src/main/resources/config/application-env.properties)
    (the image always enables the `env` and `production` profiles),
    [`.github/workflows/deploy.yml`](https://github.com/kir-dev/sch-pincer/blob/master/.github/workflows/deploy.yml)
- **Server / Runtime Config Location:** Non-secret env vars are in `app.ts` (rendered into the `schpincer-config`
  ConfigMap). The Database credentials come from the `schpincer-db-app` Secret that CNPG generates. Everything else is
  filled in by hand in these Secrets (Argo CD creates them empty; the values belong on the Simonyi Wiki):

  | Secret | Keys |
  | --- | --- |
  | `schpincer-secrets` | `SCHPINCER_AUTHSCH_ID`, `SCHPINCER_AUTHSCH_KEY` (required); `SCHPINCER_SYSADMINS`, `API_TOKENS` (optional) |
  | `schpincer-db-backup-secrets` | `ACCESS_KEY_ID`, `ACCESS_SECRET_KEY` (B2 application key) |
  | `schpincer-uploads-backup-secrets` | `RESTIC_PASSWORD`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` (B2 application key) |

- **GUI Platform Settings:** [AuthSCH console](https://auth.sch.bme.hu/console) (redirect URL:
  `https://schpincer.sch.bme.hu/login/oauth2/code/authsch`), Backblaze B2 (`schpincer-backups` bucket),
  the app repo's Actions secrets (`KIR_DEV_BOT_PAT`)

### Step-by-Step Deployment Instructions

#### Regular deployments

1. **Merge to `master` in [kir-dev/sch-pincer](https://github.com/kir-dev/sch-pincer).** The
   [`Deploy`](https://github.com/kir-dev/sch-pincer/blob/master/.github/workflows/deploy.yml) workflow builds
   `ghcr.io/kir-dev/schpincer:v0.0.<run number>`, tags the commit, then runs Renovate, which opens/updates a
   PR here bumping [`versions.ts`](./versions.ts).
2. **Merge the Renovate PR.** Argo CD rolls out the new image. The Deployment uses the `Recreate` strategy (the
   uploads volume is ReadWriteOnce), so expect ~1 minute of downtime while the new pod starts.
3. **Verify the rollout:**
   ```bash
   kubectl -n schpincer rollout status deployment/schpincer
   curl -fsS -o /dev/null https://schpincer.sch.bme.hu/
   ```

#### First-time setup / migration from the old deployment

The old deployment is in the `kir-prod` namespace of `vc-kirdev`, applied by hand (not from Git):

| Old resource | Notes |
| --- | --- |
| StatefulSet `schpincer` | `harbor.sch.bme.hu/org-kir-dev/sch-pincer:latest`, uploads on PVC `schpincer-pv-schpincer-0` (`/permanent/external`, ~130M) |
| Helm release `schpincer-postgres` | Bitnami `postgresql` chart, Postgres 17.6, database `schpincer`, user `admin` (~30MB) |
| StatefulSet `schpincer-mysql` | Scaled to 0, unused leftover from before the Postgres migration |
| `schpincer-secrets`, `schpincer-config` | AuthSCH credentials, `API_TOKENS`, old DB credentials / base URL, cache ages |
| Ingress `schpincer` | nginx, `152.66.192.35`; sends `/actuator/` to `default-backend` (blocked, like `deny-all` here) |

The commands below use `OLD` for the `vc-kirdev` context and `NEW` for the `vc2` context
(`vcluster connect vc2 -n vc2` from `vc-kirdev` creates it):

```bash
OLD="--context <vc-kirdev-context>"
NEW="--context <vc2-context>"
```

1. **Create the Backblaze B2 bucket** `schpincer-backups` (region `eu-central-003`) and an application key restricted
   to it.

2. **Merge the PR adding `schpincer/` to this repo.** Argo CD creates the namespace, the database, the empty Secrets
   and the Deployment. The pod stays in `CreateContainerConfigError` until the Secrets are filled in.

3. **Fill in the Secrets.** The app secrets are copied from the old deployment, so no value has to be typed:
   ```bash
   kubectl $NEW -n schpincer patch secret schpincer-secrets --type merge -p "$(
     kubectl $OLD -n kir-prod get secret schpincer-secrets -o json \
       | jq '{data: (.data | {SCHPINCER_AUTHSCH_ID, SCHPINCER_AUTHSCH_KEY, API_TOKENS})}')"

   read -rp 'B2 key id: ' B2ID; read -rsp 'B2 application key: ' B2KEY; echo
   kubectl $NEW -n schpincer patch secret schpincer-db-backup-secrets --type merge \
     -p "{\"stringData\":{\"ACCESS_KEY_ID\":\"$B2ID\",\"ACCESS_SECRET_KEY\":\"$B2KEY\"}}"
   kubectl $NEW -n schpincer patch secret schpincer-uploads-backup-secrets --type merge \
     -p "{\"stringData\":{\"AWS_ACCESS_KEY_ID\":\"$B2ID\",\"AWS_SECRET_ACCESS_KEY\":\"$B2KEY\",\"RESTIC_PASSWORD\":\"$(openssl rand -base64 32)\"}}"
   # Store the RESTIC_PASSWORD on the Simonyi Wiki: without it the uploads backups cannot be restored.
   kubectl $NEW -n schpincer get secret schpincer-uploads-backup-secrets -o jsonpath='{.data.RESTIC_PASSWORD}' | base64 -d; echo

   kubectl $NEW -n schpincer rollout restart deployment/schpincer
   ```

4. **Publish the first image.** Make sure the `KIR_DEV_BOT_PAT` Actions secret is available to kir-dev/sch-pincer,
   then run the `Deploy` workflow (*Actions → Deploy → Run workflow*). Its first run publishes `v0.0.1`, which
   [`versions.ts`](./versions.ts) already points at; the Renovate PR it opens only adds the digest.

5. **Cut over** (takes a few minutes; pick a time without an active opening). Copy the uploads, stop the old app so
   nothing writes to the old database, then copy the database. Hibernate has already created an empty schema in the
   new database on first start, so drop it and restore the dump as the `schpincer` role:
   ```bash
   kubectl $OLD -n kir-prod exec schpincer-0 -- tar -C /permanent/external -cf - . \
     | kubectl $NEW -n schpincer exec -i deployment/schpincer -- tar -C /permanent/external -xf -

   kubectl $OLD -n kir-prod scale statefulset/schpincer --replicas=0

   kubectl $OLD -n kir-prod exec schpincer-postgres-postgresql-0 -c postgresql -- sh -c \
     'PGPASSWORD="$(cat /opt/bitnami/postgresql/secrets/password)" pg_dump -U admin -d schpincer -Fc --no-owner --no-acl' \
     > schpincer.dump

   PRIMARY=$(kubectl $NEW -n schpincer get pod -l cnpg.io/cluster=schpincer-db,cnpg.io/instanceRole=primary -o name)
   kubectl $NEW -n schpincer exec -i "$PRIMARY" -c postgres -- psql -U postgres -d schpincer \
     -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public AUTHORIZATION schpincer;'
   kubectl $NEW -n schpincer exec -i "$PRIMARY" -c postgres -- pg_restore -U postgres -d schpincer \
     --no-owner --no-acl --role=schpincer --exit-on-error < schpincer.dump
   kubectl $NEW -n schpincer rollout restart deployment/schpincer

   # VolSync backed up the still-empty volume when the ReplicationSource was created; if that first sync failed
   # (e.g. the restic secret wasn't filled in yet), it reuses its stale snapshot. Drop it so the next one is fresh:
   kubectl $NEW -n schpincer delete volumesnapshot volsync-schpincer-uploads-backup-src --ignore-not-found
   ```
   To roll back, scale the old StatefulSet back to 1.

6. **Test before switching DNS** (the certificate can only be issued once DNS points here, hence `-k`):
   ```bash
   curl -k --resolve schpincer.sch.bme.hu:443:152.66.192.38 https://schpincer.sch.bme.hu/
   ```

7. **Point `schpincer.sch.bme.hu` at the cluster:** change its DNS record from `152.66.192.35` (old nginx) to
   `152.66.192.38` (Traefik in `vc2`, same as `start.sch.bme.hu` and `foodex.sch.bme.hu`). Then wait for the
   certificate and log in with AuthSCH:
   ```bash
   kubectl $NEW -n schpincer get certificate schpincer-tls-cert
   curl -s -o /dev/null -w '%{http_code}\n' https://schpincer.sch.bme.hu/actuator/env   # must be 403
   ```

8. **Check the backups the next day:**
   ```bash
   kubectl $NEW -n schpincer get backups.postgresql.cnpg.io
   kubectl $NEW -n schpincer get replicationsource schpincer-uploads-backup -o jsonpath='{.status.lastSyncTime}{"\n"}'
   ```

9. **Remove the old deployment** once the new one has run fine for a while (keep `schpincer.dump` until then):
   ```bash
   helm --kube-context <vc-kirdev-context> -n kir-prod uninstall schpincer-postgres
   kubectl $OLD -n kir-prod delete ingress/schpincer statefulset/schpincer statefulset/schpincer-mysql \
     service/schpincer service/schpincer-mysql service/schpincer-mysql-headless \
     configmap/schpincer-config secret/schpincer-secrets
   kubectl $OLD -n kir-prod delete pvc schpincer-pv-schpincer-0 data-schpincer-mysql-0 data-schpincer-postgres-postgresql-0
   ```

#### Disaster recovery

- **Database:** set `restore: "latest"` in `addPostgres()` (bootstraps from the Barman backup in
  `s3://schpincer-backups/postgres/` instead of `initdb`). Recovery only happens when the `Cluster` is created, so
  delete the old `schpincer-db` Cluster first if it still exists. See `startsch/app.ts` for a running example.
- **Uploads volume:** follow the state machine in [`backup.md`](../backup.md): set `lifecycle: "restore"` on the
  volume's `backup`, delete the `schpincer-uploads` PVC if it still exists (`dataSourceRef` is immutable; Argo CD
  never deletes the PVC on its own, and it stays `Terminating` until the pod using it is gone), sync, wait for the
  `schpincer-uploads-restore-snap` VolumeSnapshot and the new PVC to be bound, then set `lifecycle: "restored"`.

---

## 3. Update & Upgrade Documentation

### Known Incompatibilities

- **Multiple replicas:** not supported. Uploads live on a ReadWriteOnce volume and HTTP sessions are kept in memory,
  so the app runs as a single pod (`Recreate` strategy, short downtime on every rollout).
- **Database schema changes** are applied by Hibernate (`ddl-auto=update`) when the new version starts. They are
  additive only (columns are never dropped or renamed) and cannot be rolled back; check entity changes before
  merging and rely on the Barman backups if a rollback is needed.

### Deliberate Version Pins

- **PostgreSQL (`ghcr.io/cloudnative-pg/postgresql:18.6-standard-trixie`):** always pin the exact image; a Barman
  backup can only be restored onto the same major version.
- **Java 25 (Temurin, `eclipse-temurin:25-*-alpine`)** in `docker/Dockerfile` and the app repo's CI.

### Order of Operations for Updates & Upgrades

1. **Database:** for a Postgres image update, make sure a recent backup exists
   (`kubectl -n schpincer get backups.postgresql.cnpg.io`), then update the image in `app.ts`. CNPG updates the
   replica first, then switches over.
2. **Application:** merge the app change; deploy the resulting Renovate PR here and verify
   that the site loads and AuthSCH login works.
