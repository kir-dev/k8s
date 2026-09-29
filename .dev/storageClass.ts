import * as environment from "./environment.ts";

export function storageClass(prod: ProdStorageClass, dev: DevStorageClass = DevStorageClass.localPath): string {
    if (environment.environment == "Production")
        return prod;
    if (environment.environment == "Development")
        return dev;
    throw new Error();
}

// Storage classes available in the vc-kirdev vCluster at KSZK
export enum ProdStorageClass {
    // Ceph RBD SSD network storage, fast, simple, likely what you need
    memorySsd = "memory-ssd",
    // Same as memory-ssd but supports access from different nodes at the same time
    memorySsdRwx = "memory-ssd-rwx",
    // Ceph RBD with HDDs, cheap but slow
    memoryHdd = "memory-hdd",
    // SSDs on the nodes themselves, fastest, but unavailable when the node it's on goes down
    nodeLocalZfs = "node-local-zfs",
}

export enum DevStorageClass {
    // Default storage class in K3S, use this
    localPath = "local-path",
    // Hacked together storage class that supports Volume Snapshots
    snapshottableHostPath = "memory-ssd",
}
