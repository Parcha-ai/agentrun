// A run's harness sessions in its own durable store: records come back in the order they were appended, a later
// process (another Harness on the same storage) reads them back, and one writer holds a session: the newest open fences
// every earlier writer of the key, whose append then writes nothing.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { SessionFenced } from "@parcha/agentrun-adapters";
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
