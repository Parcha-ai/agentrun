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
  /** The file, under packages/, that calls `syncNow()` for it. */
  readonly site: string;
  /** For a chokepoint whose sync is reached through a hook: the file and text that call it. */
  readonly via?: { readonly file: string; readonly text: string };
  readonly status: BarrierStatus;
  /**
   * An active barrier's proof: its box-loss end-to-end test, the one file (relative to the repository) that loses a box
   * while the effect it guards is in flight and shows the effect is not sent again. `null` while it has none: the run
   * journal may not go NORMAL then (NORMAL_PRECONDITIONS.barrierProofs).
   */
  readonly proof?: string | null;
  readonly why: string;
}

/** Every barrier. The keys are the names a `syncNow()` call takes, as `BARRIER.<key>`. */
export const BARRIERS = {
  piToolIntent: {
    store: "run-journal",
    site: "serve/src/tool-gate.ts",
    status: "active",
    proof: "packages/serve/test/barriers-box-loss.test.mjs",
    why: "a pi tool call that is not replay-safe, or a billed replay-safe one: its intent, before it executes",
  },
  kernelEffectIntent: {
    store: "run-journal",
    site: "serve/src/sessions.ts",
    via: { file: "run-adapters/src/kernel/drive.ts", text: "await writer.sync?.()" },
    status: "active",
    proof: "packages/serve/test/barriers-box-loss.test.mjs",
    why: "a kernel effect (claude-agent, codex, opencode) that is not replay-safe: its start record, before it runs",
  },
  sideRequestStarted: {
    store: "run-journal",
    site: "serve/src/harness-app.ts",
    status: "active",
    proof: null,
    why: "a non-pi harness's model request: its start mark and bound, before it is sent",
  },
  modelRequestStarted: {
    store: "run-journal",
    site: "serve/src/request-start.ts",
    status: "active",
    proof: "packages/serve/test/barrier-box-loss.test.mjs",
    why: "a pi model or compaction request: its start mark and bound, before it is sent",
  },
  paidToolHold: {
    store: "run-journal",
    site: "serve/src/paid-calls.ts",
    status: "active",
    proof: "packages/serve/test/barrier-box-loss.test.mjs",
    why: "a paid tool call's hold (paid calls, monid, the MCP gateway), before the call is sent",
  },
  workflowAdmit: {
    store: "run-journal",
    site: "serve/src/app.ts",
    via: { file: "dsl/src/recovery/driver.ts", text: "if (options.afterAdmit) await persist(options.afterAdmit);" },
    status: "active",
    proof: "packages/serve/test/barrier-box-loss.test.mjs",
    why: "a workflow effect's admission with its intent, before it is dispatched",
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
    proof: null,
    why: "a status transition the run writes (its end among them)",
  },
  runRelease: {
    store: "run-journal",
    site: "pi-durable-disk/src/run.ts",
    status: "active",
    proof: null,
    why: "the release: what the run committed is durable before its claim is sealed and let go",
  },
  homeToolIntent: {
    store: "home",
    site: "pi-transport/src/home/tool-barrier.ts",
    via: { file: "pi-transport/src/home/run.ts", text: "registry.install(toolBarrier(registry" },
    status: "active",
    proof: "packages/pi-transport/test/home-tool-barrier.test.ts",
    why: "a home tool call that is not replay-safe: its intent, before it executes (the home's own barrier, an fdatasync of its WAL file: its store holds only pi-durable's tables, so no marker commit)",
  },
} as const satisfies Record<string, BarrierRow>;

export type BarrierName = keyof typeof BARRIERS;

/** The names, for a call site: `syncNow(store, BARRIER.piToolIntent)`. */
export const BARRIER = Object.fromEntries(Object.keys(BARRIERS).map((name) => [name, name])) as { readonly [Name in BarrierName]: Name };

export interface StoreRow {
  /** The files, under packages/, that open it read-write. */
  readonly opens: readonly string[];
  /** `journal`: the run journal's level (JOURNAL_SYNCHRONOUS in store.ts). */
  readonly synchronous: "journal" | "FULL" | "NORMAL";
  /** `barriers`: its side effects pass the barriers whose `store` is this one. `none`: no tool and no model runs on it. */
  readonly effects: "barriers" | "none";
  readonly what: string;
}

/** Every store a run writes, with how it syncs. */
export const STORES = {
  "run-journal": {
    opens: ["pi-durable-disk/src/store.ts", "pi-durable-disk/src/run.ts"],
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
  home: {
    opens: ["pi-transport/src/home/run.ts"],
    synchronous: "NORMAL",
    effects: "barriers",
    what: "the home runner's own store",
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
  "home-replay": {
    opens: ["pi-transport/src/home/commit-log.ts"],
    synchronous: "NORMAL",
    effects: "none",
    what: "a home store rebuilt from its commit log",
  },
  "home-rebuild": {
    opens: ["pi-transport/src/home/store.ts"],
    synchronous: "NORMAL",
    effects: "none",
    what: "a home store's schema probe and rebuild",
  },
  "agent-pack": {
    opens: ["pi-durable-agent/src/pack.ts"],
    synchronous: "FULL",
    effects: "none",
    what: "a packed agent's clean copy (VACUUM INTO), SQLite's own default, a rollback journal at FULL",
  },
  "home-lock": {
    opens: ["pi-transport/src/home/lock.ts"],
    synchronous: "FULL",
    effects: "none",
    what: "the lock file beside a home store: an exclusive lock, no data",
  },
  "server-lock": {
    opens: ["serve/src/server-lock.ts"],
    synchronous: "FULL",
    effects: "none",
    what: "the server's lock file on its data root: an exclusive lock, no data",
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
    done: false,
    what: "the kernel's run-journal writer must have `sync`: an effect with no barrier to call is refused, not run (drive.ts passes a writer without one)",
  },
  endToEndBoxLoss: {
    done: false,
    what: "a box-loss test through the real chokepoints (the tool gate, the kernel drive, the side-request mark) on a NORMAL run's store, not only ordering tests",
  },
  retryMarkSynced: {
    done: true,
    what: "no barrier needed before pi-ai's retry: a lost attempt's end mark (serve/src/request-start.ts) carries the request's hold, which its start mark, synced before the request left (modelRequestStarted), carries too, and the retry writes no start mark of its own; a box that drops the lost mark leaves the request read as one a crash cut, at that same hold, and the WAL keeps the lost mark whenever it keeps an answer of the retry (serve/test/retry-mark-box-loss.test.mjs, a guard)",
  },
  holdRefusedUnsynced: {
    done: false,
    what: "a paid call refused after its hold was written (serve/src/paid-calls.ts:81-84, a sync that fails) and a model request ended unsent after its start mark (modelRequestStarted) leave their refusal or unsent end unsynced",
  },
  browserSessionBarrier: {
    done: false,
    what: "a browser call's hold (serve/src/browser-cost.ts:167, paidCall over keepHold) is kept in memory, not written and synced before the call goes, so it has no barrier",
  },
  barrierProofs: {
    done: false,
    what: "every active barrier names its box-loss end-to-end test (BarrierRow.proof); sideRequestStarted, runStatus and runRelease have none yet (null)",
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
