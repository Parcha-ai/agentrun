// The package's public API. Every name is listed: a new export is a reviewed line here, and test/entries.test.ts pins the
// list of each entry. `./lease` is the narrow entry for a host that owns its Harness; `./internals` holds plumbing that
// examples and demos use, with no compatibility promise.

// The run: open it, on a disk or a local directory, with its environment, its claim and the errors it fails with.
export { openDurableRun, RunError, StoreBehindSealError } from "./run.ts";
export type { BeforeResume, DurableRun, LeaseOptions, OpenDurableRunOptions, OpenRunLeaseOptions, OpenStep, ReleaseStep, RunClaim, RunEnv, RunErrorCode, RunLease, StoreHeadSource, StoreReads } from "./run.ts";
export { localRun } from "./local-run.ts";
export type { LocalRun } from "./local-run.ts";
export { CLAIM_UNMOUNTED, openClaimDir, readLocalRunStatus, RunRecordError } from "./status.ts";
export type { ClaimDir, OpenClaimDirOptions, PersistRecord, RunHolder, RunRecord, RunStatus } from "./status.ts";
export { ArchilCodingTools, archilEnv, EnvClosedError, EnvError, markReadOnlySafe } from "./env.ts";
export type { ArchilEnvClaim, ArchilEnvFactory, ArchilEnvOptions, EnvErrorCode } from "./env.ts";
export { acquire, ARCHIL_SCOPED, revoke, takeOver } from "./claim.ts";
export type { AcquireOptions, ArchilHost, Claim, ControlApi, PathlessResolver, RunRef, Unmounted } from "./claim.ts";
// A short exclusive claim on any path of a disk, and a consistent S3 read of a released file (an agent home beside the runs).
export { readReleased, withClaim } from "./with-claim.ts";
export type { ClaimControl, HeldPath, WithClaimOptions } from "./with-claim.ts";
export { PathOutsideWorkError } from "./confine.ts";
export type { RefusalReason } from "./confine.ts";
export { ClaimError, FencedError, HeldError, PdaError } from "./errors.ts";
export type { ClaimErrorCode, Holder } from "./errors.ts";
// Store types the run's signatures name; the store's functions and classes are in `./lease`.
export type { ArchilStore, Fence, FencedDatabase, Profile, StoreFencedError } from "./store.ts";

// The app contract: what `--app` names.
export { AppError } from "./app.ts";
export type { AppContext, AppModule, AppOptions } from "./app.ts";

// The supervisor and the host drivers.
export { archilControl, deleteRunTree, ensureRunning, readRunStatus, SuperviseError } from "./supervise.ts";
export type { ArchilControl, CheckControl, CheckOptions, DiskClient, EnsureOptions, EnsureResult, HostBox, HostDriver, HostHandle, HostStatus, Json, StartAttempt, StartReason, StonithOutcome, SuperviseErrorCode, SupervisorControl, TokenUser } from "./supervise.ts";
export { localHost, LocalHostError } from "./hosts/local-host.ts";
export type { LocalHostOptions, Ran, Runner } from "./hosts/local-host.ts";
export { dockerHost, DockerHostError } from "./hosts/docker.ts";
export type { ContainerInfo, DockerHostOptions, DockerRan, DockerRunner } from "./hosts/docker.ts";
export { DAYTONA_LIST_PRICES, DaytonaApiError, daytonaHost, DaytonaHostError, daytonaRest, daytonaUsdPerSecond } from "./hosts/daytona.ts";
export type { CreateSandboxBody, DaytonaClient, DaytonaHostErrorCode, DaytonaHostOptions, DaytonaRestOptions, ExecResult, SandboxInfo } from "./hosts/daytona.ts";

// Serve: one HTTP request runs one turn.
export { requestRun, ServeConfigError, ServeError, serveRun } from "./serve.ts";
export type { RequestOptions, RunResponse, RunServer, ServeConfigErrorCode, ServeErrorCode, ServeOptions } from "./serve.ts";

// Places: where a run lives for a supervisor that kills it and brings it back (agentrun's reference place seam).
export { archilPlace, localPlace, PlaceError } from "./place.ts";
export type { ArchilPlaceOptions, LocalPlaceOptions, Place, PlaceContext, PlaceErrorCode, PlaceExit, PlaceKill, PlaceOutcome, PlacePaths, PlaceRecordHome, PlaceRecovery, PlaceRunner, PlaceSignal, PlaceStatus, RecordControl, RunnerOrder } from "./place.ts";

// Parking: an idle run gives its host back.
export { busyState, drain, leaseParkTarget, watchParking } from "./park.ts";
export type { BusyState, DrainOptions, Parking, ParkOptions, ParkResult, ParkTarget } from "./park.ts";

// Fork: a new run from a run's committed state.
export { fork, ForkError, forkLocal } from "./fork.ts";
export type { ForkErrorCode, ForkLocalResult, ForkOptions, ForkResult } from "./fork.ts";
