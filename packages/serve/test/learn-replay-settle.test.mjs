// A replay's read (runner/promotion.ts replayView) settles it as a claim would:
//   - two reads settling one replay at once write once: an older replay's late result never lands over a newer replay
//     of the same revision (the settle and the supersede match the replay's id);
//   - a replay reserved and then interrupted before its first run existed: a GET never starts its runs; it reads
//     running until its deadline, then is decided as failed with why: never "running" forever;
//   - a revision promoted, then held, then replayed and promoted again serves again: the champion is the revision whose
//     latest promotion (a promote after anything else) is newest, never only its first;
//   - a running replay's cost is null while one of its runs' costs is unknown, never 0;
//   - an owner's replay stopped after some of its runs is finished by a later claim on the owner's launch.
// The replay runs are records the read reads (row, launch, metrics, and the answer said(): a real run's journal); the
// agent's learning is real (landWorkflows).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { commitWrites } from "@earendil-works/pi-durable/testing";
import { landWorkflows, startAt } from "./learned-workflow-seed-support.mjs";

const { openSqliteStore } = await import("../dist/store/sqlite/store.js");
const { askReplay, promotionGate, replayView } = await import("../dist/runner/promotion.js");
const { launchBody } = await import("../dist/run-launch.js");
const { sealRunMcpAuth } = await import("../dist/store/seal.js");
const { REPLAY_DEADLINE_MS, REPLAY_LAUNCH_GRACE_MS } = await import("../dist/runner/promotion.js");
const { championOf, promotionOf, promotionsOf, recordPromotion, servingOf } = await import("../dist/learn/promote.js");
const { workflowDigest } = await import("../dist/runner/workflow-first.js");
const { secretsShown } = await import("../dist/learning.js");

const FLOW = {
  v: 2, name: "answer",
  schemas: {
    In: { type: "object", required: ["question"], properties: { question: { type: "string" } } },
    Answer: { type: "object", required: ["answer"], properties: { answer: { type: "number" } } },
  },
  input: { schemaId: "In" }, output: { schemaId: "Answer", path: "answer" },
  root: { node: "chain", steps: [{ node: "extract", label: "answer", instructions: "Answer the question.", out: "Answer", as: "answer" }] },
};
const DIGEST = workflowDigest({ workflow: JSON.stringify(FLOW) });
const T0 = Date.parse("2026-11-14T12:00:00.000Z");
/** What a graded run graded wrong said (world's said): 41. A replay that answers 42 now is right by the grade. */
const SAID = "41";
const FIXED = () => "42";

/** An agent that learned `answer`, `graded` runs of the agent's own, and replay runs the
 *  test sets (`replayRun`): rows and launches the read reads, never run. `now` moves with `clock.at`. */
async function world(t, { graded = 5 } = {}) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "learn-replay-settle-"));
  let store = await openSqliteStore({ dataDir: dir, role: "server" });
  t.after(async () => {
    await store.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  await store.agents.create({ id: "agent-1", name: "Learns" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer.", tools: ["read"], learning: true } });
  const seed = await landWorkflows(store, "agent-1", [{ name: "answer", description: "Answers a question as a number", workflow: FLOW }]);
  const launchOf = (question) => ({ input: { content: `${question}?`, question }, title: question, place: { mode: "runner" }, model: { provider: "anthropic", modelId: "claude-sonnet-5-5" }, learning: startAt(seed) });
  const gradedRuns = Array.from({ length: graded }, (_, i) => `graded-${i}`);
  const old = new Map(gradedRuns.map((run, i) => [run, launchOf(`Question ${i}`)]));
  const fake = new Map();
  /** How many more runs a create makes before the server "stops" (`left`, undefined: no stop). */
  const creates = { left: undefined };
  /** Replay run `id` of graded run `of`: `state` (ended: its `outcome`), what it cost (`costUsd`, null: unknown), its
   *  answer step's guard p, read record-only (`p`; none: no guard row). */
  const replayRun = (id, of, { state = "ended", outcome = "answered", costUsd = 0.01, p } = {}) => fake.set(id, { of, state, outcome, costUsd, guards: p === undefined ? [] : [{ node: "answer", signal: "self", self: p, p, threshold: 0.8, escalated: false }] });
  const runsOf = (inner) => {
    const runs = Object.create(inner.runs);
    for (const key of Object.getOwnPropertyNames(Object.getPrototypeOf(inner.runs) ?? {})) if (typeof inner.runs[key] === "function" && key !== "constructor") runs[key] = inner.runs[key].bind(inner.runs);
    runs.get = async (id) => {
      if (gate.armed && fake.has(id)) {
        gate.armed = false;
        gate.reached?.();
        await gate.hold;
      }
      if (old.has(id)) return { id, agentId: "agent-1", revisionId: "rev-1", state: "ended", metrics: { path: "agent" }, archivedAt: null, importedFrom: null, costUsd: 0.01, startedAt: 1, endedAt: 2 };
      const one = fake.get(id);
      return one ? { id, agentId: "agent-1", revisionId: "rev-1", state: one.state, metrics: { path: "replay", replay: { outcome: one.outcome }, guards: one.guards }, archivedAt: null, importedFrom: null, costUsd: one.costUsd, startedAt: 1, endedAt: 2 } : inner.runs.get(id);
    };
    runs.launch = async (id) => {
      if (old.has(id)) return { runId: id, body: old.get(id), sealed: null, createdAt: 1 };
      const one = fake.get(id);
      return one ? { runId: id, body: { ...old.get(one.of), replay: { of: one.of, workflow: "answer", digest: DIGEST } }, sealed: null, createdAt: 1 } : inner.runs.launch(id);
    };
    runs.list = async (...args) => [...[...old.keys()].reverse().map((id) => ({ id, agentId: "agent-1", revisionId: "rev-1", state: "ended", outcome: null, metrics: { path: "agent" }, archivedAt: null, importedFrom: null, costUsd: 0.01, startedAt: 1, endedAt: 2 })), ...(await inner.runs.list(...args))];
    runs.create = async (...args) => {
      if (creates.left !== undefined && creates.left-- <= 0) throw new Error("the server stopped mid-launch");
      return inner.runs.create(...args);
    };
    return runs;
  };
  /** The first read of a replay run's row a settle makes, held once at `gate.hold` (a promise) while `gate.armed`: a read
   *  caught mid-settle, after it read the replay's record and before it writes its decision. */
  const gate = { armed: false, hold: undefined, reached: undefined };
  /** What a run's final answer says (answerOf reads it from the run's timeline): `said(id, text)` points run `id`'s journal
   *  at a real run whose one turn answered `text` (one per text). A run with none answers nothing (null). */
  const saying = new Map();
  const sayers = new Map();
  const said = async (id, text) => {
    if (!sayers.has(text)) {
      const run = `says-${sayers.size}`;
      await store.runs.create({ id: run, agentId: "agent-1", revisionId: "rev-1" }, { body: launchOf("says") });
      const journal = store.journal(await store.claim(run, "runner-a", { leaseMs: 60_000 }));
      const entry = async (kind, model) => ({ id: await journal.mintId(), conversationId: 1, kind, model });
      const asked = await entry("pi.user", [{ role: "user", content: "Answer.", timestamp: T0 }]);
      const answered = await entry("pi.assistant", [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text }], timestamp: T0 }]);
      await commitWrites(journal, [{ type: "conversation", value: { id: 1 } }, { type: "entry", value: asked }, { type: "entry", value: answered }], BACKGROUND_CONTEXT);
      sayers.set(text, run);
    }
    saying.set(id, sayers.get(text));
  };
  const storeOf = (inner) => {
    const runs = runsOf(inner);
    const readJournal = (id) => inner.readJournal(saying.get(id) ?? id);
    return new Proxy(inner, { get: (target, key) => (key === "runs" ? runs : key === "readJournal" ? readJournal : typeof target[key] === "function" ? target[key].bind(target) : target[key]) });
  };
  const clock = { at: T0 };
  const logs = [];
  const ask = () => ({
    store: storeOf(store), agentId: "agent-1", context: BACKGROUND_CONTEXT, log: (line) => logs.push(line),
    shown: async () => secretsShown([]),
    launchOf: async (input) => ({ launch: { ...launchOf("asked"), input }, revisionId: "rev-1" }),
    now: () => clock.at,
  });
  /** The replaying record a reservation writes: `runs` reserved for the graded runs in order, and the launch they run with. */
  const reserve = (replayId, runs, extra = {}) => recordPromotion(store.learning, "agent-1", {
    workflow: "answer", digest: DIGEST, at: new Date(clock.at).toISOString(), decided: "replaying", reason: "replaying, as its owner asked",
    runs, inputs: runs.map((_, i) => gradedRuns[i % gradedRuns.length]), replay_id: replayId, commit: seed, launch: { revision: "rev-1", body: launchBody({ ...launchOf("asked"), input: null }) }, ...extra,
  }, (was) => was?.decided !== "replaying");
  const reopen = async () => {
    await store.close();
    store = await openSqliteStore({ dataDir: dir, role: "server" });
  };
  const records = async () => promotionsOf(store.learning, "agent-1");
  const read = (id) => replayView(ask(), "answer", DIGEST, id);
  return { store: () => store, seed, gradedRuns, replayRun, said, reserve, reopen, records, read, ask, clock, gate, logs, creates };
}

test("two reads settling one replay at once write it once: a newer replay of the same revision started meanwhile stays replaying", async (t) => {
  const w = await world(t);
  const runs = w.gradedRuns.map((of, i) => (w.replayRun(`a-${i}`, of), `a-${i}`));
  for (const run of w.gradedRuns) await w.said(run, SAID);
  for (const run of runs) await w.said(run, FIXED());
  await w.reserve("replay-a", runs);
  // The second read is caught after it read A replaying, before it writes A's decision.
  let release;
  w.gate.hold = new Promise((resolve) => (release = resolve));
  const reached = new Promise((resolve) => (w.gate.reached = resolve));
  w.gate.armed = true;
  const late = w.read("replay-a");
  await reached;
  // The first read decides A (held: the workflow's answers differ from the agent's).
  const first = await w.read("replay-a");
  assert.deepEqual([first.status, first.decided], ["done", "hold"], JSON.stringify(first));
  // Its owner replays the held revision again: replay B reserved.
  const b = await w.reserve("replay-b", w.gradedRuns.map((_, i) => `b-${i}`));
  assert.equal(b.won, true);
  release();
  const second = await late;
  assert.deepEqual([second.status, second.decided], ["done", "hold"], `the late read reads A's decision: ${JSON.stringify(second)}`);
  const records = await w.records();
  assert.equal(promotionOf(records, "answer", DIGEST)?.replay_id, "replay-b", `B is the revision's newest record: ${JSON.stringify(records.map(({ decided, replay_id }) => [decided, replay_id]))}`);
  assert.equal(promotionOf(records, "answer", DIGEST)?.decided, "replaying");
  assert.equal(records.filter((one) => one.replay_id === "replay-a" && one.decided !== "replaying").length, 1, "A's decision written once");
  const view = await w.read("replay-b");
  assert.equal(view.status, "running", JSON.stringify(view));
});

test("a replay interrupted before its first run existed: a GET never starts its runs; it reads running until its deadline, then failed with why and to POST it again", async (t) => {
  const w = await world(t);
  // Reserved, then the server stopped: none of its runs was created. The store is opened again.
  await w.reserve("replay-a", w.gradedRuns.map((_, i) => `lost-${i}`));
  await w.reopen();
  const count = async () => (await w.store().runs.list({ agentId: "agent-1" })).length;
  const before = await count();
  for (const at of [T0 + 30_000, T0 + REPLAY_LAUNCH_GRACE_MS + 1_000, T0 + REPLAY_DEADLINE_MS - 1_000]) {
    w.clock.at = at;
    const view = await w.read("replay-a");
    assert.equal(view.status, "running", `before its deadline it reads running (${at - T0} ms): ${JSON.stringify(view)}`);
    assert.equal(await count(), before, `a GET created no run (${at - T0} ms)`);
  }
  for (const i of w.gradedRuns.keys()) assert.ok(!(await w.store().runs.get(`lost-${i}`)), `reserved run lost-${i} never created by a read`);
  assert.ok(!w.logs.some((line) => /launch was interrupted/.test(line)), w.logs.join("\n"));
  w.clock.at = T0 + REPLAY_DEADLINE_MS + 1_000;
  const late = await w.read("replay-a");
  assert.deepEqual([late.status, late.decided], ["failed", "hold"], JSON.stringify(late));
  assert.match(late.reason, /none of its 5 check runs started by the check's deadline/);
  assert.match(late.reason, /nothing was checked: held/);
  assert.equal(await count(), before, "past its deadline a GET decides it and still creates no run");

  // Another revision's replay that was never launched and is found only past its deadline: failed, and says why.
  const v = await world(t);
  await v.reserve("replay-x", v.gradedRuns.map((_, i) => `gone-${i}`));
  await v.reopen();
  v.clock.at = T0 + REPLAY_DEADLINE_MS + 1_000;
  const failed = await v.read("replay-x");
  assert.deepEqual([failed.status, failed.decided], ["failed", "hold"], JSON.stringify(failed));
  assert.match(failed.reason, /none of its 5 check runs started by the check's deadline/);
  assert.equal(failed.inputs, 5);
  // A check's outcomes add up to its n: each run never created by the deadline is a failed input (#3061).
  assert.deepEqual(failed.outcomes, { answered: 0, handed_back: 0, failed: 5, skipped_write: 0 });
  assert.equal(promotionOf(await v.records(), "answer", DIGEST)?.decided, "hold", "held: its owner may replay it again");
});

test("a revision promoted, held, then promoted again by a replay serves again", async (t) => {
  // The champion is the digest whose latest promotion is newest.
  const rec = (digest, decided, extra = {}) => ({ workflow: "answer", digest, at: "t", decided, reason: "r", ...extra });
  const items = [rec("A", "promote", { source: "dry_run" }), rec("A", "hold", { source: "graded" }), rec("B", "promote"), rec("A", "replaying"), rec("A", "promote")];
  assert.equal(championOf(items, "answer")?.digest, "A");
  assert.equal(championOf([...items, rec("B", "hold"), rec("B", "replaying"), rec("B", "promote")], "answer")?.digest, "B", "B replayed and promoted again after A");

  // Through the read: A served, was held, B promoted, then A's replay (its runs say what the agent said) promotes it.
  const w = await world(t);
  const learning = w.store().learning;
  await recordPromotion(learning, "agent-1", { workflow: "answer", digest: DIGEST, at: "t1", decided: "promote", reason: "r", commit: w.seed }, () => true);
  await recordPromotion(learning, "agent-1", { workflow: "answer", digest: DIGEST, at: "t2", decided: "hold", reason: "r" }, () => true);
  await recordPromotion(learning, "agent-1", { workflow: "answer", digest: "bbbbbbbbbbbbbbbb", at: "t3", decided: "promote", reason: "r", commit: w.seed }, () => true);
  const runs = w.gradedRuns.map((of, i) => (w.replayRun(`a-${i}`, of), `a-${i}`));
  for (const run of w.gradedRuns) await w.said(run, FIXED());
  for (const run of runs) await w.said(run, FIXED());
  await w.reserve("replay-a", runs);
  const view = await w.read("replay-a");
  assert.deepEqual([view.status, view.decided], ["done", "promote"], JSON.stringify(view));
  const records = await w.records();
  assert.equal(championOf(records, "answer")?.digest, DIGEST, "A serves again");
  assert.deepEqual(servingOf(records), [{ workflow: "answer", digest: DIGEST, replaying: null }]);
});

test("a running replay's cost is null while a run's cost is unknown, never 0; once decided, what its runs cost", async (t) => {
  const w = await world(t);
  w.gradedRuns.forEach((of, i) => w.replayRun(`a-${i}`, of, { state: "running" }));
  await w.reserve("replay-a", w.gradedRuns.map((_, i) => `a-${i}`));
  assert.equal((await w.read("replay-a")).cost_usd, null, "none ended");
  w.replayRun("a-0", w.gradedRuns[0]);
  w.replayRun("a-1", w.gradedRuns[1]);
  const partial = await w.read("replay-a");
  assert.equal(partial.status, "running");
  assert.equal(partial.cost_usd, null, `two of five ended: ${JSON.stringify(partial)}`);
  w.gradedRuns.forEach((of, i) => w.replayRun(`a-${i}`, of));
  const done = await w.read("replay-a");
  assert.equal(done.status, "done");
  assert.equal(done.cost_usd, 0.05);
});

test("#2823 review: an owner's replay stopped after 2 of its 5 runs is finished by a later claim on the owner's launch (model, revision, no per_run credentials), never the claim's", async (t) => {
  const w = await world(t);
  const store = w.store();
  const OWNER_MODEL = { provider: "anthropic", modelId: "claude-sonnet-5-5" };
  // The owner's replay: the server stops after creating 2 of its 5 reserved runs.
  w.creates.left = 2;
  await assert.rejects(askReplay(w.ask(), "answer", DIGEST, 5), /stopped mid-launch/);
  w.creates.left = undefined;
  const reserved = (await w.records()).at(-1);
  assert.deepEqual([reserved.decided, reserved.runs.length], ["replaying", 5]);
  assert.equal((await Promise.all(reserved.runs.map((id) => store.runs.get(id)))).filter(Boolean).length, 2);
  // A later run of the agent: another revision, another model, handed a per_run MCP credential.
  await store.agents.addRevision({ agentId: "agent-1", id: "rev-2", kind: "agentic", body: { instructions: "Answer, later.", tools: ["read"], learning: true } });
  const SEAL_KEY = Buffer.alloc(32, 5);
  const later = { input: { content: "Later?", question: "Later" }, title: "Later", place: { mode: "runner" }, model: { provider: "openai", modelId: "gpt-6.1-sol" }, learning: startAt(w.seed) };
  await store.runs.create({ id: "claimed-later", agentId: "agent-1", revisionId: "rev-2" }, { body: launchBody(later), sealed: sealRunMcpAuth(SEAL_KEY, "claimed-later", { fake: { headers: { authorization: "Bearer later-token" }, origin: "https://mcp.example" } }) });
  // Its claim lays the same digest past the launch grace: it finishes the owner's replay.
  w.clock.at = T0 + REPLAY_LAUNCH_GRACE_MS + 1_000;
  const deps = { store: w.ask().store, agentId: "agent-1", runId: "claimed-later", revisionId: "rev-2", launch: later, context: BACKGROUND_CONTEXT, log: (line) => w.logs.push(line), sealKey: SEAL_KEY, now: () => w.clock.at };
  await promotionGate(deps)({ name: "answer", description: "Answers a question as a number", workflow: JSON.stringify(FLOW) }, DIGEST);
  assert.ok(w.logs.some((line) => /launch was interrupted; 3 replay runs it reserved started now/.test(line)), w.logs.join("\n"));
  // Every run of the one replay on the owner's settings: its revision, its model, its seed, no per_run credentials.
  for (const id of reserved.runs) {
    const row = await store.runs.get(id);
    assert.ok(row, `replay run ${id} exists`);
    const launch = await store.runs.launch(id);
    assert.deepEqual([row.revisionId, launch.body.model, launch.body.learning?.seed, launch.sealed ?? null], ["rev-1", OWNER_MODEL, w.seed, null], `replay run ${id}: ${JSON.stringify(launch.body)}`);
  }
  assert.equal((await w.records()).at(-1).decided, "replaying", "still replaying: nothing ended yet");
});

