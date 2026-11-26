# Kir-Dev Website (`kir-dev.hu`)

> **Maintenance Rule:** Update this documentation whenever infrastructure, configuration, dependencies, or deployment workflows change.  
> **Last Updated:** 2026-11-26

---

## 1. Overview & Public URLs

- **Repository:** [github.com/kir-dev/blog-v3](https://github.com/kir-dev/blog-v3)
- **Production URL(s):** [Website](https://kir-dev.hu), [Payload CMS Admin](https://kir-dev.hu/admin)
- **Maintainer:** Kir-Dev (see [Simonyi Wiki](https://wiki.simonyi.bme.hu/kir-dev/projects/blog-v3))
- **Personal & Private Info:** [Simonyi Wiki — blog-v3](https://wiki.simonyi.bme.hu/kir-dev/projects/blog-v3)

---

## 2. Deployment Documentation

### Services Used

| Component | Technology / Service | Purpose |
| :--- | :--- | :--- |
| **Web & CMS** | Next.js 15 + PayloadCMS v3 (`ghcr.io/kir-dev/kir-dev.hu`) | Public website (`kir-dev.hu`) and embedded admin UI (`/admin`) |
| **Database** | PostgreSQL 17.5 (CloudNativePG) | Primary CMS & application data store |
| **Object Storage** | Garage S3 (`kir-dev-hu-media` bucket) | Uploaded media assets served via Payload S3 storage plugin |
| **Off-site Backups** | Backblaze B2 (`kir-dev-hu-backups`) | Barman Cloud WAL/DB backups (`postgres/`) & VolSync/restic Garage backups (`restic/`) |
| **Orchestration** | Kir-Dev Kubernetes & ArgoCD | Hosting & GitOps deployment |

### Hosting Environment

- **Host / Environment:** Kir-Dev Kubernetes cluster (`vc2` inside `vc-kirdev`), namespace `kir-dev-hu` ([ArgoCD Application](https://argocd.kir-dev.hu/applications/kir-dev.hu))
- **Hosted By:** Kir-Dev

### Configuration Files

- **Repository Configs:** [`./app.ts`](./app.ts), [`./versions.ts`](./versions.ts), [`./renovate.ts`](./renovate.ts)
- **Application CI/CD:** [`kir-dev/blog-v3/.github/workflows/deploy.yml`](https://github.com/kir-dev/blog-v3/blob/main/.github/workflows/deploy.yml)
- **Runtime Secrets:** Populated manually in namespace `kir-dev-hu`:
  - `kir-dev-hu-secrets`: `PAYLOAD_SECRET` (required), `NEXT_PUBLIC_PLAUSIBLE_URL` (optional)
  - `kir-dev-hu-backups-secrets`: `ACCESS_KEY_ID`, `ACCESS_SECRET_KEY` (Backblaze B2 credentials for Postgres backups)
  - `kir-dev-hu-s3-backup-secrets-data` / `kir-dev-hu-s3-backup-secrets-metadata`: Backblaze B2 / restic credentials for Garage volume backups

### Step-by-Step Deployment Instructions

1. **Populate the manually managed secrets in the `kir-dev-hu` namespace after ArgoCD creates the namespace:**
   ```bash
   kubectl -n kir-dev-hu patch secret kir-dev-hu-secrets --type merge -p "$(
     jq -n --arg secret "$(openssl rand -hex 32)" '{stringData: {PAYLOAD_SECRET: $secret}}'
   )"
   ```
   Also populate `kir-dev-hu-backups-secrets`, `kir-dev-hu-s3-backup-secrets-data`, and `kir-dev-hu-s3-backup-secrets-metadata` with the `kir-dev-hu-backups` Backblaze B2 credentials (stored on the Simonyi Wiki).

2. **Wait for the database, Garage S3, and app deployment to become ready:**
   ```bash
   kubectl -n kir-dev-hu get cluster,garagecluster,deploy,pods
   kubectl -n kir-dev-hu rollout status deployment/kir-dev-hu
   ```
   Payload automatically applies PostgreSQL migrations on startup via `prodMigrations`.

3. **One-time Sanity -> PayloadCMS data migration (initial cutover):**
   Port-forward the CNPG primary and Garage S3 service locally, then run the idempotent migration script from `kir-dev/blog-v3`:
   ```bash
   kubectl -n kir-dev-hu port-forward svc/kir-dev-hu-db-rw 5432:5432 &
   kubectl -n kir-dev-hu port-forward svc/kir-dev-hu-garage 3900:3900 &

   DATABASE_URI="$(kubectl -n kir-dev-hu get secret kir-dev-hu-db-app -o jsonpath='{.data.uri}' | base64 -d | sed 's/kir-dev-hu-db-rw/127.0.0.1/')" \
   PAYLOAD_SECRET="$(kubectl -n kir-dev-hu get secret kir-dev-hu-secrets -o jsonpath='{.data.PAYLOAD_SECRET}' | base64 -d)" \
   S3_ENDPOINT="http://127.0.0.1:3900" \
   S3_BUCKET="kir-dev-hu-media" \
   S3_REGION="us-east-1" \
   S3_ACCESS_KEY_ID="$(kubectl -n kir-dev-hu get secret kir-dev-hu-garage-s3 -o jsonpath='{.data.access-key-id}' | base64 -d)" \
   S3_SECRET_ACCESS_KEY="$(kubectl -n kir-dev-hu get secret kir-dev-hu-garage-s3 -o jsonpath='{.data.secret-access-key}' | base64 -d)" \
   SANITY_API_TOKEN="<sanity-read-token>" \
   yarn migrate:from-sanity
   ```

4. **Create the first admin user** at `https://kir-dev.hu/admin`, verify all routes, and switch the `kir-dev.hu` DNS record to the cluster load balancer.

5. **Routine updates:**
   Pushing to `main` in `kir-dev/blog-v3` builds `ghcr.io/kir-dev/kir-dev.hu:v0.0.<run>` and runs `bun run renovate kir-dev.hu` to open a PR updating `./versions.ts`. Merging that PR lets ArgoCD roll out the new image.

---

## 3. Update & Upgrade Documentation

### Known Incompatibilities

- **PayloadCMS v3.67.0 + Next.js 15.5.9 / React 19.2.1:** Upgrading `payload` / `@payloadcms/*` across minor versions may require upgrading `next` and `react` in lockstep (e.g., Payload >= 3.70+ tightens Next.js peer ranges). Always test `yarn build` and `yarn migrate` together before bumping.

### Deliberate Version Pins

- **PostgreSQL (`ghcr.io/cloudnative-pg/postgresql:17.5`):** Pinned so CloudNativePG Barman backups remain restorable without major/minor version mismatches (matching `ehk`).
- **Node.js (`22-bookworm-slim`):** Pinned in `kir-dev/blog-v3/Dockerfile` for `sharp` and Next.js 15 standalone builds.
- **PayloadCMS (`3.67.0`) & Next.js (`15.5.9`):** Pinned in `kir-dev/blog-v3/package.json` to match Kir-Dev's tested PayloadCMS stack (`ehk`).

### Order of Operations for Updates & Upgrades

1. **Backups:** Verify recent CNPG (`kubectl -n kir-dev-hu get backup`) and VolSync (`kubectl -n kir-dev-hu get replicationsource`) backups succeeded before major upgrades.
2. **Application & Schema Migrations:** Commit new Payload migrations (`yarn migrate:create`) in `kir-dev/blog-v3` before deploying the new image; Payload runs `prodMigrations` automatically during container startup before the `/admin` readiness probe passes.
3. **Database Major Upgrades:** Follow CNPG major upgrade / dump-and-restore procedures in `../backup.md`.
