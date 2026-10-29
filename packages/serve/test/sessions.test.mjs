// A run's harness sessions in its own durable store: records come back in the order they were appended, a later
// process (another Harness on the same storage) reads them back, and one writer holds a session: the newest open fences
// every earlier writer of the key, whose append then writes nothing.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createRegistry, Harness, MemoryStorage, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { SessionFenced } from "@parcha/agentrun-adapters";
import { FencedError } from "@parcha/pi-durable-disk";
import { foldSession, openDrive } from "@parcha/agentrun-adapters/kernel";
import { durableSessions } from "../dist/sessions.js";

const harnessOn = (storage) => Harness.open(storage, { registry: createRegistry(), models: {} }, ctx);
const record = (n) => ({ kind: "kernel.test", data: { n, text: `record ${n}` } });

test("a session's records come back in order, per key, and a later Harness on the same store reads them", async () => {
  const storage = new MemoryStorage();
  const sessions = durableSessions(await harnessOn(storage), ctx);
  assert.deepEqual(await sessions.read("node-1"), [], "a key never opened has no records");
  const one = await sessions.open("node-1");
  await one.append([record(1), record(2)]);
  await one.append([record(3)]);
  const two = await sessions.open("node-2");
  await two.append([record(9)]);
  assert.deepEqual(await sessions.read("node-1"), [record(1), record(2), record(3)]);
  assert.deepEqual(await two.read(), [record(9)], "each key is its own session");
  const later = durableSessions(await harnessOn(storage), ctx);
  assert.deepEqual(await later.read("node-1"), [record(1), record(2), record(3)], "the next process reads what this one wrote");
  const resumed = await later.open("node-1");
  await resumed.append([record(4)]);
  assert.deepEqual((await later.read("node-1")).map((r) => r.data.n), [1, 2, 3, 4], "and goes on from it");
});

test("the newest open of a key is its one writer: an earlier writer's append is refused SessionFenced and writes nothing", async () => {
  const sessions = durableSessions(await harnessOn(new MemoryStorage()), ctx);
  const first = await sessions.open("node-1");
  await first.append([record(1)]);
  const second = await sessions.open("node-1");
  await assert.rejects(first.append([record(2), record(3)]), (error) => error instanceof SessionFenced && error.key === "node-1");
  await second.append([record(4)]);
  assert.deepEqual((await sessions.read("node-1")).map((r) => r.data.n), [1, 4]);
});

test("a door submission recorded through the drive while one of its effects is in flight: no Restart, the effect completes, pending() shows the submission, and the live state is a fresh fold of the store", async () => {
  const sessions = durableSessions(await harnessOn(new MemoryStorage()), ctx);
  const drive = await openDrive({ writer: await sessions.open("run-1"), signal: new AbortController().signal });
  let release;
  const held = new Promise((resolve) => (release = resolve));
  const effect = drive.effect("tool-1", { name: "read", replay: "never", input: { path: "a.txt" } }, async () => {
    await held;
    return { text: "done" };
  });
  await drive.submit({ id: "s1", kind: "followUp", text: "and then?" });
  release();
  assert.deepEqual(await effect, { text: "done" }, "the effect completes: its writer was never fenced");
  await drive.submit({ id: "s2", kind: "followUp", text: "one more" });
  assert.deepEqual(drive.pending().map((s) => s.id), ["s1", "s2"]);
  assert.deepEqual(drive.state(), foldSession("run-1", await sessions.read("run-1")), "the live drive and a fresh fold of what the store holds agree");
});

/** A store whose commits the run's lease refuses once `fence` is set, as a run whose lease lapsed sees them. */
/** A run's store whose commits its lease can refuse. Closing it ends one process's use of the store, not the store: the
 *  next process's Harness opens the same records (pi 1.2 and later close a Harness's storage when a commit fails). */
class LeasedStorage extends MemoryStorage {
  fence = null;
  async commit(writes, context) {
    if (this.fence) throw this.fence;
    return super.commit(writes, context);
  }
  async close() {}
}

const keyEntries = async (harness, key) => {
  const root = await harness.conversation(ROOT_CONVERSATION_ID, ctx);
  const out = [];
  for (let cursor; ; ) {
    const page = await root.entries({ order: "ascending" }, 500, cursor, ctx);
    out.push(...page.items.filter((e) => e.kind === "session.key" && e.data.key === key));
    if (page.next === undefined) return out;
    cursor = page.next;
  }
};

test("two first opens of a new key at once make one session: one key entry, and a later Harness reads the newer writer's records", async () => {
  const storage = new MemoryStorage();
  const harness = await harnessOn(storage);
  const sessions = durableSessions(harness, ctx);
  const [older, newer] = await Promise.all([sessions.open("node-1"), sessions.open("node-1")]);
  await newer.append([record(1), record(2)]);
  await assert.rejects(older.append([record(9)]), (error) => error instanceof SessionFenced);
  assert.equal((await keyEntries(harness, "node-1")).length, 1, "one conversation for the key");
  assert.deepEqual((await durableSessions(await harnessOn(storage), ctx).read("node-1")).map((r) => r.data.n), [1, 2]);
});

test("a commit the run's lease refuses is SessionFenced, whether the FencedError is the error or its cause, and writes nothing", async () => {
  for (const wrap of [(fenced) => fenced, (fenced) => new Error("the commit failed", { cause: fenced })]) {
    const storage = new LeasedStorage();
    const sessions = durableSessions(await harnessOn(storage), ctx);
    const writer = await sessions.open("node-1");
    await writer.append([record(1)]);
    storage.fence = wrap(new FencedError("the run's lease lapsed"));
    await assert.rejects(writer.append([record(2)]), (error) => error instanceof SessionFenced && error.key === "node-1");
    storage.fence = null;
    // A Harness that had a commit refused is done; the next process reads the store.
    assert.deepEqual((await durableSessions(await harnessOn(storage), ctx).read("node-1")).map((r) => r.data.n), [1], "nothing of the refused append");
  }
});

test("a long session reads back whole, past one page of entries", async () => {
  const storage = new MemoryStorage();
  const writer = await durableSessions(await harnessOn(storage), ctx).open("node-1");
  const many = Array.from({ length: 1_203 }, (_, n) => record(n));
  for (let at = 0; at < many.length; at += 400) await writer.append(many.slice(at, at + 400));
  const read = await durableSessions(await harnessOn(storage), ctx).read("node-1");
  assert.equal(read.length, 1_203);
  assert.deepEqual(read.map((r) => r.data.n), many.map((r) => r.data.n), "in order");
});
