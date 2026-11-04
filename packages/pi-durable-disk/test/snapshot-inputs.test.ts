// The inputs a door's snapshot carries (`GET /events?inputs=1`, serve.ts): a reader holding a message open learns from them
// how its turn ended, so the snapshot keeps every input whose settlement the reader may not have seen.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { snapshotInputs } from "../src/serve.ts";

const input = (id: number, status: "queued" | "placed" | "done" | "unanswered", entry?: number, requestId?: string) => ({ id, type: "input", status, ...(entry === undefined ? {} : { entry }), ...(requestId === undefined ? {} : { requestId }) });
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

  it("a host's own turn (its request ids under `skip`) is never the newest settled input: after a reflect settle, the run's own inputs still read", () => {
    // A, the run's last message, settled; F queued behind it; then the host's end-of-run turn (learning's reflect request)
    // settled. Started at the reflect settle, the snapshot would drop A, and a reader holding A open could not close it.
    const records = [input(1, "done", 10, "first-r1"), input(2, "queued", undefined, "follow-r1"), input(3, "done", 12, "learn-reflect-r1")];
    assert.deepEqual(ids(snapshotInputs(records, "learn-reflect-")), [1, 2, 3]);
    // With nothing of the run's own settled, every input.
    assert.deepEqual(ids(snapshotInputs([input(2, "queued", undefined, "follow-r1"), input(3, "done", 12, "learn-reflect-r1")], "learn-reflect-")), [2, 3]);
  });

  it("the newest settled input is the one placed last: a follow-up queued before a steer, run after it, is kept", () => {
    // F (id 2), a follow-up, queued while A ran; S (id 3), a steer sent after it, went into A's turn at entry 12 and
    // settled with it; then F was placed at entry 15 and settled last. Its settlement is the run's newest.
    const records = [input(1, "done", 10), input(2, "done", 15), input(3, "done", 12)];
    assert.deepEqual(ids(snapshotInputs(records)), [2, 3], "F, the input placed last, and every one after it by id");
    assert.deepEqual(ids(snapshotInputs([input(1, "done", 10), input(2, "unanswered", 15), input(3, "done", 12)])), [2, 3], "and so when F failed or was stopped");
  });
});
