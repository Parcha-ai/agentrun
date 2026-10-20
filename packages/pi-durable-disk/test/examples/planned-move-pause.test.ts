// examples/planned-move: while it waits for host A's run to pause, a host A instance that has ended without pausing the run
// fails the wait at once, with what the instance logged, instead of timing out three minutes later. The wait's decision is a
// function of three reads (the run's record, its delegations, the unit's state), so it runs here on fakes, with no keys.
import { describe, it } from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import assert from "node:assert/strict";
import type { HostStatus, RunRecord } from "../../src/index.ts";
import { pausedOrEnded, type PauseReads } from "../../examples/planned-move/pause.ts";

// What the example reads of a record: its status.
type Record = Pick<RunRecord, "status">;

const record = (status: RunRecord["status"]): Record => ({ status });

/** Reads that answer from queues: each call takes the next answer, and the last one repeats. */
function reads(over: { records: (Record | null)[]; delegations?: number; states: HostStatus[]; journal?: string }): PauseReads<Record> {
  const next = <T>(queue: T[]) => (queue.length > 1 ? queue.shift()! : queue[0]!);
  return {
    status: async () => next(over.records),
    delegations: async () => Array.from({ length: over.delegations ?? 0 }),
    unit: async () => next(over.states),
    journal: () => over.journal ?? "",
  };
}

describe("pausedOrEnded", () => {
  it("answers the record once the run is paused with no delegation left", async () => {
    const paused = record("paused");
    assert.equal(await pausedOrEnded(reads({ records: [paused], states: ["running"] })), paused);
  });

  it("keeps waiting while the run is not paused and the unit runs, or its state cannot be judged", async () => {
    assert.equal(await pausedOrEnded(reads({ records: [record("running")], states: ["running"] })), false);
    assert.equal(await pausedOrEnded(reads({ records: [null], states: ["unknown"] })), false);
  });

  it("keeps waiting for the delegation to go when the run is paused, even if the unit has already exited", async () => {
    assert.equal(await pausedOrEnded(reads({ records: [record("paused")], delegations: 1, states: ["stopped"] })), false);
  });

  it("fails at once when the unit has ended and the run is not paused, with the unit's state and its last log lines", async () => {
    for (const state of ["failed", "stopped", "gone"] as const) {
      await assert.rejects(
        pausedOrEnded(reads({ records: [record("running")], states: [state], journal: "pi-durable-disk: fenced (STORE_FENCED): store fenced by SQLite result code 5898" })),
        (error: unknown) => /host A's instance ended \(unit \w+\) before the run paused/.test((error as Error).message) && (error as Error).message.includes(state) && (error as Error).message.includes("STORE_FENCED"),
        state,
      );
    }
    await assert.rejects(pausedOrEnded(reads({ records: [record("running")], states: ["failed"] })), /no log lines/);
  });

  it("does not fail a unit that paused the run and exited between the two reads: it reads the record once more first", async () => {
    const paused = record("paused");
    assert.equal(await pausedOrEnded(reads({ records: [record("running"), paused], states: ["stopped"] })), paused);
  });
});

describe("the planned-move README", () => {
  it("names every .ts file of the example, because the package ships none and a reader copies them from the tag", () => {
    const dir = new URL("../../examples/planned-move/", import.meta.url);
    const readme = readFileSync(new URL("README.md", dir), "utf8");
    const copied = /put ([^\n]*?) in this directory/.exec(readme)?.[1] ?? "";
    for (const file of readdirSync(dir).filter((name) => name.endsWith(".ts"))) {
      assert.ok(copied.includes(file), `the copy instruction names ${file}: "${copied}"`);
    }
  });
});
