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

test("a CLI harness (claude-agent) resolves to the adapter loop", async (t) => {
  const { store, deps } = await depsOn(t);
  await store.agents.create({ id: "cli", name: "cli" }, { id: "cli-rev", kind: "agentic", body: { harness: "claude-agent" } });
  await store.runs.create({ id: "cli-run", agentId: "cli", revisionId: "cli-rev" });
  assert.equal(typeof (await resolveRunnerLoop(deps)("claude-agent", LAUNCH, "cli-run")), "function", "a CLI harness runs on the adapter loop");
});

test("an unknown harness resolves to undefined", async (t) => {
  const { store, deps } = await depsOn(t);
  await store.agents.create({ id: "u", name: "u" }, { id: "u-rev", kind: "agentic", body: {} });
  await store.runs.create({ id: "u-run", agentId: "u", revisionId: "u-rev" });
  assert.equal(await resolveRunnerLoop(deps)("made-up-harness", LAUNCH, "u-run"), undefined);
});

test("a learning launch gets the end-of-run step the dispatch wires; a non-learning one gets none", async (t) => {
  const { deps } = await depsOn(t);
  const { learningEndOfRun } = await import("../dist/runner/learning-end.js");
  // The dispatch wires endOfRun = learningEndOfRun(launch, ...) into the loop for a pi or CLI run that learns (its launch
  // carries a learning start), and nothing for one that does not. The step itself is proven end-to-end in
  // runner-learning-end.test.mjs; this pins the dispatch's learning-vs-not decision.
  const learning = { ...LAUNCH, learning: { given: [], seed: null, section: "" } };
  assert.equal(typeof learningEndOfRun(learning, { store: deps.store, data: deps.data, env: {} }), "function", "a learning launch has the end-of-run step");
  assert.equal(learningEndOfRun(LAUNCH, { store: deps.store, data: deps.data, env: {} }), undefined, "a non-learning launch has none");
});
