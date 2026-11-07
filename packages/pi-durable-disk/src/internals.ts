// `@parcha/pi-durable-disk/internals`: the status plumbing that this repository's examples and demos
// use. No compatibility promise: a name here may change or go in any release, and the CHANGELOG says when. A name moves
// to the root entry when something outside this repository needs it.
export { runPath } from "./claim.ts";
export { isLeaseFresh, parseRunRecord, RUN_JSON } from "./status.ts";
// What a run's database is opened with (the exclusive profile, and on macOS F_FULLFSYNC), for a host that checkpoints it
// itself once the run's process is gone (agentrun-serve's take-back).
export { profilePragmas, SYNCHRONOUS_LEVEL } from "./store.ts";
// The barriers table and the stores, for the source guard and the hosts that list them.
export { BARRIERS, NORMAL_PRECONDITIONS, STORES } from "./barriers.ts";
export type { BarrierRow, BarrierStatus, StoreId, StoreRow } from "./barriers.ts";
// A run under its host's epoch (openDurableRun's `epoch`): the table of its store that holds its record, and the process
// table its host tells a live holder from a pid reused by another process with.
export { RUN_STATUS_TABLE } from "./run.ts";
export { processTable } from "./process-table.ts";
export type { ProcessInfo, ProcessOrigin, ProcessSnapshot, ProcessTable } from "./process-table.ts";
// The rule a door's snapshot of a run's inputs starts at, for a host that reads the snapshot (agentrun-serve's ledger),
// and the snapshot itself, so a host's tests read the inputs a door would send.
export { newestSettledInput, snapshotInputs } from "./serve.ts";
// A host's proof that a door is the one it launched (a nonce handed on `run --door-nonce-fd`, answered at POST /door-proof).
export { doorProof } from "./serve.ts";
export type { InputRecord } from "./serve.ts";
// The workspace confinement, for a host that reads a run's files itself (agentrun-serve), and its process-wide TEST seam
// (confineTestHooks: runs after a path is checked and before it is opened; tests only, never a production hook).
export { Confinement, confineHooks as confineTestHooks } from "./confine.ts";
export type { Pin, PinSpec, RootName } from "./confine.ts";
