// The run_launch table in the one store (A): the server writes a run's launch body in the SAME transaction as the queued
// run (both or neither), by runs.create or triggers.fire; the runner reads it at its claim by store.runs.launch. A run with
// no launch row is a named refusal (StoreLaunchMissing), never a default. The body goes through run-launch.ts, so these
// store tests carry the body opaquely and leave the launch shape to run-launch.test.mjs.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const { openSqliteStore } = await import("../dist/store/index.js");
const { launchBody, readLaunchBody } = await import("../dist/run-launch.js");

const dirs = [];
after(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function freshStore() {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-launch-"));
  dirs.push(dir);
  const store = await openSqliteStore({ file: join(dir, "store.sqlite"), role: "server" });
  after(() => store.close().catch(() => undefined));
  await store.agents.create({ id: "a1", name: "Agent one" }, { id: "r1", kind: "agentic", body: { instructions: "Answer." } });
  return store;
}

const sampleLaunch = () => ({ input: { messages: [{ role: "user", content: "hi" }] }, title: "A run", place: { mode: "runner" }, effort: "high", maxCostUsd: 2.5 });

test("runs.create writes the launch row, and runs.launch reads its body back", async () => {
  const store = await freshStore();
  const launch = sampleLaunch();
  await store.runs.create({ id: "run-1", agentId: "a1", revisionId: "r1" }, { body: launchBody(launch) });
  const row = await store.runs.launch("run-1");
  assert.equal(row.runId, "run-1");
  assert.equal(row.sealed, null);
  assert.deepEqual(readLaunchBody(row.body), launch);
});

test("a run created with no launch has no launch row: StoreLaunchMissing, not a default", async () => {
  const store = await freshStore();
  await store.runs.create({ id: "run-2", agentId: "a1", revisionId: "r1" });
  await assert.rejects(store.runs.launch("run-2"), (error) => error.name === "StoreLaunchMissing" && error.runId === "run-2");
});

test("an unknown run reads as StoreLaunchMissing too", async () => {
  const store = await freshStore();
  await assert.rejects(store.runs.launch("nope"), (error) => error.name === "StoreLaunchMissing");
});

// The fired-trigger launch (store.triggers.fire calling writeLaunch) lands with route-1's fire change, which owns that body.

test("a sandbox place in the launch body round-trips through the store", async () => {
  const store = await freshStore();
  const launch = { input: { ask: "x" }, title: "", place: { mode: "sandbox", box: "docker" } };
  await store.runs.create({ id: "run-3", agentId: "a1", revisionId: "r1" }, { body: launchBody(launch) });
  assert.deepEqual(readLaunchBody((await store.runs.launch("run-3")).body), launch);
});

test("a sealed column round-trips its bytes, the store never opening them", async () => {
  const store = await freshStore();
  const sealed = new Uint8Array([0, 1, 2, 250, 255]);
  await store.runs.create({ id: "run-4", agentId: "a1", revisionId: "r1" }, { body: launchBody(sampleLaunch()), sealed });
  const row = await store.runs.launch("run-4");
  assert.deepEqual(row.sealed, sealed);
});

test("create is atomic: a run whose revision is unknown writes neither the run nor a launch row", async () => {
  const store = await freshStore();
  await assert.rejects(store.runs.create({ id: "run-5", agentId: "a1", revisionId: "nope" }, { body: launchBody(sampleLaunch()) }));
  assert.equal(await store.runs.get("run-5"), undefined);
  await assert.rejects(store.runs.launch("run-5"), (error) => error.name === "StoreLaunchMissing");
});

test("the sealed column is the run's for its life: a command or a reopen replaces it in its own write, the end erases it, a steer waiting at the end keeps it, and a final run takes neither", async () => {
  const store = await freshStore();
  const bytes = (n) => new Uint8Array([n, n, n]);
  await store.runs.create({ id: "run-6", agentId: "a1", revisionId: "r1" }, { body: launchBody(sampleLaunch()), sealed: bytes(1) });
  await store.command("run-6", { kind: "steer", body: { text: "more" } }, { launchSealed: bytes(2) });
  assert.deepEqual((await store.runs.launch("run-6")).sealed, bytes(2), "replaced with the command");
  let claim = await store.claim("run-6", "runner-a", { leaseMs: 60_000 });
  // A steer still waiting when the run ends opens it again (refuseLeftovers): its credential stays for that turn.
  await store.runs.update(claim, { state: "ended", outcome: "completed" });
  assert.equal((await store.runs.get("run-6")).state, "running", "opened again by its waiting steer");
  assert.deepEqual((await store.runs.launch("run-6")).sealed, bytes(2), "kept for the turn it opens");
  claim = await store.claim("run-6", "runner-a", { leaseMs: 60_000 });
  for (const command of await store.commands("run-6", 0)) await store.take(claim, command.id);
  await store.runs.update(claim, { state: "ended", outcome: "completed" });
  assert.equal((await store.runs.launch("run-6")).sealed, null, "erased by the write that ended it");
  await assert.rejects(store.runs.launch("run-6").then(() => store.command("run-6", { kind: "cancel", body: {} }, { launchSealed: bytes(3) })), (error) => error.name === "RunFinal");
  assert.equal((await store.runs.launch("run-6")).sealed, null, "a final run's refused command writes nothing");
  await store.runs.reopen("run-6", { kind: "steer", body: { text: "again" } }, { launchSealed: bytes(4) });
  assert.deepEqual((await store.runs.launch("run-6")).sealed, bytes(4), "a follow-up that opens it again hands its own");
});
