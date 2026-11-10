// The run-change feed's contract (Store.runs.changedSince), as cases any store runs: the SQLite store here
// (store-run-changes.test.mjs), the Postgres store with its own subject. A change is a run reaching a final state, or its
// runner letting it go (parked, or running with no runner); the feed reads them by an opaque cursor in commit order,
// never by time, so writes in one millisecond are neither lost nor repeated, and a change committed below one already
// read (an out-of-order commit, possible with concurrent writers) is still read.
//
// runRunChangeCases(test, subject): `subject.open(t)` gives { store, clock, other? }: a store with an agent "agent-1" and
// its revision "rev-1", its clock ({ now }, every write stamped at clock.now), and `other()`, a second connection to the
// same data. `subject.outOfOrder(store, [first, second])`, when the store can hold two transactions open at once: runs
// `first` and `second` (each an async function writing through `store`) so that `second` commits before `first`, with
// `first` taking the lower sequence; a store with one writer has none, and that case is skipped, saying why.
import assert from "node:assert/strict";

const FINAL = ["ended", "stopped", "failed"];

/** Every change after `cursor`, paging `limit` at a time: the changes and the last cursor. */
export async function readAll(store, cursor, limit) {
  const changes = [];
  let at = cursor;
  for (;;) {
    const page = await store.runs.changedSince(at, limit === undefined ? {} : { limit });
    changes.push(...page.changes);
    const moved = page.next !== at;
    at = page.next;
    if (page.changes.length === 0 || !moved) return { changes, cursor: at };
  }
}

/** A queued run `id` of agent-1 claimed by `runner`. */
async function claimed(store, id, runner = "runner-a") {
  await store.runs.create({ id, agentId: "agent-1", revisionId: "rev-1" });
  const claim = await store.claim(id, runner, { leaseMs: 60_000 });
  assert.ok(claim, `run ${id} is claimed`);
  return claim;
}

export function runRunChangeCases(test, subject) {
  test("run changes: a run reaching each final state, and one its runner lets go (parked, or running with none), is a change with its id, state, endedAt, epoch and runner; a claim, a renew and a fence touch are none", async (t) => {
    const { store } = await subject.open(t);
    const start = (await store.runs.changedSince(undefined)).next;
    // A claim, then a renew: a runner takes and keeps the run, which is no change.
    const kept = await claimed(store, "run-kept");
    await store.renew(kept, { leaseMs: 60_000 });
    assert.deepEqual((await store.runs.changedSince(start)).changes, [], "a claim and a renew are no change");
    // Each final state, through the run's end write.
    for (const state of FINAL) await store.runs.update(await claimed(store, `run-${state}`), { state });
    // A runner letting go: parked, and running with no runner (a release mid-run).
    await store.release(await claimed(store, "run-parked"), { state: "parked" });
    await store.release(await claimed(store, "run-released"));
    const { changes } = await readAll(store, start);
    const byRun = Object.fromEntries(changes.map((change) => [change.id, change]));
    assert.deepEqual(changes.map((change) => change.id), ["run-ended", "run-stopped", "run-failed", "run-parked", "run-released"], `one change each, in commit order: ${JSON.stringify(changes)}`);
    for (const state of FINAL) {
      const change = byRun[`run-${state}`];
      const row = await store.runs.get(`run-${state}`);
      assert.deepEqual({ state: change.state, endedAt: change.endedAt, epoch: change.epoch, runner: change.runner }, { state, endedAt: row.endedAt, epoch: row.epoch, runner: row.runner }, `the ${state} change carries the row as committed`);
      assert.ok(typeof change.endedAt === "number", `a final change carries its endedAt: ${JSON.stringify(change)}`);
    }
    assert.deepEqual([byRun["run-parked"].state, byRun["run-parked"].runner], ["parked", null]);
    assert.deepEqual([byRun["run-released"].state, byRun["run-released"].runner, byRun["run-released"].endedAt], ["running", null, null]);
  });

  test("run changes: every change in one millisecond is read once, none missed, paging two at a time, and a read from the last cursor is empty", async (t) => {
    const { store } = await subject.open(t);
    const start = (await store.runs.changedSince(undefined)).next;
    // The clock does not move: every write below is stamped in the same millisecond.
    const ids = Array.from({ length: 7 }, (_, i) => `run-same-ms-${i}`);
    for (const id of ids) await store.runs.update(await claimed(store, id), { state: "ended" });
    const { changes, cursor } = await readAll(store, start, 2);
    assert.deepEqual(changes.map((change) => change.id), ids, "each change once, in commit order");
    assert.deepEqual((await store.runs.changedSince(cursor)).changes, [], "nothing again from the last cursor");
    // One more change after the last read is read, once, from that cursor.
    await store.runs.update(await claimed(store, "run-after"), { state: "failed" });
    assert.deepEqual((await readAll(store, cursor, 2)).changes.map((change) => change.id), ["run-after"]);
  });

  test("run changes: a page is at most the limit asked (200 by default), oldest first, with the cursor to the next", async (t) => {
    const { store } = await subject.open(t);
    const start = (await store.runs.changedSince(undefined)).next;
    for (let i = 0; i < 5; i++) await store.runs.update(await claimed(store, `run-page-${i}`), { state: "ended" });
    const first = await store.runs.changedSince(start, { limit: 3 });
    assert.deepEqual(first.changes.map((change) => change.id), ["run-page-0", "run-page-1", "run-page-2"]);
    const second = await store.runs.changedSince(first.next, { limit: 3 });
    assert.deepEqual(second.changes.map((change) => change.id), ["run-page-3", "run-page-4"]);
  });

  test("run changes: the head (changesHead) is, in one read, the cursor a reader holds after draining the feed; nothing is read from it, and a change made after it is read from it once", async (t) => {
    const { store } = await subject.open(t);
    // A feed with nothing in it: the head is where a reader from the start stands.
    assert.equal(await store.runs.changesHead(), (await readAll(store, undefined)).cursor, "an empty feed's head is the drained cursor");
    for (const state of FINAL) await store.runs.update(await claimed(store, `run-head-${state}`), { state });
    await store.release(await claimed(store, "run-head-parked"), { state: "parked" });
    const head = await store.runs.changesHead();
    const drained = await readAll(store, undefined, 2);
    assert.equal(head, drained.cursor, "the head is the cursor after draining, paged or not");
    assert.deepEqual((await store.runs.changedSince(head)).changes, [], "nothing is read from the head");
    await store.runs.update(await claimed(store, "run-after-head"), { state: "ended" });
    assert.deepEqual((await readAll(store, head)).changes.map((change) => change.id), ["run-after-head"], "a change after the head is read from it, once");
  });

  test("run changes: two connections writing at once: every change is read once, none missed", async (t) => {
    const { store, other } = await subject.open(t);
    const second = await other();
    const start = (await store.runs.changedSince(undefined)).next;
    const ids = Array.from({ length: 12 }, (_, i) => `run-two-${i}`);
    // Half the runs claimed on each connection, then all of them ended at once, each by its own connection.
    const claims = await Promise.all(ids.map((id, i) => claimed(i % 2 ? second : store, id, i % 2 ? "runner-b" : "runner-a")));
    await Promise.all(claims.map((claim, i) => (i % 2 ? second : store).runs.update(claim, { state: "ended" })));
    const { changes } = await readAll(store, start, 5);
    assert.deepEqual(changes.map((change) => change.id).sort(), [...ids].sort(), `each run's change once: ${JSON.stringify(changes.map((change) => change.id))}`);
  });

  test("run changes: a change committed below one already read (an out-of-order commit) is still read, and never twice", { skip: subject.outOfOrder ? false : `${subject.name}: one writer, so its changes commit in the order they are numbered` }, async (t) => {
    const { store } = await subject.open(t);
    const start = (await store.runs.changedSince(undefined)).next;
    const low = await claimed(store, "run-low");
    const high = await claimed(store, "run-high");
    let seen;
    await subject.outOfOrder(store, [
      () => store.runs.update(low, { state: "ended" }),
      async () => {
        await store.runs.update(high, { state: "ended" });
        // Read after the higher change committed and before the lower one does.
        seen = await readAll(store, start);
      },
    ]);
    const after = await readAll(store, seen.cursor);
    const ids = [...seen.changes, ...after.changes].map((change) => change.id);
    assert.deepEqual([...ids].sort(), ["run-high", "run-low"], `both read, each once: ${JSON.stringify(ids)}`);
  });
}
