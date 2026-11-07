// How often a run's journal commits, and at which `synchronous` level, over one scripted run of a fixed number of turns.
// The run is opened the way agentrun-serve opens it (a local directory under the host's epoch, the WAL kept at close)
// on pi-ai's faux model, and every commit of its store is counted at the store's instrumentation seam (`decorateStore`)
// with the level in effect when it committed. The WAL the run leaves is read back to prove the count missed nothing.
//
// No timing, no strace, no fsync count: the level a commit ran at decides whether SQLite synced the WAL for it (FULL
// syncs at every commit; NORMAL in WAL mode syncs only at a checkpoint), so counting FULL commits counts those syncs.
//
// TODAY every commit is FULL. Once the journal moves to NORMAL with FULL barrier commits, FULL_ALLOWED switches to the
// barrier formula, and any per-commit FULL (a store opened FULL again) fails `FULL commits per turn` below.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { closeSync, openSync, readSync, fstatSync } from "node:fs";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, Type } from "@earendil-works/pi-ai";
import type { FauxResponseFactory } from "@earendil-works/pi-ai";
import { createRegistry, defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { SqliteDatabase, SqliteExecutor, SqliteValue } from "@earendil-works/pi-durable/storage/sqlite";
import { localRun } from "../src/local-run.ts";
import { openDurableRun, STORE_FILE } from "../src/run.ts";
import { ctx, scratchRoot } from "./_run-support.ts";

/** The run's phases, in order: the open (store, Harness, the record in its store), each turn, and the two ends. */
type Phase = "open" | `turn ${number}` | "status" | "release";

type Commit = { readonly phase: Phase; readonly synchronous: number; readonly via: "transaction" | "autocommit" };

/** `PRAGMA synchronous` values. */
const NORMAL = 1;
const FULL = 2;

const WRITES = /^\s*(insert|update|delete|replace|create|drop|alter|with)\b/i;

/**
 * Every commit of a store, with the level in effect for it. A transaction counts when it changed a row or the schema
 * (pi also reads inside transactions, and a read-only COMMIT writes nothing); its level is read inside it, where SQLite
 * refuses to change it, so it is the level the COMMIT ran at. A statement outside a transaction counts the same way.
 */
class CommitLedger {
  readonly commits: Commit[] = [];
  readonlyTransactions = 0;
  phase: Phase = "open";

  decorate = (inner: SqliteDatabase): SqliteDatabase => {
    const ledger = this;
    const mark = async (on: SqliteExecutor) => {
      const row = await on.get<{ changes: number; schema: number }>("SELECT total_changes() AS changes, (SELECT schema_version FROM pragma_schema_version) AS schema");
      return `${row!.changes}/${row!.schema}`;
    };
    const level = async (on: SqliteExecutor) => Number(Object.values((await on.get<Record<string, SqliteValue>>("PRAGMA synchronous"))!)[0]);
    const autocommit = async <T>(sql: string, run: () => Promise<T>): Promise<T> => {
      if (!WRITES.test(sql)) return run();
      const before = await mark(inner);
      const synchronous = await level(inner);
      const result = await run();
      if ((await mark(inner)) !== before) ledger.commits.push({ phase: ledger.phase, synchronous, via: "autocommit" });
      return result;
    };
    return {
      exec: (sql: string) => autocommit(sql, () => inner.exec(sql)),
      run: (sql: string, ...params: SqliteValue[]) => autocommit(sql, () => inner.run(sql, ...params)),
      get: <T extends object>(sql: string, ...params: SqliteValue[]) => autocommit(sql, () => inner.get<T>(sql, ...params)),
      all: <T extends object>(sql: string, ...params: SqliteValue[]) => autocommit(sql, () => inner.all<T>(sql, ...params)),
      async transaction<T>(callback: (transaction: SqliteExecutor) => Promise<T>): Promise<T> {
        let wrote = false;
        let synchronous = 0;
        const result = await inner.transaction(async (handle) => {
          const before = await mark(handle);
          const value = await callback(handle);
          wrote = (await mark(handle)) !== before;
          synchronous = await level(handle);
          return value;
        });
        // Counted once COMMIT returned: a commit that failed is no commit.
        if (wrote) ledger.commits.push({ phase: ledger.phase, synchronous, via: "transaction" });
        else ledger.readonlyTransactions++;
        return result;
      },
      close: () => inner.close(),
    };
  };

  in(phase: Phase | ((phase: Phase) => boolean)): Commit[] {
    return this.commits.filter((c) => (typeof phase === "function" ? phase(c.phase) : c.phase === phase));
  }
}

/**
 * The commit frames of a WAL file (frames whose header names the database size after the commit), counted from its
 * start while each frame carries the header's salts. A store whose close keeps its WAL (agentrun-serve's) and that never
 * checkpointed has every commit since it was created in there.
 */
function walCommitFrames(file: string): number {
  const fd = openSync(file, "r");
  try {
    const size = fstatSync(fd).size;
    const header = Buffer.alloc(32);
    if (size < 32 || readSync(fd, header, 0, 32, 0) !== 32) return 0;
    const pageSize = header.readUInt32BE(8);
    const salts = [header.readUInt32BE(16), header.readUInt32BE(20)];
    const frame = Buffer.alloc(24);
    let commits = 0;
    for (let at = 32; at + 24 + pageSize <= size; at += 24 + pageSize) {
      readSync(fd, frame, 0, 24, at);
      if (frame.readUInt32BE(8) !== salts[0] || frame.readUInt32BE(12) !== salts[1]) break;
      if (frame.readUInt32BE(4) !== 0) commits++;
    }
    return commits;
  } finally {
    closeSync(fd);
  }
}

/** What the scripted app did, counted where it happened: the model's requests and the tools' executions. */
type Calls = { modelRequests: number; sideEffecting: number; replaySafe: number };

/**
 * pi-ai's faux model scripted for one fixed turn shape: "turn <n>" is answered with a call of each tool (one replay-safe
 * read, one side-effecting write), and their results with "done". Two model requests and two tool calls a turn.
 */
function scriptedApp(calls: Calls) {
  const reply: FauxResponseFactory = (context) => {
    calls.modelRequests++;
    const last = context.messages.findLast((m) => (m.role as string) !== "system");
    if (last?.role === "toolResult") return fauxAssistantMessage("done");
    return fauxAssistantMessage([fauxToolCall("read_note", {}), fauxToolCall("write_note", {})], { stopReason: "toolUse" });
  };
  const faux = fauxProvider();
  faux.setResponses(Array.from({ length: 1_000 }, () => reply));
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();
  const tool = (name: string, replay: "safe" | "unsafe", count: () => void) =>
    defineTool({
      name,
      description: `a ${replay === "safe" ? "replay-safe" : "side-effecting"} tool`,
      parameters: Type.Object({}),
      replay,
      execute: async (_args, api) => {
        count();
        api.output(`${name} ok`);
        return {};
      },
    });
  const registry = createRegistry();
  registry.install(
    defineExtension({
      name: "notes",
      tools: [tool("read_note", "safe", () => calls.replaySafe++), tool("write_note", "unsafe", () => calls.sideEffecting++)],
    }),
  );
  return { harness: { models, registry }, agent: { model: { provider: model.provider, modelId: model.id } } };
}

const TURNS = 24;

/**
 * The pin: today's numbers on pi-durable 1.1. A pi upgrade that batches commits moves `commits`, and so do the barrier
 * commits themselves; update it with either. This app has no paid tool, so its paid holds are 0.
 */
const PIN = {
  perTurn: { commits: 18, modelRequests: 2, sideEffecting: 1, replaySafe: 1, paidHolds: 0 },
  open: { commits: 4 },
  status: { commits: 1 },
  release: { commits: 1 },
};

type PerTurn = typeof PIN.perTurn;

/** Every commit is FULL: the store syncs the WAL at each one. TODAY's rule. */
const EVERY_COMMIT = {
  turn: (_calls: PerTurn, commits: number) => commits,
  open: (commits: number) => commits,
  end: (commits: number) => commits,
};

/**
 * The barrier rule the journal moves to: NORMAL, with one FULL commit for each effect intent (a side-effecting tool
 * call), each paid hold and each model request, and one for each end (the final status, the release); none while
 * opening. A replay-safe call is no barrier.
 */
const BARRIERS = {
  turn: (calls: PerTurn, _commits: number) => calls.sideEffecting + calls.paidHolds + calls.modelRequests,
  open: (_commits: number) => 0,
  end: (_commits: number) => 1,
};

/** The FULL commits each phase may make. Switches to BARRIERS when the journal does; a FULL store then fails here. */
const FULL_ALLOWED: typeof EVERY_COMMIT = EVERY_COMMIT;

describe("the run journal's commits", () => {
  it(`counts every commit of a ${TURNS}-turn scripted run, and the level each ran at`, async (t) => {
    const dir = scratchRoot("journal-commits");
    const root = join(dir.root, "runs", "run-1");
    try {
      const ledger = new CommitLedger();
      const calls: Calls = { modelRequests: 0, sideEffecting: 0, replaySafe: 0 };
      const app = scriptedApp(calls);
      // agentrun-serve's own open of a run (cli.ts): a local directory, the host's epoch, the WAL kept at close.
      const run = await openDurableRun({ disk: "dsk-local", region: "local", id: "run-1" }, { ...localRun(root), epoch: 1, keepWal: true, harness: app.harness, decorateStore: ledger.decorate });
      const perTurn: { commits: number; full: number; normal: number; calls: Calls }[] = [];
      const conversation = await run.harness.createConversation({ ownership: { kind: "ownerless" }, agent: app.agent }, ctx);
      for (let n = 1; n <= TURNS; n++) {
        ledger.phase = `turn ${n}`;
        const before = { ...calls };
        await conversation.submit({ type: "input", content: `turn ${n}` }, ctx);
        await run.harness.waitForIdle(ctx);
        const commits = ledger.in(`turn ${n}`);
        perTurn.push({
          commits: commits.length,
          full: commits.filter((c) => c.synchronous === FULL).length,
          normal: commits.filter((c) => c.synchronous === NORMAL).length,
          calls: { modelRequests: calls.modelRequests - before.modelRequests, sideEffecting: calls.sideEffecting - before.sideEffecting, replaySafe: calls.replaySafe - before.replaySafe },
        });
      }
      ledger.phase = "status";
      await run.setStatus("done", { turns: TURNS });
      // The release rewrites the record the status just wrote. Within the same millisecond it is the same row, and
      // SQLite writes no page for an identical row (no commit frame, no sync): wait the clock past it, so it always commits.
      await new Promise((resolve) => setTimeout(resolve, 5));
      ledger.phase = "release";
      await run.release();

      const open = ledger.in("open");
      const ends = { status: ledger.in("status"), release: ledger.in("release") };
      const full = (commits: Commit[]) => commits.filter((c) => c.synchronous === FULL).length;
      const summary = {
        turns: TURNS,
        perTurnCommits: [...new Set(perTurn.map((p) => p.commits))],
        perTurnFull: [...new Set(perTurn.map((p) => p.full))],
        perTurnCalls: perTurn[0]!.calls,
        open: { commits: open.length, full: full(open) },
        status: { commits: ends.status.length, full: full(ends.status) },
        release: { commits: ends.release.length, full: full(ends.release) },
        total: { commits: ledger.commits.length, full: full(ledger.commits), readonlyTransactions: ledger.readonlyTransactions },
        levels: [...new Set(ledger.commits.map((c) => c.synchronous))],
        barriersPerTurn: BARRIERS.turn(PIN.perTurn, PIN.perTurn.commits),
      };
      t.diagnostic(`node ${process.version}; ${JSON.stringify(summary)}`);

      // The count missed nothing: the kept WAL holds one commit frame for every commit the ledger saw.
      assert.equal(walCommitFrames(join(root, "store", `${STORE_FILE}-wal`)), ledger.commits.length, "every commit in the WAL was counted");

      // The run did the same thing every turn, so each turn is the same number of commits.
      for (const [i, p] of perTurn.entries()) {
        assert.deepEqual(p.calls, { modelRequests: PIN.perTurn.modelRequests, sideEffecting: PIN.perTurn.sideEffecting, replaySafe: PIN.perTurn.replaySafe }, `turn ${i + 1}: the scripted calls`);
        assert.equal(p.commits, PIN.perTurn.commits, `turn ${i + 1}: commits`);
        assert.equal(p.full, FULL_ALLOWED.turn(PIN.perTurn, p.commits), `turn ${i + 1}: FULL commits per turn`);
        assert.equal(p.full + p.normal, p.commits, `turn ${i + 1}: every commit is FULL or NORMAL`);
      }
      assert.equal(open.length, PIN.open.commits, "commits while opening");
      assert.equal(full(open), FULL_ALLOWED.open(open.length), "FULL commits while opening");
      for (const end of ["status", "release"] as const) {
        assert.equal(ends[end].length, PIN[end].commits, `${end}: commits`);
        assert.equal(full(ends[end]), FULL_ALLOWED.end(ends[end].length), `${end}: FULL commits`);
      }
    } finally {
      dir.remove();
    }
  });
});
