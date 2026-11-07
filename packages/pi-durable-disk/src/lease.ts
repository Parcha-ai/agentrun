// The narrow entry (`@parcha/pi-durable-disk/lease`) for a host that owns its own pi-durable Harness and store connections: the
// claim's lifecycle without the supervisor, the host drivers, the CLI or the app contract. Importing it must not pull those
// in (test/lease-entry.test.ts bundles it and checks); a name added here is part of that promise.
export { EXIT_DATAERR, EXIT_SOFTWARE, LeaseLapsedError, openRunLease, OWNER_LOCK, RunError, StoreBehindSealError, storeHead, STORE_FILE } from "./run.ts";
export type { LeaseOptions, OpenRunLeaseOptions, OpenStep, ReleaseStep, RunClaim, RunErrorCode, RunLease, RunSeed, RunSeedDir, StoreHeadSource } from "./run.ts";
export * from "./errors.ts";
export { assertPragmas, Fence, FencedDatabase, JOURNAL_SYNCHRONOUS, openArchilStore, PROFILE_PRAGMAS, StoreBusyError, StoreFencedError, StorePragmaError } from "./store.ts";
export type { ArchilStore, OpenOptions, PragmaMismatch, Profile, Synchronous } from "./store.ts";
export { BARRIER, syncNow } from "./barriers.ts";
export type { BarrierName, SyncTarget } from "./barriers.ts";
// Types the signatures above mention.
export type { AcquireOptions, Claim, RunRef, Unmounted } from "./claim.ts";
export { BOX_MODES } from "./status.ts";
export type { BoxMode, ClaimDir, PersistRecord, RunHolder, RunRecord, RunStatus } from "./status.ts";
// Parking, for a Harness the host opened over `openRunLease` (`leaseParkTarget`).
export { busyState, drain, leaseParkTarget, watchParking } from "./park.ts";
export type { BusyState, DrainOptions, Parking, ParkOptions, ParkResult, ParkTarget } from "./park.ts";
export type { DurableRun, RunEnv } from "./run.ts";
