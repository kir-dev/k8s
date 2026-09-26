We are looking for a self-hosted S3 service.
MinIO has gone closed source or became commercial or something, so it's no longer an option.

I would like something that has similar ergonomics as CloudNativePG,
meaning it supports declaratively (through GitOps):
- creating clusters/buckets,
- creating secrets so that our apps can connect,
- backing up to Backblaze,
- and restoring.

The prod (KSZK) k8s cluster uses Ceph for the PVs, with some kind of backup solution already in place.
They recommend having our own backups in addition to theirs.

Options:
- SeaweedFS:
  - Seems to check most of our requirements, but it has a lot of CVEs, a single maintainer and no
    company behind it. It also seems quite vibe-coded.
- Garage:
  - The fan-favorite. Easy to set up. Intended for multi-node setups with 3+ replicas, but supports running just a single node.
  - Built by a French company, supported by the EU.
  - Rust.
  - Third-party Kubernetes operator. Looks very vibe-coded but might support our needs.
  - https://garagehq.deuxfleurs.fr/
- Ceph S3 gateway and Rook:
  - Only available in prod.
  - No built-in way to do per-bucket backups.
  - "Vendor lock-in": we would need another solution if either KSZK switches off Ceph or we want to run in a different cluster.
  - Trusted CNCF project.
  - https://rook.io/
- Velero:
  - Kubernetes backup tool with similar ergonomics to CNPG.
  - Can either back up a volume snapshot or a file-system (using Restic).
- VersityGW:
  - Translates a POSIX file-system to S3. Can be combined with


## Task:
Let's try Garage with a single instance and with Velero and Volume Snapshots.

