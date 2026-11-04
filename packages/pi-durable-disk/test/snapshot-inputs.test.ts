// The inputs a door's snapshot carries (`GET /events?inputs=1`, serve.ts): a reader holding a message open learns from them
// how its turn ended, so the snapshot keeps every input whose settlement the reader may not have seen.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { snapshotInputs } from "../src/serve.ts";

const input = (id: number, status: "queued" | "placed" | "done" | "unanswered", entry?: number) => ({ id, type: "input", status, ...(entry === undefined ? {} : { entry }) });
const ids = (records: readonly { id: number }[]) => records.map((record) => record.id);

describe("snapshotInputs", () => {
  it("the newest settled input and every one after it; with none settled, every one", () => {
    const records = [input(1, "done", 10), input(2, "unanswered", 12), input(3, "done", 14), input(4, "placed", 16), input(5, "queued")];
    assert.deepEqual(ids(snapshotInputs(records)), [3, 4, 5]);
    assert.deepEqual(ids(snapshotInputs([input(4, "placed", 16), input(5, "queued")])), [4, 5]);
    assert.deepEqual(snapshotInputs([]), []);
  });

  it("and every one before it not settled yet: a steer settles ahead of a follow-up queued before it", () => {
    // F, a follow-up, queued while A ran; S, a steer sent after it, went into A's turn and settled with it. F is still to
    // run: a reader that holds F open must find it here, or it would read F's absence as settled.
    const records = [input(1, "done", 10), input(2, "queued"), input(3, "done", 12)];
    assert.deepEqual(ids(snapshotInputs(records)), [2, 3]);
    // One withdrawn before it was placed (unanswered, no entry) had no turn: it is settled, and left out.
    assert.deepEqual(ids(snapshotInputs([input(1, "unanswered"), input(2, "placed", 11), input(3, "done", 12)])), [2, 3]);
  });
});
