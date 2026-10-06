# Garage backups & disaster recovery

Working notes on backing up the `ehk` garage (S3) volumes off-site to Backblaze B2
and restoring them, through the nested vClusters. Written to be picked up later.

Status: **backups work and are verified; restore is implemented and was verified
end-to-end on a fresh local cluster, but the "return to normal" ergonomics and a
couple of dynamic identifiers still need work.**

Versions involved (local): k8s `v1.36.2` (k3s), vCluster `0.35.1` (nested `vc1` →
`vc2`), VolSync chart `0.16.0`, Velero chart `12.2.0` / `v1.18.2` (now removed),
garage-operator `0.7.12`.

---

## 1. What's implemented

- **`volsync/` app** — VolSync (chart `0.16.0`) in the `volsync-system` namespace,
  restic mover. CRDs ship as chart templates (no `crds/` dir).
- **`ehk/app.ts`** — per garage PVC:
  - a restic repository Secret (`garage-{data,metadata}-backup`)
  - a `ReplicationSource` (backup) when `garageBootstrap === "init"`
  - a `ReplicationDestination` + restore PVC when `garageBootstrap === "recovery"`
  - the `GarageCluster.storage.{data,metadata}.dataSourceRef` pointing at a fixed-name
    `VolumeSnapshot` in recovery mode.
- **Velero was removed** — see §4.

## 2. How backups work

Two `ReplicationSource`s in `ehk`, one per garage PVC, on a schedule
`45 3 * * *` (daily at 03:45). Each run:

1. VolSync takes a **CSI snapshot** of the source PVC (`copyMethod: Snapshot`).
2. It creates a temporary PVC from the snapshot and runs `restic backup` from it to B2.
3. Retention/prune are restic's: `retain {daily:7, weekly:4, monthly:6}`,
   `pruneIntervalDays: 7`.

Repositories (one per PVC — VolSync does not support shared repos):

- dev:  `s3://ehk-test/restic/{data,metadata}-ehk-garage-storage-0-0`
- prod: `s3://kir-dev-ehk-backups/restic/...`

Secrets (`garage-{data,metadata}-backup`): `RESTIC_REPOSITORY` and
`AWS_DEFAULT_REGION` are declared in Git; `RESTIC_PASSWORD`, `AWS_ACCESS_KEY_ID`,
`AWS_SECRET_ACCESS_KEY` are **manual** (secret manager TBD). ArgoCD is told to
ignore Secret `data` (see §7).

Verified: both sources report `Successful`; the restic repos and snapshots are in
B2; a restore reproduces the files. The **database is a separate pipeline**
(CNPG/Barman → same bucket, `postgres/` prefix) and is untouched by this.

Caveats: the two PVCs are snapshotted back-to-back, not as a single atomic pair
(Garage tolerates crash-consistency). VolSync also fires one backup when a
`ReplicationSource` is first created, not only on schedule.

## 3. Why VolSync (and why not Velero)

The original task was "Velero + volume snapshots". Three dead ends, all
environment-specific:

### 3a. Velero plain CSI snapshots don't go off-site

Velero documents it: *"only Kubernetes objects are uploaded to the object
storage, not the data in snapshots"*. The volume data stays in Ceph (prod) /
hostpath (dev). Restoring needs the original snapshot to still exist — not an
independent backup.

### 3b. Velero CSI Snapshot Data Mover is broken by vCluster

To move data off-site, Velero's built-in data mover creates an **exposer**: a
*pre-provisioned* `VolumeSnapshot` + `VolumeSnapshotContent` and a `BackupPVC`.
vCluster's VolumeSnapshot syncer can't handle this:

- `velero/pkg/exposer/csi_snapshot.go` creates the backup VS first (`:152`) and the
  VSC only afterwards (`:165`).
- vCluster's VS translator (`pkg/controllers/resources/volumesnapshots/translate.go:26-33`)
  resolves a static VS by reading the *virtual* VSC and mapping its name with
  `mapper.VirtualToHost`. For the exposer's content (which vCluster ends up
  treating as host-originated — it gets a `vcluster.loft.sh/host-volumesnapshotcontent`
  annotation) there is no virtual→host mapping, so the name comes back **empty**.
- The host VS is created with `source.volumeSnapshotContentName: ""`, never heals,
  the `BackupPVC` stays `Pending`, and the `DataUpload` stays `Accepted` forever.
- Same code on vcluster `main` — no upstream fix.

Plain **dynamic** snapshots (source = PVC) sync fine through both vClusters; only
the pre-provisioned/exposer form breaks.

### 3c. Velero File System Backup (FSB) is unsupported on vCluster

Velero's own docs: *"Some Kubernetes systems (i.e., vCluster) don't mount volumes
under the `<pod UID>` sub-dir, Velero File System Backup is not working with
them."* That's the only place Velero mentions vCluster.

**Conclusion:** Velero cannot move the volume data off-site here. VolSync's restic
mover uses the dynamic-snapshot + PVC-from-snapshot primitives, which do work.

## 4. Why not the VolSync Volume Populator either

`dataSourceRef` can point at a `ReplicationDestination` (VolSync's Volume
Populator). It **does not work** through vCluster:

- `volsync/internal/controller/volumepopulator_controller.go:414` (`rebindPVClaim`)
  rebinds by patching the **tenant** PV's `spec.claimRef`.
- vCluster's PV syncer (`pkg/controllers/resources/persistentvolumes/translate.go`)
  sets the **host** PV `claimRef = nil` on forward translate (`:16`) and overwrites
  the **virtual** PV's `claimRef` from the host (`:90`). The rebind never reaches
  the host PV controller, so the populator logs `Waiting for pv rebind` forever and
  the target PVC stays `Pending`.

**Conclusion:** don't use the RD-as-populator path. Instead use
`dataSourceRef` → a plain CSI `VolumeSnapshot` (which the CSI provisioner clones,
no rebind) — see §5.

## 5. The restore design that works

`GarageCluster.storage.{data,metadata}.dataSourceRef` is the operator's documented
*"opt-in restore source for this node's newly created PVC"* (auto nodes inherit the
parent's source). Pointing it at a **CSI `VolumeSnapshot`** makes the operator
create its own PVCs from the snapshot — which syncs correctly through vCluster.

To get a **fixed-name** `VolumeSnapshot` from the restic backup:

- VolSync names the destination snapshot from the `volsync.backube/snapname`
  annotation on the destination PVC
  (`volsync/internal/controller/volumehandler/volumehandler.go:45,234-260`).
- If we pre-set that annotation, VolSync uses our name. `EnsureImage` runs **after**
  the restore, so the snapshot captures the restored data.

So the recovery branch:

1. restore PVCs `garage-{data,metadata}-restore`, annotated
   `volsync.backube/snapname: garage-{data,metadata}-restore-snap`;
2. `ReplicationDestination` (`restic`, `destinationPVC`, `copyMethod: Snapshot`)
   restores the latest backup into them and produces the fixed-name snapshots;
3. `GarageCluster.storage.{data,metadata}.dataSourceRef` →
   the `VolumeSnapshot`s → the operator provisions its PVCs from them.

Verified end-to-end on a fresh cluster: RDs `Successful` → snapshots `readyToUse`
→ operator PVCs `Bound` → `GarageCluster` `Running`, refreshed node in layout, and
the restored metadata contained the `ehk-media` bucket.

### Identifiers: fixed vs dynamic

- **Fixed (hardcodeable):** restore PVC names, pinned snapshot names, repo paths.
  `garageSource: empty | backup` is enough — `backup` = "restore latest".
- **Dynamic (only known after restore):** `GarageBucket.spec.bucketId` and the
  `GarageKey` id. The operator refuses to manage a bucket that came back in the
  restored metadata ("already owned by untracked Garage bucket …; set
  `spec.bucketId` explicitly"). Also the **S3 secret**: the operator generates
  *new* key pairs, it cannot reproduce the restored key's secret, so the app's
  `ehk-garage-s3` secret must come from the old value (secret manager).

### Proposed state machine (not implemented)

```ts
const garageSource: "empty" | "backup" = "empty";
const garagePhase:  "restore" | "bootstrap" | "working" = "working";
```

| source | phase     | `dataSourceRef` | extra resources |
|--------|-----------|-----------------|-----------------|
| empty  | working   | —               | `ReplicationSource`s |
| backup | restore   | VS names        | RDs + restore PVCs (produce the snapshots) |
| backup | bootstrap | VS names        | (operator creates PVCs from the VS) |
| backup | working   | VS names (kept) | `ReplicationSource`s; drop RDs/restore PVCs |

Notes:
- `dataSourceRef` is **immutable after creation**, so `source=backup` → `empty` is
  one-way; keep it (it's inert once the PVCs are `Bound`). Entering `restore`
  requires the `GarageCluster` to not exist (or be recreated).
- Cleanup in `backup/working`: drop the restore PVCs + RDs but **keep the
  VolumeSnapshot** so the retained `dataSourceRef` stays valid. VolSync honors a
  "do-not-delete" label to survive RD deletion.
- Still needs the bucket/key id (+ S3 secret) supplied somehow.

## 6. garage-operator gotchas (hard-won)

- **Strict PVC ownership.** It refuses to adopt convention-named PVCs it didn't
  create: *"refusing to adopt or mutate convention-named PVC … without strong
  evidence from the live exact-owned StatefulSet; labels and annotations alone are
  not ownership."* Its PVCs carry `garage.rajsingh.info/garage-node-uid` and
  `garage.rajsingh.info/pvc-reservation-nonce`.
- **PVC finalizer is operator-only.** `garagenode.garage.rajsingh.info/pvc-reservation`
  may only be removed by the operator's service account; the
  `vmanagedpvcfinalizer.kb.io` webhook blocks even cluster admins. Force-deleting
  the `GarageNode` out-of-band orphans the reservations → the PVCs stick in
  `Terminating` forever.
- **Deleted `GarageCluster` with dependents deadlocks.** Its finalizer waits for
  `GarageBucket`/`GarageKey` to finalize first, but the operator tears down the
  StatefulSet/pods first, so the dependents can't reach the admin API.
- **Lessons:** never force-delete garage CRs/PVCs out-of-band. If the operator
  state is broken, `bun run local-cluster:down && up` is the reliable reset.
- **Declare operator defaults explicitly** or ArgoCD reports perpetual OutOfSync
  and trips the immutable-storage webhook: `spec.storage.{data,metadata}.type`,
  `spec.storage.{dataFsync,metadataFsync}` (like the existing `GarageKey` defaults).
- **Other restore hooks** (for later): `GarageNode.storage.{data,metadata}.existingClaim`
  (manual nodes only) references a pre-existing PVC.

## 7. ArgoCD / local-cluster gotchas

- ArgoCD only sees **committed, pushed** work. `bun run local-cluster:sync`
  force-pushes `HEAD` to the in-cluster git server; uncommitted changes are invisible.
- ApplicationSet needs `ignoreDifferences` on Secret `/data` + `ApplyOutOfSyncOnly=true`
  so manually-filled secrets (restic password/keys) aren't pruned/reverted.
- The cdk8s CMP sidecar (`cmp-cdk8s`) can **segfault on startup** (exit 139) →
  repo-server `CrashLoopBackOff` → the ApplicationSet can't generate apps → no
  Applications at all. Deleting the `argocd-repo-server` pod recovers it.
- The local `vcluster connect` port-forwards can die (`127.0.0.1:1xxxx: connection
  refused`). Reconnect outer→inner: `vcluster connect vc1 -n vc1` (from the k3d
  context), then `vcluster connect vc2 -n vc2`.

## 8. Recovery procedure (current code)

Preconditions:
- the `GarageCluster` must not exist (or be recreated) — `dataSourceRef` is
  creation-time only (true for namespace/cluster loss);
- the restic secrets must be present (`RESTIC_PASSWORD`, AWS keys).

Steps:
1. Ensure a good backup exists (or accept the latest snapshot in each repo).
2. Set `garageBootstrap = "recovery"` in `ehk/app.ts`, commit, push, sync.
3. Wait: RDs restore from B2 → `garage-{data,metadata}-restore-snap` become ready
   → the operator creates `data-ehk-garage-storage-0-0` / `metadata-…` from them
   → `GarageCluster` `Running`.
4. Adopt the restored bucket/key: read the restored bucket id and set
   `GarageBucket.spec.bucketId` (and the key id); otherwise the CRs are `Failed`
   and S3 returns `AccessDenied`.
5. You are now in the recovery topology (`dataSourceRef` retained); returning to a
   plain `init` layout needs the `GarageCluster` recreated (see §5).

## 9. Open questions / next steps

- **Do `GarageKey`/`GarageBucket` support predefined ids/secrets?** If yes, the
  dynamic-identifier problem collapses into static Git values. (Not yet checked.)
- Confirm the prod **VolumeSnapshotClass** name (`csi-rbdplugin-snapclass` is a
  placeholder; `memory-ssd` = `rbd.csi.ceph.com`). Ask KSZK.
- Confirm prod bucket (`kir-dev-ehk-backups`) + credentials; secret manager TBD.
- Implement the §5 state machine (`garageSource`/`garagePhase`) and the
  `backup/working` cleanup (keep the snapshot, drop the restore PVCs/RDs).
- Rehearse the whole DR in prod-like conditions; only local validation so far.
- Optionally add the CNPG recovery switch to `ehk` (only `startsch` has it today).

## 10. File map

- `volsync/{kustomization,namespace,values}.yaml` — VolSync install.
- `ehk/app.ts` — restic secrets, `ReplicationSource`s, `garageBootstrap` switch,
  `GarageCluster.storage.*.dataSourceRef`, recovery RD/restore PVCs.
- `application-set/app.ts` — Secret `data` `ignoreDifferences`.
- `.dev/local-cluster.ts` — installs external-snapshotter + `csi-driver-host-path`
  on the host and labels the snapshot class for Velero/VolSync.
- `.dev/dev-storage-classes.yaml` — `memory-ssd` → `hostpath.csi.k8s.io`.
- `.vclusters/vc1/vcluster.yaml`, `.vclusters/vc2/vcluster.yaml` — snapshot +
  `persistentVolumes` sync (both layers).
- Removed: `velero/` (see §3).
