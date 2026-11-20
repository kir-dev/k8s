# Example (`example-k8s`)

> **Maintenance Rule:** Update this documentation whenever infrastructure, configuration, dependencies, or deployment workflows change.  
> **Last Updated:** 2026-11-20 by [@TGyAkos](https://github.com/tgyakos)

---

## 1. Overview & Public URLs

- **Repository:** [github.com/kir-dev/example](https://github.com/kir-dev/example)
- **Production URL(s):** [Frontend](https://example.sch.bme.hu), [Backend](https://api.example.sch.bme.hu)
- **Maintainer:** Tamáskovits Gyula Ákos
- **Personal & Private Info:** [Simonyi Wiki — Example](https://wiki.simonyi.bme.hu/kir-dev/projects/example)

<!-- If images are added to this documentation, upload them to Warp and reference the Warp URL (e.g., https://warp.sch.bme.hu/images/example-k8s-architecture.png). -->

---

## 2. Deployment Documentation

### Services Used

| Component | Technology / Service | Purpose |
| :--- | :--- | :--- |
| **Frontend** | React | Web UI (`example.sch.bme.hu`) |
| **Backend** | NestJS | REST API (`api.example.sch.bme.hu`) |
| **Database** | PostgreSQL 16 (CloudNativePG) | Primary data store |
| **Cache** | Redis 7 | Session & cache store |
| **Auth** | AuthSCH | Authentication (OAuth2) |
| **Orchestration** | Kir-Dev Kubernetes & ArgoCD | Hosting & GitOps deployment |

### Hosting Environment

- **Host / Environment:** Kir-Dev Kubernetes cluster, namespace `example-k8s` ([ArgoCD Application](https://argocd.kir-dev.hu/applications/example-k8s), [Grafana Logs & Metrics](https://grafana.kir-dev.hu/d/k8s-namespace?var-namespace=example-k8s))
- **Hosted By:** Kir-Dev

### Configuration Files

- **Repository Configs:** [`./app.ts`](./app.ts), [`./manifests/`](./manifests/)
- **Server / Runtime Config Location:** Sealed Secrets in [`./manifests/secrets.yaml`](./manifests/secrets.yaml) (unencrypted values are stored on the [Simonyi Wiki](https://wiki.simonyi.bme.hu/kir-dev/projects/example#secrets))
- **GUI Platform Settings:** [ArgoCD Application Settings](https://argocd.kir-dev.hu/applications/example-k8s), [AuthSCH Developer Console](https://auth.sch.bme.hu/console)

### Step-by-Step Deployment Instructions

1. **Verify cluster access and check the current namespace state:**
   ```bash
   kubectl get all -n example-k8s
   ```

2. **Pull the latest changes in the `k8s` repository and update secrets (if environment variables changed):**
   ```bash
   git pull origin main
   kubectl create secret generic example-env \
     --namespace example-k8s \
     --from-env-file=.env.production \
     --dry-run=client -o yaml | kubeseal --format yaml > example-k8s/manifests/secrets.yaml
   ```

3. **Update image tags or configuration in `./app.ts` (or `./manifests/`), then commit and push to trigger ArgoCD sync:**
   ```bash
   git add example-k8s/
   git commit -m "chore(example-k8s): update deployment config"
   git push origin main
   ```

4. **Monitor the rollout, run database migrations (if needed), and verify health:**
   ```bash
   kubectl rollout status deployment/example-backend -n example-k8s
   kubectl rollout status deployment/example-frontend -n example-k8s
   kubectl exec -n example-k8s deploy/example-backend -- npx prisma migrate deploy
   curl -I [https://api.example.sch.bme.hu](https://api.example.sch.bme.hu)
   curl -I [https://example.sch.bme.hu](https://example.sch.bme.hu)
   ```

---

## 3. Update & Upgrade Documentation

### Known Incompatibilities

- **Node.js 23+:** Native dependencies (`bcrypt` and the current Prisma query engine) fail to build on Node.js 23 and newer due to V8/N-API breaking changes. Do not upgrade past Node.js 22 until `prisma` is upgraded to `v6+`.
- **PostgreSQL 17:** Full-text search migration `20241103_search_idx` relies on `pg_trgm` behavior that changed in PostgreSQL 17 and must be rewritten before a major database upgrade.

### Deliberate Version Pins

- **Node.js (`22.10.x-alpine`):** Pinned in the Docker base image to avoid native module build regressions in newer releases.
- **PostgreSQL (`16.4`):** Pinned for CloudNativePG backup compatibility and full-text search index stability.
- **Redis (`7.2.x`):** Pinned to the last BSD-licensed release prior to the RSALv2/SSPL license change.

### Order of Operations for Updates & Upgrades

1. **Database Backup & Backing Services:** Take a PostgreSQL dump before upgrading PostgreSQL or Redis.
   ```bash
   kubectl exec -n example-k8s example-db-1 -- pg_dump -U postgres example > backup-$(date +%F).sql
   ```
2. **Database Migrations:** Apply backward-compatible Prisma migrations before deploying new application images.
3. **Backend (`api.example.sch.bme.hu`):** Update the backend image tag in `./app.ts`, wait for the Kubernetes rollout to finish, and verify `/health`.
4. **Frontend (`example.sch.bme.hu`):** Update the frontend image tag in `./app.ts` once the backend is healthy and verify AuthSCH login end-to-end.
