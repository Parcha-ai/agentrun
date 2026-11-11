// Where a run's journal must be durable before the run goes on, and the one way to make it so.
//
// In WAL mode, a store at `synchronous = NORMAL` keeps every commit through a process crash: the commit is in the WAL,
// which the next open reads. A box loss (a deleted sandbox, a kernel crash, a power cut, an unflushed network-disk
// client) can lose the commits made since the WAL was last synced. `syncNow()` is that sync: one small marker commit at
// FULL. A FULL commit syncs the WAL file, so it makes every earlier frame durable, not only its own. So a site calls it
// right after its own commit, and nothing needs to know which transaction held what.
//
// The rule: a store may run at NORMAL only if every side effect written through it passes a `syncNow()` before it runs,
// so a box loss can never cause the effect to run twice. A store with no such chokepoint stays FULL. Every store a run
// writes is listed in STORES, and every barrier in BARRIERS with the file that calls it. test/barriers.test.ts holds this
// table to the source: every `syncNow()` names a barrier and is in that barrier's file, every active barrier has a call,
// every file that opens a store is listed, a store with no effects never runs tools or models, and no barrier is still
// `planned`, nor any of NORMAL_PRECONDITIONS left undone, once the run journal is NORMAL.
import type { SqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite";
import { JOURNAL_SYNCHRONOUS } from "./store.ts";

/** `active`: its call is in the source. `planned`: named, not called yet; the run journal may not go NORMAL before it is. */
export type BarrierStatus = "active" | "planned";

export interface BarrierRow {
  /** Where the effect is written. */
  readonly store: StoreId;
  /** The file, under packages/, that calls `syncNow()` for it (or `call`). */
  readonly site: string;
  /** For a chokepoint whose sync is reached through a hook: the file and text that call it. */
  readonly via?: { readonly file: string; readonly text: string };
  /** For a store whose sync is not `syncNow()` (the one store's `flush()`, behind its Store interface): the exact code
   *  line in `site` that is the barrier, checked as code only (never in a comment), in place of a `syncNow(…)` call. */
  readonly call?: string;
  readonly status: BarrierStatus;
  /**
   * An active barrier's proof: its box-loss end-to-end test, the one file (relative to the repository) that loses a box
   * while the effect it guards is in flight and shows the effect is not sent again; or a list of files that together are
   * the proof, the box-loss test among them (one shows the sync holds through a box loss, the others that the site syncs
   * before the effect and that the effect then runs once). Each file must exist. `null` while it has none: the run
   * journal may not go NORMAL then (NORMAL_PRECONDITIONS.barrierProofs).
   */
  readonly proof?: string | readonly string[] | null;
  readonly why: string;
}

/** Every barrier. The keys are the names a `syncNow()` call takes, as `BARRIER.<key>`. */
export const BARRIERS = {
  paidToolHold: {
    store: "one-store",
    site: "run-adapters/src/kernel/cap/run-cap.ts",
    call: 'if (event.type === "request_start") await flush();',
    status: "active",
    proof: ["packages/run-adapters/test/kernel-cap-decisions-one-ledger.test.mjs", "packages/serve/test/store-flush.test.mjs"],
    why: "a paid tool call's hold (paid calls and monid) on the run's one ledger, flushed before the call is sent",
  },
  browserSessionOpen: {
    store: "one-store",
    site: "serve/src/browser-cost.ts",
    status: "planned",
    why: "a browser session's open record (its tag, the call's hold), flushed before the vendor's session is created",
  },
  decisionHold: {
    store: "run-journal",
    site: "serve/src/decision-cap.ts",
    status: "planned",
    why: "a workflow decision's admitted hold, before the decision is sent",
  },
  runStatus: {
    store: "run-journal",
    site: "pi-durable-disk/src/run.ts",
    status: "active",
    proof: "packages/pi-durable-disk/test/barriers-crash.test.ts",
    why: "a status transition the run writes (its end among them)",
  },
  runRelease: {
    store: "run-journal",
    site: "pi-durable-disk/src/run.ts",
    status: "active",
    proof: "packages/pi-durable-disk/test/barriers-crash.test.ts",
    why: "the release: what the run committed is durable before its claim is sealed and let go",
  },
  storeIntentFlush: {
    store: "one-store",
    site: "serve/src/runner/side-effects.ts",
    call: "if (!call.replaySafe) await call.flush();",
    status: "active",
    proof: [
      "packages/serve/test/store-flush.test.mjs",
      "packages/serve/test/runner-loop-flush.test.mjs",
      "packages/serve/test/harness-conformance-reference.test.mjs",
      "packages/serve/test/harness-conformance-pi-adapter.test.mjs",
      "packages/serve/test/adapter-pi-interrupt.test.mjs",
      "packages/serve/test/adapter-pi-model-flush.test.mjs",
    ],
    why: "a runner loop's effects that are not replay-safe, each flushed in the one store's journal before it runs: a tool call that is not replay-safe (its intent flushed before the call), and each model-request attempt (flushed once per attempt, after its request checkpoint, before the request leaves)",
  },
} as const satisfies Record<string, BarrierRow>;

export type BarrierName = keyof typeof BARRIERS;

/** The names, for a call site: `syncNow(store, BARRIER.paidToolHold)`. */
export const BARRIER = Object.fromEntries(Object.keys(BARRIERS).map((name) => [name, name])) as { readonly [Name in BarrierName]: Name };

export interface StoreRow {
  /** The files, under packages/, that open it read-write. */
  readonly opens: readonly string[];
  /** `journal`: the run journal's level (JOURNAL_SYNCHRONOUS in store.ts). */
  readonly synchronous: "journal" | "FULL" | "NORMAL";
  /** `barriers`: its side effects pass the barriers whose `store` is this one. `none`: no tool and no model runs on it. */
  readonly effects: "barriers" | "none";
  /** The source directory, under packages/, of the interface others reach it through (the one store's Store): a file
   *  outside it that imports from it and runs a tool or a model is the store's user, and counts as `opens` does for the
   *  effects check. */
  readonly interface?: string;
  readonly what: string;
}

/** Every store a run writes, with how it syncs. */
export const STORES = {
  "run-journal": {
    opens: ["pi-durable-disk/src/store.ts", "pi-durable-disk/src/run.ts", "pi-durable-disk/src/status.ts"],
    synchronous: "journal",
    effects: "barriers",
    what: "a run's store/run.sqlite: the pi Harness, the kernel sessions, the workflow journal and the server's marks",
  },
  "run-checkpoint": {
    opens: ["serve/src/run-db.ts"],
    synchronous: "FULL",
    effects: "none",
    what: "the server's checkpoint of a run's store when it takes the run back: synced before the WAL that held it goes",
  },
  "agent-home": {
    opens: ["pi-durable-agent/src/store.ts"],
    synchronous: "FULL",
    effects: "none",
    what: "an agent home's and a seeded run's store, written at seed, pack, unpack and import",
  },
  agents: {
    opens: ["pi-durable-agent/src/agent-store.ts"],
    synchronous: "FULL",
    effects: "none",
    what: "the server's agents store",
  },
  "server-import": {
    opens: ["serve/src/import.ts"],
    synchronous: "NORMAL",
    effects: "none",
    what: "an imported run's timeline, written once",
  },
  "agent-pack": {
    opens: ["pi-durable-agent/src/pack.ts"],
    synchronous: "FULL",
    effects: "none",
    what: "a packed agent's clean copy (VACUUM INTO), SQLite's own default, a rollback journal at FULL",
  },
  "server-lock": {
    opens: ["serve/src/server-lock.ts"],
    synchronous: "FULL",
    effects: "none",
    what: "the server's lock file on its data root: an exclusive lock, no data",
  },
  "one-store": {
    opens: ["serve/src/store/sqlite/worker.ts"],
    synchronous: "NORMAL",
    effects: "barriers",
    interface: "serve/src/store/",
    what: "the one store (store.sqlite in the data directory) and its owner lock: WAL at NORMAL, flush() one FULL commit; the runner's loops run tools and models through its Store interface, each effect that is not replay-safe after its intent and a flush()",
  },
} as const satisfies Record<string, StoreRow>;

export type StoreId = keyof typeof STORES;

/**
 * What must be true before the run's journal opens at NORMAL (JOURNAL_SYNCHRONOUS), beyond every barrier being active.
 * test/barriers.test.ts fails while the journal is NORMAL and any of these is not `done`.
 */
export const NORMAL_PRECONDITIONS = {
  fencedStatus: {
    done: true,
    what: "a fenced run's status write skips its barrier, so it fails with the fence's own error, as at FULL (run.test.ts)",
  },
  kernelSyncRequired: {
    done: true,
    what: "the kernel's run-journal writer has `sync` (SessionWriter requires it): an effect with no barrier to call is refused, not run",
  },
  endToEndBoxLoss: {
    done: false,
    what: "an end-to-end box-loss test bites at NORMAL for each run-journal effect: the ones the per-run process's app had (its tool gate, kernel drive, model and paid-call marks) went with it, so none is in place",
  },
  holdRefusedUnsynced: {
    done: true,
    what: "a paid call's hold is on the run's one ledger, flushed before the call is sent (paidToolHold; run-adapters/test/kernel-cap-decisions-one-ledger.test.mjs)",
  },
  browserSessionBarrier: {
    done: true,
    what: "the durable unit is the session open (browserSessionOpen, written before the vendor create); per-call holds are in-process reservations re-derived at reopen, by design",
  },
  barrierProofs: {
    done: false,
    what: "every active barrier names its box-loss end-to-end test (BarrierRow.proof): the paid hold's went with the per-run process's app",
  },
} as const satisfies Record<string, { readonly done: boolean; readonly what: string }>;

/** What `syncNow` needs of a store: its database, and the level it runs at between barriers. */
export interface SyncTarget {
  readonly database: SqliteDatabase;
  readonly synchronous: "FULL" | "NORMAL";
}

const MARKER_TABLE = "pda_barrier";
const CREATE_MARKER = `CREATE TABLE IF NOT EXISTS ${MARKER_TABLE} (id INTEGER PRIMARY KEY CHECK (id = 1), n INTEGER NOT NULL, barrier TEXT NOT NULL)`;
// Always a change (n moves), so always a page written and a commit frame to sync: an identical row writes nothing.
const MARK = `INSERT INTO ${MARKER_TABLE} (id, n, barrier) VALUES (1, 1, ?) ON CONFLICT (id) DO UPDATE SET n = n + 1, barrier = excluded.barrier`;

/**
 * Make every commit `store` has made durable: one marker commit at FULL, then the store's own level again. A store that
 * runs at FULL synced at every commit already, so nothing is written. The three steps are queued together on the
 * store's one connection (pi's SQLite driver runs operations in call order), so no other commit runs at FULL by
 * accident. A failure rejects; a storage error of the fencing kind fences the store, as any write does.
 *
 * `store` undefined: a site that has no run store at hand (a host's tool gate before the run is open to it, say). That
 * is safe only while the run's journal runs at FULL, where the commit before it synced already; at NORMAL it rejects,
 * so the effect is not sent.
 */
export async function syncNow(store: SyncTarget | undefined, barrier: BarrierName): Promise<void> {
  if (!Object.hasOwn(BARRIERS, barrier)) throw new TypeError(`unknown barrier ${JSON.stringify(barrier)}`);
  if (store === undefined) {
    if (JOURNAL_SYNCHRONOUS === "FULL") return;
    throw new Error(`barrier ${barrier}: no run store to sync, so the effect it guards is not sent`);
  }
  if (store.synchronous === "FULL") return;
  const steps = [
    store.database.exec("PRAGMA synchronous = FULL"),
    store.database.transaction(async (tx) => {
      await tx.exec(CREATE_MARKER);
      await tx.run(MARK, barrier);
    }),
    store.database.exec(`PRAGMA synchronous = ${store.synchronous}`),
  ];
  const settled = await Promise.allSettled(steps);
  const failed = settled.find((step) => step.status === "rejected");
  if (failed) throw failed.reason;
}
