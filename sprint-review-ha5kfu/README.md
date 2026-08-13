# Sprint Review – HA5KFU instance

This directory defines an isolated Sprint Review App v2 instance. ArgoCD's
top-level `ApplicationSet` discovers it as the `sprint-review-ha5kfu`
application and renders the listed resources through Kustomize.

## Instance values

| Setting | Current value |
| --- | --- |
| Namespace / instance label | `sprint-review-ha5kfu` |
| Frontend host | `ha5kfu.sprint-review.kir-dev.hu` |
| Backend host | `api.ha5kfu.sprint-review.kir-dev.hu` |
| Internal backend URL | `http://sprint-review-ha5kfu-backend` |
| AuthSCH callback | `https://api.ha5kfu.sprint-review.kir-dev.hu/auth/callback` |
| Database cluster | `sprint-review-ha5kfu-db` |
| Harbor pull Secret | `harbor-secret` |

## ArgoCD ordering and migrations

All resources belong to one ArgoCD Application, including the CNPG database.
The sync waves enforce this order:

1. namespace (`-30`);
2. CNPG cluster (`-20`);
3. Prisma migration Job (`-10`);
4. application Deployments, Services and Ingresses (`0`).

The migration is a blocking ArgoCD `Sync` hook instead of a literal `PreSync`
hook. This is intentional: on the first deployment, a `PreSync` Job would run
before the CNPG resource exists and would deadlock the sync. ArgoCD waits for
the CNPG cluster to become healthy, then runs:

```text
yarn workspace backend prisma:migrate:deploy
```

The backend Deployment cannot roll out if this Job fails. The backend runtime
image must therefore contain `apps/backend/prisma`, all migrations, the Prisma
CLI/runtime, and the generated client. The migration and backend Deployment
image tags must always be identical. An init container additionally waits for
the CNPG read-write Service to accept connections, so the migration does not
depend on ArgoCD having a custom CNPG health assessment.

## Externally managed Secrets

Following the existing StartSCH pattern, ArgoCD creates the metadata-only
`sprint-review-ha5kfu-backend-secrets` resource, while its values are populated
outside Git with exactly:

- `AUTHSCH_CLIENT_ID`;
- `AUTHSCH_CLIENT_SECRET`;
- `JWT_SECRET`;
- `SESSION_SECRET`.

`JWT_SECRET` and `SESSION_SECRET` must be strong, instance-specific and
different. CNPG creates `sprint-review-ha5kfu-db-app`; the backend and migration
Job read its `uri` key. The namespace-local `harbor-secret` must also exist
before image pull.

Because the ApplicationSet uses server-side apply and the manifest omits
`.data`, ArgoCD owns the Secret metadata but not the externally populated data
fields. Kubernetes injects `secretKeyRef` environment variables when a
container starts; it does not hot-reload them in an already running process.
Therefore:

- populate the backend credential Secret before the backend container starts;
- create `harbor-secret` before the first private image pull;
- rotate backend values by updating the Secret and then rolling the backend pod;
- leave the CNPG-generated database Secret to the operator.

The cluster currently exposes no External Secrets or Sealed Secrets CRD, so
the values and the Harbor pull Secret must be created by the platform or another
out-of-band secure process. A metadata-only Docker registry Secret is invalid,
so `harbor-secret` cannot use the same placeholder pattern. Raw values must not
be committed to this repository.

## CNPG backups

The repository's StartSCH deployment uses the Barman Cloud plugin with a
dedicated Backblaze B2 bucket, an `ObjectStore`, a `ScheduledBackup`, and WAL
archiving. HA5KFU must use its own bucket and credentials; it must not reuse the
StartSCH bucket.

`cnpg-backup-resources.example.yaml` contains the matching ObjectStore and daily
backup schedule, but it is intentionally excluded from Kustomize. To enable it:

1. create a dedicated S3-compatible bucket and record its exact endpoint;
2. securely create `sprint-review-ha5kfu-backups-secrets` with
   `ACCESS_KEY_ID` and `ACCESS_SECRET_KEY` before enabling WAL archiving;
3. replace the two placeholders in the example and rename it to
   `cnpg-backup.yaml`;
4. add `cnpg-backup.yaml` to `kustomization.yaml`;
5. add the following settings to the CNPG Cluster:

```yaml
spec:
  postgresql:
    parameters:
      archive_timeout: "1200"
  plugins:
    - name: barman-cloud.cloudnative-pg.io
      enabled: true
      isWALArchiver: true
      parameters:
        barmanObjectName: sprint-review-ha5kfu-backups
```

Enable the plugin only after the ObjectStore credential works. Otherwise failed
WAL uploads can accumulate on the 1.5 GiB database volume and eventually stall
PostgreSQL. After enabling it, verify ObjectStore health and run a manual Backup
before relying on the schedule.

## Network boundaries

This instance ships no `NetworkPolicy`, matching the other applications in this
repository (`startsch`, `place`).

An earlier revision did define a default-deny policy set with explicit allow
rules. It could not work in this cluster: the vClusters are nested
(`-x-vc2-x-vc2-x-vc-kirdev`), and with `sync.toHost.networkPolicies` only
egress rules whose peer is a `podSelector` in the *same* namespace survive the
translation to the host cluster. Rules pointing outside the namespace are lost,
so DNS to `kube-system` was denied no matter how the rule was written —
verified with a selector peer, a peer-less port-only rule, and `ipBlock` peers
covering both the Service and Pod CIDRs. The same class of failure would have
hit the AuthSCH egress rule and the Traefik ingress rules. Reintroduce
policies only once the platform supports cross-namespace peers here.

The backend Ingress publishes only the exact `/auth/login` and `/auth/callback`
paths. Normal API calls use the frontend's same-origin `/api/*` proxy and the
cluster-local backend Service.

## Required before ArgoCD sync

1. Create/manage the backend credential and Harbor pull Secrets described above.
2. Register the exact AuthSCH callback URL.
3. Point both DNS names at the cluster ingress.
4. Configure the instance-specific object store before enabling CNPG backups.

Both immutable images are already digest-pinned in `kustomization.yaml` and were
successfully pulled during manifest verification. The backend image is amd64,
runs as UID 1000, uses the expected direct Node entrypoint, and contains the
Prisma schema, migrations, and `prisma:migrate:deploy` script.

## Verification

Render and client-validate the manifests with:

```bash
kubectl kustomize sprint-review-ha5kfu
kubectl kustomize sprint-review-ha5kfu \
  | kubectl apply --dry-run=client --validate=false -f -
```

After sync, verify frontend health, backend live/ready behavior during a database
failure, AuthSCH login/callback, `/api/auth/me`, image upload, migration failure
blocking, and denied undeclared network paths.
