// The runner's dispatch switch (harness-loops.ts resolveRunnerLoop) returns the inner loop a claimed run runs on: a
// workflow revision on the workflow loop (whatever its harness), harness "learning" on the learning loop, pi on the
// kernel's adapter loop, and anything else undefined (the dispatch fails it in words). Each case returns a loop factory
// (a function) or undefined.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const { openSqliteStore } = await import("../dist/store/sqlite/store.js");
const { resolveRunnerLoop } = await import("../dist/runner/harness-loops.js");

const stubRoute = async () => ({ model: "m", provider: { api: "anthropic-messages", origin: "https://route.invalid", credential: () => "k" } });
const LAUNCH = { input: {}, title: "t", place: { mode: "runner" } };

async function depsOn(t) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "resolve-"));
  const store = await openSqliteStore({ dataDir: dir, role: "server" });
  t.after(async () => { await store.close().catch(() => {}); rmSync(dir, { recursive: true, force: true }); });
  const deps = { env: {}, data: dir, journal: () => { throw new Error("the journal is not read by resolve"); }, store, sealKey: Buffer.alloc(32), routeOf: stubRoute };
  return { store, deps };
}

test("a workflow revision resolves to the workflow loop, not undefined", async (t) => {
  const { store, deps } = await depsOn(t);
  await store.agents.create({ id: "wf", name: "wf" }, { id: "wf-rev", kind: "workflow", body: { workflow: "flow main {}" } });
  await store.runs.create({ id: "wf-run", agentId: "wf", revisionId: "wf-rev" });
  assert.equal(typeof (await resolveRunnerLoop(deps)("pi", LAUNCH, "wf-run")), "function", "a workflow revision runs on the workflow loop");
});

test("harness learning resolves to the learning loop", async (t) => {
  const { deps } = await depsOn(t);
  assert.equal(typeof (await resolveRunnerLoop(deps)("learning", LAUNCH, "any-run")), "function", "harness learning runs on the learning loop");
});

test("an agentic pi revision resolves to the adapter loop", async (t) => {
  const { store, deps } = await depsOn(t);
  await store.agents.create({ id: "pi", name: "pi" }, { id: "pi-rev", kind: "agentic", body: { instructions: "a" } });
  await store.runs.create({ id: "pi-run", agentId: "pi", revisionId: "pi-rev" });
  assert.equal(typeof (await resolveRunnerLoop(deps)("pi", LAUNCH, "pi-run")), "function");
});

test("an unknown harness resolves to undefined", async (t) => {
  const { store, deps } = await depsOn(t);
  await store.agents.create({ id: "u", name: "u" }, { id: "u-rev", kind: "agentic", body: {} });
  await store.runs.create({ id: "u-run", agentId: "u", revisionId: "u-rev" });
  assert.equal(await resolveRunnerLoop(deps)("made-up-harness", LAUNCH, "u-run"), undefined);
});
