// The narrow entry (`@parcha/pi-durable-archil/lease`) for a host that owns its own pi-durable Harness and store connections: the
// claim's lifecycle without the supervisor, the host drivers, the CLI or the app contract. Importing it must not pull those
// in (test/lease.test.ts bundles it and checks); a name added here is part of that promise.
export { EXIT_DATAERR, EXIT_SOFTWARE, LeaseLapsedError, openRunLease, OWNER_LOCK, RunError, StoreBehindSealError, storeHead, STORE_FILE } from "./run.ts";
export type { LeaseOptions, OpenRunLeaseOptions, OpenStep, ReleaseStep, RunClaim, RunErrorCode, RunLease, StoreHeadSource } from "./run.ts";
export * from "./errors.ts";
export { assertPragmas, Fence, FencedDatabase, openArchilStore, PROFILE_PRAGMAS, StoreBusyError, StoreFencedError, StorePragmaError } from "./store.ts";
export type { ArchilStore, OpenOptions, PragmaMismatch, Profile } from "./store.ts";
// Types the signatures above mention.
export type { ArchilHost, Claim, RunRef } from "./claim.ts";
export type { RunHolder, RunRecord, RunStatus } from "./status.ts";
