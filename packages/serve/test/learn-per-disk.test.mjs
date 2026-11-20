// Learning is per (agent, disk). A run whose launch names a disk of its own (a customer's: run-launch.ts archilDisk, kind
// "launch") keeps its learning folder on that disk, and everything learning reads of the agent's runs reads only the runs
// on the disk of the folder it writes: compile's traces and its due count, a check's replay inputs, an audit's draw, the
// promotions and grades kept for it. A run with no named disk (none, or its agent's own) is the default disk's. So one
// customer's traces never reach another customer's learned workflow, and a workflow promoted on one disk never serves a
// run on another.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { openSqliteStore } from "../dist/store/index.js";
import { startRunner } from "../dist/runner/runner.js";
import { closeOpenSessions, piAdapterSpec } from "./conformance-pi-adapter.mjs";
import { storeOn } from "./store-helpers.mjs";

const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { learningEndOfRun } = await import("../dist/runner/learning-end.js");
const { seedOf, secretsShown } = await import("../dist/learning.js");
const { learningWorkspace } = await import("../dist/workspace/index.js");
const { launchBody, readLaunchBody } = await import("../dist/run-launch.js");
const { agentCostOverStore, runAllInOverStore } = await import("../dist/store-reads/learning.js");
const { promotionGate } = await import("../dist/runner/promotion.js");
const { promotionsOf, recordPromotion } = await import("../dist/learn/promote.js");
const { learningIdOf } = await import("../dist/learn/learning-of.js");
const { workflowDigest } = await import("../dist/runner/workflow-first.js");
const { startAudit } = await import("../dist/runner/audit.js");

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

test("a store an earlier build made (no runs.disk) opens: a runner refuses it until the server adds the column and writes each run's disk from its launch", async (t) => {
  const dir = scratch("agentrun-per-disk-upgrade-");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const first = await openSqliteStore({ dataDir: dir, role: "server" });
  await first.agents.create({ id: "agent-1", name: "Learns" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer." } });
  const base = { input: { content: "Q" }, title: "t", place: { mode: "runner" } };
  await first.runs.create({ id: "on-a", agentId: "agent-1", revisionId: "rev-1" }, { body: launchBody({ ...base, ...launchDisk("disk-a") }) });
  await first.runs.create({ id: "on-own", agentId: "agent-1", revisionId: "rev-1" }, { body: launchBody({ ...base, archilDisk: { diskId: "agent-disk", kind: "agent" } }) });
  await first.runs.create({ id: "on-none", agentId: "agent-1", revisionId: "rev-1" }, { body: launchBody(base) });
  await first.close();
  const raw = new DatabaseSync(join(dir, "store.sqlite"));
  try {
    raw.exec("ALTER TABLE runs DROP COLUMN disk");
  } finally {
    raw.close();
  }
  await assert.rejects(openSqliteStore({ dataDir: dir, role: "runner" }), /Start the AgentRun server to add each run's disk/, "a runner, whose learning reads runs by disk, waits for the server");
  const store = await openSqliteStore({ dataDir: dir, role: "server" });
  try {
    assert.deepEqual(await Promise.all(["on-a", "on-own", "on-none"].map(async (id) => (await store.runs.get(id)).disk)), ["disk-a", null, null], "each run's disk from its launch: a named one by its id, the agent's own or none as the default");
  } finally {
    await store.close();
  }
  const runner = await openSqliteStore({ dataDir: dir, role: "runner" });
  await runner.close();
});

test("a launch on a named disk is read back with no seed, no # Learned section and no learned workflow, whatever its body holds; on the agent's own disk or none, as written", () => {
  // A start made before its run's disk was read (a run queued before this build, or reopened): the default disk's
  // corrections and workflows in a named-disk run's body.
  const learning = { seed: "a".repeat(40), section: `# Learned\n- ${MARK.default}`, workflows: ["answer"], model: "m-1", use: true };
  const base = { input: { content: "Q" }, title: "t", place: { mode: "runner" }, learning };
  const named = readLaunchBody(launchBody({ ...base, ...launchDisk("disk-b") }));
  assert.deepEqual(named.learning, { seed: null, section: "", seedFailed: "other_disk", model: "m-1", use: true }, "the run starts with nothing learned, its flags kept");
  assert.equal(JSON.stringify(named).includes(MARK.default), false, "nothing of the default disk's learning reaches the run");
  const own = readLaunchBody(launchBody({ ...base, archilDisk: { diskId: "agent-disk", kind: "agent" } }));
  assert.deepEqual(own.learning, learning, "the agent's own disk is the default: its start as written");
  assert.deepEqual(readLaunchBody(launchBody(base)).learning, learning);
});

// -------------------------------------------------------------------------------------------- compile (the look-back)

/** One agent (compile_after 2) whose runs run through a real runner, one at a time, each on its disk (`disk`: a named
 *  one, or none for the default): a run that learns gets its learning end over the learning folder of its own disk, a
 *  directory per disk, as Mode 2 keeps one on each disk. Every model request a run makes is kept. */
async function world(t) {
  const local = scratch("agentrun-per-disk-local-");
  const folders = { "disk-a": scratch("agentrun-per-disk-a-"), "disk-b": scratch("agentrun-per-disk-b-"), default: scratch("agentrun-per-disk-default-") };
  const server = await openSqliteStore({ dataDir: local, role: "server" });
  const open = [];
  t.after(async () => {
    for (const close of open.reverse()) await close().catch(() => {});
    await server.close().catch(() => {});
    for (const dir of [local, ...Object.values(folders)]) rmSync(dir, { recursive: true, force: true });
  });
  await server.agents.create({ id: "agent-1", name: "Learns" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer.", tools: ["read"], learning: { compile_after: 2 } } });
  const run = async (runId, { disk, content, learns = false }) => {
    const data = folders[disk ?? "default"];
    const seed = learns ? await seedOf(data, "agent-1") : undefined;
    const launch = { input: { content }, title: "t", place: { mode: "runner" }, ...launchDisk(disk), ...(learns ? { learning: { seed: seed.sha, section: "" } } : {}) };
    await server.runs.create({ id: runId, agentId: "agent-1", revisionId: "rev-1" }, { body: launchBody(launch) });
    const store = await openSqliteStore({ dataDir: local, role: "runner" });
    open.push(() => store.close());
    // The folder of the run's own disk, as a Mode 2 claim opens it there (the claim's Archil disk).
    const endOfRun = learningEndOfRun(launch, { store, data: local, env: {}, learningFolder: (agentId) => learningWorkspace({ mode: "local", data, agentId }) });
    const requests = [];
    const spec = piAdapterSpec({ script: learns ? [{ say: "42" }, { say: DRAFT }] : [{ say: "42" }], tools: {}, hooks: quiet }, { requests });
    const createLoop = (deps) => {
      const job = createAdapterLoop(async (claim, r) => ({ ...(await spec(claim, r)), agentId: "agent-1", input: content }))({ ...deps, endOfRun });
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
  return { run, folders, server };
}

test("a run on disk A compiles from disk A's runs alone: no trace of a run on disk B or on the default disk reaches its compile turn or its folder", { timeout: 120_000 }, async (t) => {
  const w = await world(t);
  await w.run("b-1", { disk: "disk-b", content: `What is six times seven? ${MARK["disk-b"]}` });
  await w.run("d-1", { content: `What is six times seven? ${MARK.default}` });
  await w.run("a-1", { disk: "disk-a", content: `What is six times seven? ${MARK["disk-a"]}` });
  const a2 = await w.run("a-2", { disk: "disk-a", content: "What is six times seven?", learns: true });
  // Due on disk A's own two runs (compile_after 2): its compile turn reads a-1's trace, never b-1's or d-1's.
  assert.ok(a2.said.includes("````workflow"), `a-2's compile turn was asked: ${a2.said.slice(0, 400)}`);
  assert.ok(a2.said.includes(MARK["disk-a"]), "disk A's earlier run is read");
  assert.equal(a2.said.includes(MARK["disk-b"]), false, "no run on disk B reaches disk A's compile");
  assert.equal(a2.said.includes(MARK.default), false, "no run on the default disk reaches disk A's compile");
  assert.equal(a2.kept?.proposal?.state, "merged", JSON.stringify(a2.kept?.proposal));
  // Its merge is on disk A's folder; disk B's and the default disk's are as they were.
  assert.equal((await seedOf(w.folders["disk-a"], "agent-1")).workflows.length, 1, "disk A's folder holds the compiled workflow");
  for (const other of ["disk-b", "default"]) assert.equal((await seedOf(w.folders[other], "agent-1")).workflows.length, 0, `${other}'s folder learned nothing from disk A`);
});

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

test("the compile's due count is per disk: one earlier run on disk A and three on disk B leave disk A's second run due, and B's runs never make A's first run due", { timeout: 120_000 }, async (t) => {
  const w = await world(t);
  for (let i = 1; i <= 3; i++) await w.run(`b-${i}`, { disk: "disk-b", content: `What is six times seven? ${MARK["disk-b"]} ${i}` });
  // Disk A's first run: no earlier run on disk A, so compile_after 2 is not met (disk B's three never count).
  const a1 = await w.run("a-1", { disk: "disk-a", content: `What is six times seven? ${MARK["disk-a"]}`, learns: true });
  assert.equal(a1.said.includes("````workflow"), false, "not due on disk A: no compile turn");
  assert.equal(a1.said.includes(MARK["disk-b"]), false);
});

// ----------------------------------------------------------------------------------------------- check replay inputs

const flowText = JSON.stringify({ v: 2, name: "answer", schemas: { In: { type: "object", required: ["question"], properties: { question: { type: "string" } } } }, input: { schemaId: "In" }, output: { schemaId: "In", path: "question" },
  root: { node: "agent", label: "answer", instructions: "Answer.", out: "In", as: "answer", tools: [] } });
const LEARNING = { seed: "s", section: "" };

/** A store of the agent's runs (newest first, as the store lists them: `disk` filtered as the store's own list does), each
 *  with its launch on its disk, and its settings; replay runs created are kept. */
function storeOf(rows, launches) {
  const kv = new Map();
  const settings = {
    get: async (key) => (kv.has(key) ? structuredClone(kv.get(key)) : undefined),
    putIfAbsent: async (key, value) => (kv.has(key) ? kv.get(key) : (kv.set(key, structuredClone(value)), value)),
    replaceIf: async (key, was, value) => (JSON.stringify(kv.get(key)) === JSON.stringify(was) ? (kv.set(key, structuredClone(value)), true) : false),
  };
  const created = [];
  const store = {
    settings,
    runs: {
      get: async (id) => rows.find((row) => row.id === id),
      list: async ({ agentId, disk, state, archived, limit } = {}) => rows
        .filter((row) => (agentId === undefined || row.agentId === agentId) && (disk === undefined || row.disk === disk) && (state === undefined || row.state === state) && (archived === undefined || (row.archivedAt !== null) === archived))
        .slice(0, limit ?? rows.length),
      launch: async (id) => (launches.has(id) ? { runId: id, body: launchBody(launches.get(id)), sealed: null } : Promise.reject(new Error(`no run ${id}`))),
      create: async (row, launch) => {
        created.push({ id: row.id, launch: launch?.body });
        rows.unshift({ id: row.id, agentId: row.agentId, state: "queued", metrics: null, archivedAt: null, importedFrom: null, outcome: null, disk: null });
        return { id: row.id };
      },
    },
    agents: { revision: async (id) => ({ id, body: { instructions: "Answer.", learning: { compile_after: 3 } } }) },
    runOfOrigin: async () => undefined,
    command: async () => ({ id: "c-1" }),
  };
  return { store, settings, created, kv };
}

test("a check on disk A replays the inputs of disk A's own runs alone: never a run on disk B or on the default disk", async () => {
  const rows = [];
  const launches = new Map();
  const add = (id, disk) => {
    rows.push({ id, agentId: "a", state: "ended", outcome: "completed", metrics: { path: "agent" }, archivedAt: null, importedFrom: null, disk: disk ?? null });
    launches.set(id, { input: { question: `${id} ${MARK[disk ?? "default"]}` }, title: id, place: { mode: "runner" }, learning: LEARNING, ...launchDisk(disk) });
  };
  // Newest first: disk B's and the default disk's runs are the agent's newest; disk A's three are older.
  for (let i = 0; i < 4; i++) add(`b-${i}`, "disk-b");
  for (let i = 0; i < 2; i++) add(`d-${i}`, undefined);
  for (let i = 0; i < 3; i++) add(`a-${i}`, "disk-a");
  const { store, settings, created } = storeOf(rows, launches);
  const logs = [];
  const gate = promotionGate({ store, shown: async () => secretsShown([]), agentId: "a", runId: "now", revisionId: "rev", launch: { input: { question: "Now" }, title: "", place: { mode: "runner" }, learning: LEARNING, ...launchDisk("disk-a") }, context: ctx, log: (line) => logs.push(line) });
  const digest = workflowDigest({ workflow: flowText });
  assert.equal(await gate({ name: "answer", workflow: flowText }, digest), undefined, "it does not serve while it is checked");
  const record = (await promotionsOf(settings, learningIdOf({ agentId: "a", disk: "disk-a" }))).at(-1);
  assert.equal(record?.decided, "replaying", `${JSON.stringify(record)}\n${logs.join("\n")}`);
  assert.deepEqual(record.inputs, ["a-0", "a-1", "a-2"], "disk A's own three runs");
  for (const { launch } of created) {
    const text = JSON.stringify(launch);
    assert.equal(text.includes(MARK["disk-b"]) || text.includes(MARK.default), false, `a replay on disk A replays no other disk's input: ${text}`);
    assert.deepEqual(launch.archil_disk, { disk_id: "disk-a", kind: "launch" }, "and runs on disk A");
  }
  assert.deepEqual(await promotionsOf(settings, learningIdOf({ agentId: "a", disk: "disk-b" })), [], "nothing is recorded for disk B");
  assert.deepEqual(await promotionsOf(settings, learningIdOf({ agentId: "a", disk: null })), [], "nor for the default disk");
  assert.equal(learningIdOf({ agentId: "a", disk: null }), "a", "the default disk's records keep the agent's own key");
});

// ------------------------------------------------------------------------------------------------------ serving

test("a workflow promoted on disk A serves a run on disk A, never a run on disk B or on the default disk", async () => {
  const promoted = { workflow: "answer", digest: workflowDigest({ workflow: flowText }), at: new Date(0).toISOString(), decided: "promote", reason: "checked: promoted", commit: "c-1",
    check: { compile_after: 3, agree_min: 0.8, alone_min: 0.7, attempt: 1, n: 1, agreed: 1, alone: 1, of: [] } };
  const gateOn = async (disk) => {
    const { store, settings, created } = storeOf([], new Map());
    assert.equal((await recordPromotion(settings, learningIdOf({ agentId: "a", disk: "disk-a" }), promoted, () => true)).won, true);
    const logs = [];
    const gate = promotionGate({ store, shown: async () => secretsShown([]), agentId: "a", runId: "now", revisionId: "rev", launch: { input: { question: "Now" }, title: "", place: { mode: "runner" }, learning: LEARNING, ...launchDisk(disk) }, context: ctx, log: (line) => logs.push(line) });
    return { served: await gate({ name: "answer", workflow: flowText }, promoted.digest), created, logs };
  };
  const onA = await gateOn("disk-a");
  assert.equal(onA.served?.workflow?.workflow, flowText, `disk A's promotion serves disk A: ${onA.logs.join("\n")}`);
  for (const disk of ["disk-b", undefined]) {
    const other = await gateOn(disk);
    assert.equal(other.served, undefined, `disk A's promotion never serves ${disk ?? "the default disk"}: ${other.logs.join("\n")}`);
  }
});

// ---------------------------------------------------------------------------------------------------- audit draw

const drawn = (runId, k) => Number.parseInt(createHash("sha256").update(`audit:${runId}`).digest("hex").slice(0, 8), 16) % k === 0;

test("an audit's draw counts the served runs on the run's own disk: 1,100 runs served on disk B leave disk A's first served run audited at audit_every", async (t) => {
  const learning = { audit_every: 1, audit_every_later: 1000, audit_later_after: 1000 };
  const digest = workflowDigest({ workflow: flowText });
  const runId = Array.from({ length: 1000 }, (_, i) => `next-${i}`).find((id) => !drawn(id, 1000));
  const rows = [];
  for (let i = 0; i < 1100; i++) rows.push({ id: `b-${i}`, agentId: "agent-1", state: "ended", runner: null, archivedAt: null, importedFrom: null, outcome: "completed", startedAt: i, disk: "disk-b", metrics: { path: "workflow", workflow: "answer", workflow_digest: digest } });
  rows.reverse();
  const made = [];
  const store = {
    settings: { get: async () => undefined },
    agents: { revision: async () => ({ id: "rev-1", body: { instructions: "Answer.", tools: [], learning }, mcpPin: null }) },
    runs: {
      list: async ({ disk, state, archived, limit } = {}) => rows.filter((row) => (disk === undefined || row.disk === disk) && (state === undefined || row.state === state) && (archived === undefined || (row.archivedAt !== null) === archived)).slice(0, limit ?? rows.length),
      get: async (id) => rows.find((row) => row.id === id),
      launch: async () => ({ body: {} }),
      create: async (row, launch) => void made.push({ id: row.id, launch: launch?.body }),
    },
  };
  const dir = scratch("agentrun-per-disk-audit-");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const launch = { input: { content: "Next?" }, title: "Next", place: { mode: "runner" }, learning: { seed: "0".repeat(40), section: "" }, ...launchDisk("disk-a") };
  await startAudit({ store, agentId: "agent-1", disk: "disk-a", revisionId: "rev-1", context: {}, folder: () => learningWorkspace({ mode: "local", data: dir, agentId: "agent-1" }), shown: async () => ({ text: (text) => text }), log: () => {}, runId, launch }, { name: "answer", digest });
  assert.deepEqual(made.map(({ id }) => id), [`audit.${runId}`], "disk A served none before: drawn at 1 in 1, disk B's 1,100 never counted");
  assert.deepEqual(made[0].launch.archil_disk, { disk_id: "disk-a", kind: "launch" }, "its shadow runs on disk A");
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
  await store.settings.put("learning.promotions.agent-1", { v: 1, items: [{ workflow: "answer", digest: A, at: promoted, decided: "promote", reason: "checked: promoted", check }] });
  const cost = await agentCostOverStore(store, "agent-1");
  assert.deepEqual(cost.bill.revisions.map((one) => [one.digest, one.check_usd, one.served, one.attributed_usd, one.unattributed_usd]), [[A, 0.3, 2, 0.3, 0]], JSON.stringify(cost.bill.revisions));
  // Each run's own figures read the same ledger: the default disk's first K served runs carry its check, disk B's none.
  const shares = await Promise.all(["served-b1", "served-b2", "served-d1", "served-d2"].map(async (id) => (await runAllInOverStore(store, id)).learning_usd));
  assert.deepEqual(shares, [0, 0, 0.15, 0.15]);
});
