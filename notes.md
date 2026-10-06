## Backup

For Postgres, we use CloudNativePG, which has Barman, which has declarative backup and restore to and from Backblaze. We
would like a similar setup for S3.

Current target setup:

- Garage with Garage Operator
    - https://rajsinghtech.github.io/garage-operator/operations/maintenance-and-recovery/#gitops-volume-restore-auto-group
        - https://raw.githubusercontent.com/rajsinghtech/garage-operator/refs/heads/main/docs/operations/maintenance-and-recovery.md
- VolSync
    - https://volsync.readthedocs.io/en/stable/usage/restic/index.html
        - https://raw.githubusercontent.com/backube/volsync/refs/heads/main/docs/usage/restic/index.rst
    - https://volsync.readthedocs.io/en/stable/usage/volume-populator/index.html
        - https://raw.githubusercontent.com/backube/volsync/refs/heads/main/docs/usage/volume-populator/index.rst
    - No work on Volume Group Snapshots yet
        - https://github.com/backube/volsync/issues/1116
        - https://kubernetes.io/blog/2026/05/08/kubernetes-v1-36-volume-group-snapshot-ga/
- Volume Snapshots
    - By Ceph in prod, host-path-csi driver in dev (see `.dev/local-cluster.ts`)
    - https://kubernetes.io/docs/reference/kubernetes-api/core/persistent-volume-claim-v1/#PersistentVolumeClaimSpec
- vCluster
    - Volume Snapshot sync was removed in vcluster 0.36 but added back in 0.37 and a newer 0.36 release
    - https://www.vcluster.com/llms.txt
    - Add `.md` to doc URLs to get MD
    - https://www.vcluster.com/docs/vcluster/configure/vcluster-yaml/sync/to-host/storage/volume-snapshots
    - https://www.vcluster.com/docs/vcluster/0.37.0/configure/vcluster-yaml/sync/to-host/storage/volume-snapshots
    - https://www.vcluster.com/docs/vcluster/0.35.0/configure/vcluster-yaml/sync/to-host/storage/volume-snapshots

## Issues

This is a human summary:

- VolSync ReplicationDestination-as-dataSourceRef
    - We give garage-operator the backup as a dataSourceRef using VolSync's "Volume Populator".
    - As vCluster uses some rebinding magic to translate Volume Snapshots, we can't use a VolSync ReplicationDestination
      as a dataSourceRef directly.
    - Solution: restore from VolSync into a VolumeSnapshot then set that as the dataSourceRef.

## Issues by DeepSeek V4.1 Flash

Other issues encountered by DS while working on Garage backups. The "human verdict" is from a human, everything else was
written by DS.

- Velero: plain CSI snapshots aren't off-site
    - We tried Velero with CSI volume snapshots as the backup.
    - Velero uploads only Kubernetes objects — the snapshot data stays in the storage backend (Ceph/hostpath), so it's
      not an independent backup and restore needs the original snapshot to still exist.
    - Solution: unusable for off-site; the data has to be moved.
    - Human verdict: makes sense, we want off-site backups
- Velero: CSI Snapshot Data Mover broken by vCluster
    - We tried Velero's built-in data mover (snapshotMoveData: true) to move the data off-site.
    - The mover builds a pre-provisioned "exposer" snapshot — it creates the backup VolumeSnapshot first and the
      VolumeSnapshotContent after. vCluster's VS syncer resolves a static VS by mapping the virtual VSC via
      VirtualToHost; the exposer VSC has no virtual→host mapping, so the host VS gets source.volumeSnapshotContentName:
      "", never heals, and the BackupPVC/DataUpload hang.
    - Solution: none — vCluster limitation, unchanged on main. Abandoned Velero.
    - Human verdict: believable, vCluster does some weird things.
- Velero: File System Backup unsupported by vCluster
    - We considered FSB (restic/kopia from the live PV) as the data mover instead.
    - Velero's docs: vCluster doesn't mount volumes under <pod UID>, so FSB doesn't work.
    - Solution: ruled out.
    - Human verdict: application-level backups, like in CNPG would be the goal, but as Garage doesn't support them,
      Volume Snapshot's are the next best thing in terms of consistency after a restore. FSB, I assume, would do the
      opposite of that.
- vCluster: VolumeSnapshot sync only works for dynamic snapshots
    - (Root cause of the Velero data-mover issue.) Dynamic VS (source = PVC) syncs fine; a static/pre-provisioned VS
      (source = VolumeSnapshotContent) needs the VSC synced and name-mapped, and Velero's create order (VS before VSC)
      hits that gap.
    - Solution: use dynamic snapshots (source = PVC).
- garage-operator: won't adopt PVCs it didn't create
    - We restored into PVCs named like the operator's own and expected its StatefulSet to adopt them.
    - It refuses: "refusing to adopt or mutate convention-named PVC … without strong evidence from the live exact-owned
      StatefulSet" — its PVCs carry a garage-node-uid + pvc-reservation-nonce.
    - Solution: don't pre-create the operator's PVCs; let it create them via GarageCluster.storage.*.dataSourceRef.
- garage-operator: PVC reservation finalizer is operator-only
    - We deleted a GarageNode out-of-band to clean up.
    - The PVC finalizer garagenode.garage.rajsingh.info/pvc-reservation can only be removed by the operator's service
      account; the vmanagedpvcfinalizer.kb.io webhook rejects even admins → PVCs stick in Terminating and the cluster
      can't be cleaned up.
    - Solution: never force-delete garage CRs/PVCs; reset with local-cluster:down && up.
    - Human verdict: yep, in the dev env, recreate the dev cluster anytime
- garage-operator: deleting a GarageCluster with dependents deadlocks
    - We deleted the GarageCluster to switch topology.
    - Its finalizer waits for GarageBucket/GarageKey to finalize, but the operator tears down the StatefulSet/pods
      first, so the dependents can't reach the admin API → deadlock.
    - Solution: don't delete the cluster to change layout; gate the restore at creation via dataSourceRef.
- garage-operator: the storage spec is immutable
    - We changed storage labels, and later tried to add/remove dataSourceRef after creation.
    - Webhook: storage type/class/accessModes/labels/annotations/claim template are immutable while replicas live, and
      dataSourceRef is immutable after creation.
    - Solution: declare the operator defaults explicitly (type, dataFsync, metadataFsync) so ArgoCD stops rewriting;
      only set dataSourceRef at cluster creation.
- VolSync: destination snapshot name is dynamic
    - We needed a fixed-name VolumeSnapshot to reference from dataSourceRef.
    - VolSync names it <pvc>-<timestamp> unless the destination PVC carries the volsync.backube/snapname annotation.
    - Solution: pre-set that annotation with a fixed name and use destination copyMethod: Snapshot, so the snapshot is
      taken after the restore.
- garage-operator: restored bucket/key need adoption
    - After restoring the metadata, the bucket/key exist in Garage but not as managed CRs.
    - The operator calls them "untracked" ("set spec.bucketId explicitly"), and it generates a new key pair, so the
      restored S3 secret isn't reproducible.
    - Solution (open): supply bucketId/key id during restore (or don't re-manage them and source the old secret);
      ideally the CRDs allow predefined ids/secrets.
- ArgoCD (local): only committed+pushed work is seen; manual secrets drift
    - local-cluster:sync force-pushes HEAD, so uncommitted work is invisible to ArgoCD; manually-filled Secret data gets
      pruned/reverted.
    - Solution: commit before sync; ApplicationSet ignoreDifferences on Secret /data + ApplyOutOfSyncOnly=true.
    - Human verdict: commit being required for a sync is already mentioned in the README.
        - Secret contents do get overwritten by Argo CD, a workaround is to leave `data`/`stringData` empty on the
          GitOps side and set it manually using kubectl. The ignoreDifferences workaround shouldn't be needed.
- ArgoCD (local): cmp-cdk8s segfaults on startup
    - After a rebuild the cmp-cdk8s sidecar exits 139 (SIGSEGV) → repo-server CrashLoopBackOff → the ApplicationSet
      can't generate apps (no Applications at all).
    - Solution: delete the argocd-repo-server pod (transient).
    - Human verdict: this shouldn't happen on a brand-new cluster, call it out if it does, as it needs to be fixed then.
- vcluster (local): connect port-forwards die
    - The kubectl context uses localhost port-forwards; they can die (127.0.0.1:1xxxx: connection refused), and both vc1
      and vc2 can be affected.
    - Solution: reconnect outer→inner — vcluster connect vc1 -n vc1, then vcluster connect vc2 -n vc2.
    - Human verdict: yeah, if I restart my PC, you do have to reconnect. I likely won't tell you when that happens.
