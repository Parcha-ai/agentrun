// The package's public API. Every name is listed: a new export is a reviewed line here, and test/entries.test.ts pins the
// list of each entry. `./lease` is the narrow entry for a host that owns its Harness; `./internals` holds plumbing that
// examples and demos use, with no compatibility promise.

// The run: open it, on a disk or a local directory, with its environment, its claim and the errors it fails with.
export { openDurableRun, RunError, StoreBehindSealError } from "./run.ts";
export type { AfterClaim, BeforeResume, DurableRun, LeaseOptions, OpenDurableRunOptions, OpenRunLeaseOptions, OpenStep, ReleaseStep, RunClaim, RunEnv, RunErrorCode, RunLease, RunSeed, RunSeedDir, StoreHeadSource, StoreReads } from "./run.ts";
export { localRun } from "./local-run.ts";
export type { LocalRun } from "./local-run.ts";
export { BOX_MODES, CLAIM_UNMOUNTED, openClaimDir, readLocalRunStatus, RunRecordError } from "./status.ts";
export type { BoxMode, ClaimDir, OpenClaimDirOptions, PersistRecord, RunHolder, RunRecord, RunStatus } from "./status.ts";
export { ArchilCodingTools, archilEnv, EnvClosedError, EnvError, markReadOnlySafe } from "./env.ts";
export type { ArchilEnvClaim, ArchilEnvFactory, ArchilEnvOptions, EnvErrorCode } from "./env.ts";
export type { AcquireOptions, Claim, RunRef, Unmounted } from "./claim.ts";
// What a place's reads of a run's own files fail with.
export { RunFileError } from "./run-files.ts";
export type { RunFileErrorCode } from "./run-files.ts";
export { PathOutsideWorkError } from "./confine.ts";
export type { RefusalReason } from "./confine.ts";
export { BoxUnavailableError, ClaimError, FencedError, HeldError, PdaError } from "./errors.ts";
export type { ClaimErrorCode, Holder } from "./errors.ts";
// Store types the run's signatures name; the store's functions and classes are in `./lease`.
export type { ArchilStore, Fence, FencedDatabase, Profile, StoreFencedError } from "./store.ts";

// The app contract: what `--app` names.
export { AppError } from "./app.ts";
export type { AppContext, AppModule, AppOptions } from "./app.ts";

// Serve: one HTTP request runs one turn.
export { MESSAGE_ORIGIN_KIND, ServeConfigError, serveRun } from "./serve.ts";
export type { RunServer, ServeConfigErrorCode, ServeOptions } from "./serve.ts";
export type { DoorContext, DoorEvent, DoorHook, DoorInput, DoorStatus, DoorTimeouts } from "./door.ts";
export { doorKey, doorTook } from "./door-key.ts";

// Places: where a run lives for a supervisor that kills it and brings it back (agentrun's reference place seam).
export { localPlace, PlaceError } from "./place.ts";
export type { LocalPlaceOptions, Place, PlaceContext, PlaceErrorCode, PlaceExit, PlaceKill, PlaceOutcome, PlacePaths, PlaceRecovery, PlaceRunner, PlaceSignal, PlaceStatus, RunnerOrder } from "./place.ts";

// Parking: an idle run gives its host back.
export { busyState, drain, leaseParkTarget, watchParking } from "./park.ts";
export type { BusyState, DrainOptions, Parking, ParkOptions, ParkResult, ParkTarget } from "./park.ts";
