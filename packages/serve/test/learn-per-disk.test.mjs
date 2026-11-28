// A run's disk, for learning. A run whose launch names a disk of its own (a customer's: run-launch.ts archilDisk, kind
// "launch") keeps that disk on its row (runs.disk) and learns nothing: it starts with no seed, no # Learned section and no
// learned workflow, and every learning read of the agent's runs reads only runs on no named disk (compile's traces and
// its due count, a check's inputs, the money rule's past runs, an audit's served runs, the cost page's ledger). A run
// with no named disk (none, or its agent's own) is the default disk's, where the agent learns. So a customer's traces
// never reach the agent's learned workflows.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { openSqliteStore } from "../dist/store/index.js";
import { startRunner } from "../dist/runner/runner.js";
import { closeOpenSessions, piAdapterSpec } from "./conformance-pi-adapter.mjs";
import { storeOn } from "./store-helpers.mjs";
import { putPromotions } from "./learned-workflow-seed-support.mjs";

const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { learningEndOfRun } = await import("../dist/runner/learning-end.js");
const { launchBody, launchOnItsDisk, readLaunchBody } = await import("../dist/run-launch.js");
const { createDispatchLoop } = await import("../dist/runner/dispatch.js");
const { heldRedactor } = await import("../dist/runner/redact.js");
const { agentCostOverStore, runAllInOverStore } = await import("../dist/store-reads/learning.js");
const { SCHEMA_VERSION } = await import("../dist/store/index.js");
const { notAuditableOf } = await import("../dist/runner/audit.js");
const { lastOwnRuns } = await import("../dist/learn/compile.js");
const { pastRunsOverStore } = await import("../dist/store-reads/learning.js");

const quiet = { beforeIntent: async () => {}, beforeResult: async () => {} };
const TIMING = { leaseMs: 60_000, renewEveryMs: 20_000, stopMarginMs: 5_000, pollMs: 20, commandPollMs: 30 };
const WAIT_MS = 30_000;
after(closeOpenSessions);
const scratch = (name) => mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), name));

/** The marker each disk's runs say in their input: one never found in another disk's learning. */
const MARK = { "disk-a": "ALPACA-ON-DISK-A", "disk-b": "BADGER-ON-DISK-B", default: "DINGO-ON-THE-DEFAULT-DISK" };
const launchDisk = (disk) => (disk ? { archilDisk: { diskId: disk, kind: "launch" } } : {});

/** Workflow `name` (one model step answering the question as a number). */
const flow = (name) => ({
  v: 2, name,
  schemas: { In: { type: "object", properties: { content: { type: "string" } }, required: ["content"] }, Answer: { type: "object", properties: { answer: { type: "number" }, confidence: { type: "number" } }, required: ["answer", "confidence"] } },
  input: { schemaId: "In" }, output: { schemaId: "Answer", path: "answer" },
  root: { node: "chain", steps: [{ node: "extract", label: "answer", instructions: "Answer the question.", out: "Answer", as: "answer" }] },
});
const DRAFT = `\`\`\`\`workflow answer\n---\ndescription: Answers a question as a number; use when asked\nexample: {"content":"What is six times seven?"}\n---\n${JSON.stringify(flow("answer"))}\n\`\`\`\``;

// ---------------------------------------------------------------------------------------------------------------- store

test("a run's disk is kept on its row from its launch: a named disk by its id, its agent's own disk or none as the default (null); a list filters on it", async (t) => {
  const dir = scratch("agentrun-per-disk-store-");
  const store = await openSqliteStore({ dataDir: dir, role: "server" });
  t.after(async () => { await store.close(); rmSync(dir, { recursive: true, force: true }); });
  await store.agents.create({ id: "agent-1", name: "Learns" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer." } });
  const base = { input: { content: "Q" }, title: "t", place: { mode: "runner" } };
  const made = async (id, launch) => store.runs.create({ id, agentId: "agent-1", revisionId: "rev-1" }, { body: launchBody({ ...base, ...launch }) });
  assert.equal((await made("on-a", launchDisk("disk-a"))).disk, "disk-a");
  assert.equal((await made("on-b", launchDisk("disk-b"))).disk, "disk-b");
  assert.equal((await made("on-own", { archilDisk: { diskId: "agent-disk", kind: "agent" } })).disk, null, "the agent's own disk is the default");
  assert.equal((await made("on-none", {})).disk, null);
  assert.equal((await store.runs.create({ id: "no-launch", agentId: "agent-1", revisionId: "rev-1" })).disk, null);
  assert.equal((await store.runs.get("on-b")).disk, "disk-b", "read back as written");
  const ids = async (filter) => (await store.runs.list({ agentId: "agent-1", ...filter })).map((row) => row.id).sort();
  assert.deepEqual(await ids({ disk: "disk-a" }), ["on-a"]);
  assert.deepEqual(await ids({ disk: "disk-b" }), ["on-b"]);
  assert.deepEqual(await ids({ disk: null }), ["no-launch", "on-none", "on-own"]);
  assert.deepEqual(await ids({}), ["no-launch", "on-a", "on-b", "on-none", "on-own"], "no disk named: every run");
});

/** What a run's purge keeps of its spend (store Runs.purge PurgeKept). */
const KEPT = { meters: null, spend: { usd: 0.1, basis: "list" }, learning: null };
const BASE = { input: { content: "Q" }, title: "t", place: { mode: "runner" } };
/** Run `id` of agent-1 on the launch `launch` gives it, ended, then purged: its tombstone. */
async function purgedRun(store, id, launch) {
  await store.runs.create({ id, agentId: "agent-1", revisionId: "rev-1" }, { body: launchBody({ ...BASE, ...launch }) });
  const claim = await store.claim(id, "runner-a", { leaseMs: 60_000 });
  await store.runs.update(claim, { state: "ended", costUsd: 0.1 });
  await store.runs.purge(id, KEPT);
}

test("a store as the run purge left it (version 14, no runs.disk) comes to this version (19) at its server's open, never at a runner's: each run's disk from its launch, a run purged before as the default disk's", async (t) => {
  assert.equal(SCHEMA_VERSION, 19);
  const dir = scratch("agentrun-per-disk-upgrade-");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const first = await openSqliteStore({ dataDir: dir, role: "server" });
  await first.agents.create({ id: "agent-1", name: "Learns" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer." } });
  await first.runs.create({ id: "on-a", agentId: "agent-1", revisionId: "rev-1" }, { body: launchBody({ ...BASE, ...launchDisk("disk-a") }) });
  await first.runs.create({ id: "on-own", agentId: "agent-1", revisionId: "rev-1" }, { body: launchBody({ ...BASE, archilDisk: { diskId: "agent-disk", kind: "agent" } }) });
  await first.runs.create({ id: "on-none", agentId: "agent-1", revisionId: "rev-1" }, { body: launchBody(BASE) });
  // Purged under version 14: its launch body is gone, so nothing names its disk.
  await purgedRun(first, "purged-b", launchDisk("disk-b"));
  await first.close();
  const file = join(dir, "store.sqlite");
  const raw = new DatabaseSync(file);
  try {
    raw.exec("ALTER TABLE runs DROP COLUMN disk");
    raw.exec("UPDATE store_meta SET schema_version = 14 WHERE singleton = 1");
  } finally {
    raw.close();
  }
  const version = () => {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      return db.prepare("SELECT schema_version FROM store_meta").get().schema_version;
    } finally {
      db.close();
    }
  };
  await assert.rejects(openSqliteStore({ dataDir: dir, role: "runner" }), new RegExp(`Start the AgentRun server to bring this store from version 14 to ${SCHEMA_VERSION} before opening a runner`), "a runner, whose learning reads runs by disk, waits for the server");
  assert.equal(version(), 14, "a runner's refusal changes nothing");
  const store = await openSqliteStore({ dataDir: dir, role: "server" });
  try {
    assert.equal(version(), SCHEMA_VERSION);
    assert.deepEqual(await Promise.all(["on-a", "on-own", "on-none", "purged-b"].map(async (id) => (await store.runs.get(id)).disk)), ["disk-a", null, null, null], "each run's disk from its launch: a named one by its id, the agent's own or none as the default; a purged run, its launch gone, the default's");
  } finally {
    await store.close();
  }
  await (await openSqliteStore({ dataDir: dir, role: "server" })).close();
  assert.equal(version(), SCHEMA_VERSION, "a second open changes nothing");
  await (await openSqliteStore({ dataDir: dir, role: "runner" })).close();
});

test("a purged run's tombstone keeps its disk", async (t) => {
  const dir = scratch("agentrun-per-disk-purged-");
  const store = await openSqliteStore({ dataDir: dir, role: "server" });
  t.after(async () => { await store.close(); rmSync(dir, { recursive: true, force: true }); });
  await store.agents.create({ id: "agent-1", name: "Learns" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer." } });
  await purgedRun(store, "purged-b", launchDisk("disk-b"));
  await purgedRun(store, "purged-own", { archilDisk: { diskId: "agent-disk", kind: "agent" } });
  await store.runs.create({ id: "on-none", agentId: "agent-1", revisionId: "rev-1" }, { body: launchBody(BASE) });
  assert.equal((await store.runs.get("purged-b")).disk, "disk-b", "its tombstone keeps its disk");
  assert.equal((await store.runs.get("purged-own")).disk, null, "the agent's own disk is the default");
});

test("learning reads only runs on no named disk since the reset: compile_after's count and a check's inputs, the money rule's past runs and the audit's served runs", async (t) => {
  const clock = { now: Date.parse("2026-11-20T06:00:00Z") };
  const { store } = await storeOn(t, { clock });
  await store.agents.create({ id: "agent-1", name: "Learns" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer." } });
  const ended = async (id, disk, metrics = { path: "agent" }) => {
    clock.now += 1_000;
    await store.runs.create({ id, agentId: "agent-1", revisionId: "rev-1" }, { body: launchBody({ ...BASE, ...launchDisk(disk) }) });
    const claim = await store.claim(id, "runner-a", { leaseMs: 60_000 });
    await store.runs.update(claim, { state: "ended", costUsd: 0.1, metrics });
  };
  const DIGEST = "d".repeat(16);
  const served = { path: "workflow", workflow: "answer", workflow_digest: DIGEST, not_auditable: true };
  await ended("pre-default", null);
  await ended("pre-served", null, served);
  // The agent's reset watermark (learn/promote.ts resetAtKey) at the newest run before it: that run and every older one
  // is before the reset.
  const at = (await store.runs.get("pre-served")).startedAt;
  await store.settings.put("learning.reset-at.agent-1", { at });
  await ended("post-b", "disk-b");
  await ended("post-b-served", "disk-b", served);
  await ended("post-default", null);
  await ended("post-served", null, served);
  assert.deepEqual((await lastOwnRuns(store, "agent-1", 10)).map((row) => row.id), ["post-default"], "compile_after's count and a check's inputs");
  const past = (await pastRunsOverStore(store, "agent-1")).runs;
  assert.deepEqual(past.map((run) => run.startedAt), [at + 4_000, at + 3_000], "the money rule's past runs: post-served and post-default");
  assert.equal(await notAuditableOf(store, "agent-1", "answer", DIGEST, { stop_window: 10 }), 1, "the audit's served runs: post-served alone");
});

test("a runner runs a named-disk launch with no seed, no # Learned section and no learned workflow, whatever its body holds; the body read back keeps what it ran; the agent's own disk or none runs as written", async () => {
  // A start made before its run's disk was read (a run queued before this build, or reopened): the default disk's
  // corrections and workflows in a named-disk run's body.
  const learning = { seed: "a".repeat(40), section: `# Learned\n- ${MARK.default}`, workflows: ["answer"], model: "m-1", use: true };
  const base = { input: { content: "Q" }, title: "t", place: { mode: "runner" }, learning };
  const stored = launchBody({ ...base, ...launchDisk("disk-b") });
  // What the runner's dispatch hands the harness it picks: the launch as the run runs it.
  const ran = async (body) => {
    const seen = [];
    const loop = createDispatchLoop({ launchOf: async () => ({ body }), resolve: (_harness, launch) => void seen.push(launch) })({ redact: heldRedactor((text) => text) });
    await assert.rejects(loop.start({ runId: "run-1" }));
    return seen[0];
  };
  const named = await ran(stored);
  assert.deepEqual(named.learning, { seed: null, section: "", seedFailed: "other_disk", model: "m-1", use: true }, "the run starts with nothing learned, its flags kept");
  assert.equal(JSON.stringify(named).includes(MARK.default), false, "nothing of the default disk's learning reaches the run");
  assert.deepEqual(launchOnItsDisk(readLaunchBody(stored)).learning, named.learning, "the child process's read is the same");
  assert.deepEqual(readLaunchBody(stored).learning, learning, "a finished run's views read what its body says");
  const own = launchBody({ ...base, archilDisk: { diskId: "agent-disk", kind: "agent" } });
  assert.deepEqual((await ran(own)).learning, learning, "the agent's own disk is the default: its start as written");
  assert.deepEqual((await ran(launchBody(base))).learning, learning);
});

// -------------------------------------------------------------------------------------------- compile (the look-back)

/** One agent (compile_after 2) whose runs run through a real runner, one at a time, each on its disk (`disk`: a named
 *  one, or none for the default): a run that learns gets its learning end over the agent's learning rows. Every model
 *  request a run makes is kept. */
async function world(t) {
  const local = scratch("agentrun-per-disk-local-");
  const server = await openSqliteStore({ dataDir: local, role: "server" });
  const open = [];
  t.after(async () => {
    for (const close of open.reverse()) await close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(local, { recursive: true, force: true });
  });
  await server.agents.create({ id: "agent-1", name: "Learns" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer.", tools: ["read"], learning: { compile_after: 2 } } });
  const run = async (runId, { disk, content, learns = false }) => {
    const seed = learns ? (await server.learning.seed("agent-1")).save.id : undefined;
    const launch = { input: { content }, title: "t", place: { mode: "runner" }, ...launchDisk(disk), ...(learns ? { learning: { seed, section: "" } } : {}) };
    await server.runs.create({ id: runId, agentId: "agent-1", revisionId: "rev-1" }, { body: launchBody(launch) });
    const store = await openSqliteStore({ dataDir: local, role: "runner" });
    open.push(() => store.close());
    const endOfRun = learningEndOfRun(launch, { store, data: local, env: {} });
    const requests = [];
    const spec = piAdapterSpec({ script: learns ? [{ say: "42" }, { say: DRAFT }] : [{ say: "42" }], tools: {}, hooks: quiet }, { requests });
    const createLoop = (deps) => {
      const job = createAdapterLoop(async (claim, r) => ({ ...(await spec(claim, r)), agentId: "agent-1", input: content, ...(endOfRun ? { endOfRun } : {}) }))(deps);
      let mine = false;
      let release;
      const parked = new Promise((resolve) => (release = resolve));
      return {
        start: (claim) => (claim.runId === runId ? ((mine = true), job.start(claim)) : parked),
        command: (row) => (mine ? job.command(row) : Promise.resolve({ refused: "not run here" })),
        stop: async (reason) => (mine ? job.stop(reason) : release({ state: "interrupted" })),
      };
    };
    const runner = startRunner({ store, createLoop, name: `runner-${runId}`, ...TIMING });
    open.push(() => runner.close());
    const deadline = Date.now() + WAIT_MS;
    for (;;) {
      const row = await server.runs.get(runId);
      if (row.state === "ended" && row.runner === null) break;
      if (Date.now() > deadline) throw new Error(`${runId} did not end: ${JSON.stringify(row)}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await runner.close();
    return { requests, said: JSON.stringify(requests), kept: await server.learning.proposal(runId) };
  };
  return { run, server };
}

test("a default-disk run and a named-disk run share no learning: the default disk's compile reads only default-disk runs", { timeout: 120_000 }, async (t) => {
  const w = await world(t);
  await w.run("a-1", { disk: "disk-a", content: `What is six times seven? ${MARK["disk-a"]}` });
  await w.run("b-1", { disk: "disk-b", content: `What is six times seven? ${MARK["disk-b"]}` });
  // One default-disk run before: compile_after 2 counts it and the ending one, never a named disk's runs.
  await w.run("d-1", { content: `What is six times seven? ${MARK.default}` });
  const d2 = await w.run("d-2", { content: "What is six times seven?", learns: true });
  assert.ok(d2.said.includes("````workflow"), "d-2's compile turn was asked");
  assert.ok(d2.said.includes(MARK.default), "the default disk's earlier run is read");
  assert.equal(d2.said.includes(MARK["disk-a"]), false, "no run on disk A reaches the default disk's compile");
  assert.equal(d2.said.includes(MARK["disk-b"]), false, "no run on disk B reaches the default disk's compile");
});

// ---------------------------------------------------------------------------------------------------------- the bill

test("the cost page's revision ledger is the default disk's: a named disk's replays add nothing to a default revision's check, and its served runs take none of its shares", async (t) => {
  const clock = { now: Date.parse("2026-11-20T06:00:00Z") };
  const { store } = await storeOn(t, { clock });
  await store.agents.create({ id: "agent-1", name: "Learns" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer.", learning: true } });
  const A = "a".repeat(16);
  const end = async (id, disk, cost, metrics, extra = {}) => {
    clock.now += 60_000;
    const launch = { input: { content: "Q" }, title: "t", place: { mode: "runner" }, learning: { seed: "a".repeat(40), section: "" }, ...launchDisk(disk), ...extra };
    await store.runs.create({ id, agentId: "agent-1", revisionId: "rev-1" }, { body: launchBody(launch) });
    const claim = await store.claim(id, "runner-a", { leaseMs: 60_000 });
    await store.runs.update(claim, { state: "ended", costUsd: cost, metrics });
  };
  const replay = { path: "replay", workflow: "answer", workflow_digest: A, replay: { of: "run-01", outcome: "answered" } };
  const served = { path: "workflow", workflow: "answer", workflow_digest: A };
  await end("run-01", null, 1, { path: "agent" });
  await end("replay-d", null, 0.3, replay, { replay: { of: "run-01", workflow: "answer", digest: A } });
  await end("replay-b", "disk-b", 0.5, replay, { replay: { of: "run-01", workflow: "answer", digest: A } });
  const promoted = new Date(clock.now + 30_000).toISOString();
  await end("served-b1", "disk-b", 0.1, served);
  await end("served-b2", "disk-b", 0.1, served);
  await end("served-d1", null, 0.1, served);
  await end("served-d2", null, 0.1, served);
  const check = { compile_after: 2, agree_min: 0.8, alone_min: 0.7, attempt: 1, n: 1, agreed: 1, alone: 1, of: ["run-01"], cost_usd: 0.3 };
  await putPromotions(store, "agent-1", [{ workflow: "answer", digest: A, at: promoted, decided: "promote", reason: "checked: promoted", check }]);
  const cost = await agentCostOverStore(store, "agent-1");
  assert.deepEqual(cost.bill.revisions.map((one) => [one.digest, one.check_usd, one.served, one.attributed_usd, one.unattributed_usd]), [[A, 0.3, 2, 0.3, 0]], JSON.stringify(cost.bill.revisions));
  // Each run's own figures read the same ledger: the default disk's first K served runs carry its check, disk B's none.
  const shares = await Promise.all(["served-b1", "served-b2", "served-d1", "served-d2"].map(async (id) => (await runAllInOverStore(store, id)).learning_usd));
  assert.deepEqual(shares, [0, 0, 0.15, 0.15]);
});
