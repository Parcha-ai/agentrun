// A replay's read (runner/promotion.ts replayView) settles it as a claim would; review on #2823 r2:
//   - two reads settling one replay at once write once: an older replay's late result never lands over a newer replay
//     of the same revision (the settle and the supersede match the replay's id);
//   - a replay reserved and then interrupted before its first run existed: a GET never starts its runs (r3, TL ruling); it
//     reads running until its deadline, then is decided as failed with why (and to POST it again): never "running" forever;
//   - a revision promoted, then held, then replayed and promoted again serves again: the champion is the revision whose
//     latest promotion (a promote after anything else) is newest, never only its first, and its graded check counts only
//     the grades after it;
//   - a running replay's cost is null while one of its runs' costs is unknown, never 0;
//   - a replay's counts are its own runs' (and, once decided, its record's), never shrinking as newer grades roll the
//     graded runs it replayed out of the grades kept;
//   - r7: a revision held on runs it served graded wrong keeps them (held_on); its owner's replay always covers them and
//     promotes it only once it answered on them; promoted again, its check counts only the grades after `since`.
//   - r8: a promotion's `since` names it: each run it serves keeps it, and its check counts only those runs' grades (a run
//     served before a re-promotion and graded after never counts for the new one); a check whose promotion was replaced
//     meanwhile writes nothing.
//   - a revision held on its served runs graded wrong never re-promotes by answering them as wrongly again: on a wrong
//     grade the bar is the grade, and the agent's side of a run it never answered is right.
// The replay runs are records the read reads (row, launch, metrics, and the answer said(): a real run's journal); the
// learning folder is real (landWorkflows).
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
const { championOf, GRADES_KEPT, gradesKey, gradesOf, promotionOf, promotionsOf, putGrade, recordPromotion, servingOf, trimPromotions, PROMOTIONS_KEPT } = await import("../dist/learn/promote.js");
const { pathMetrics, servedOf, WORKFLOW_FIRST, workflowDigest } = await import("../dist/runner/workflow-first.js");
const { learningFolderOf, secretsShown } = await import("../dist/learning.js");

const FLOW = {
  v: 2, name: "answer",
  schemas: {
    In: { type: "object", required: ["question"], properties: { question: { type: "string" } } },
    Answer: { type: "object", required: ["answer"], properties: { answer: { type: "number" } } },
  },
  input: { schemaId: "In" }, output: { schemaId: "Answer", path: "answer" },
  root: { node: "chain", steps: [{ node: "extract", label: "answer", instructions: "Answer the question.", out: "Answer", as: "answer", guard: { signal: "self", threshold: 0.8 } }] },
};
const DIGEST = workflowDigest({ workflow: JSON.stringify(FLOW) });
const T0 = Date.parse("2026-11-14T12:00:00.000Z");
/** What a graded run graded wrong said (world's said): 41. A replay that answers 42 now is right by the grade. */
const SAID = "41";
const FIXED = () => "42";

/** An agent that learned `answer`, `graded` graded runs on the agent's path (graded `agentCorrect`), and replay runs the
 *  test sets (`replayRun`): rows and launches the read reads, never run. `now` moves with `clock.at`. */
async function world(t, { graded = 5, agentCorrect = true } = {}) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "learn-replay-settle-"));
  let store = await openSqliteStore({ dataDir: dir, role: "server" });
  t.after(async () => {
    await store.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  await store.agents.create({ id: "agent-1", name: "Learns" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer.", tools: ["read"], learning: true } });
  const seed = await landWorkflows(dir, "agent-1", [{ name: "answer", description: "Answers a question as a number", workflow: FLOW }]);
  const launchOf = (question) => ({ input: { content: `${question}?`, question }, title: question, place: { mode: "runner" }, model: { provider: "anthropic", modelId: "claude-sonnet-5-5" }, learning: startAt(seed) });
  const gradedRuns = Array.from({ length: graded }, (_, i) => `graded-${i}`);
  const old = new Map(gradedRuns.map((run, i) => [run, launchOf(`Question ${i}`)]));
  for (const run of gradedRuns) await putGrade(store.settings, "agent-1", { run, correct: agentCorrect, source: "eval", at: new Date(T0).toISOString(), path: "agent" });
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
      if (old.has(id)) return { id, agentId: "agent-1", revisionId: "rev-1", state: "ended", metrics: { path: "agent" }, archivedAt: null, importedFrom: null, costUsd: 0.01, startedAt: 1, endedAt: 2 };
      const one = fake.get(id);
      return one ? { id, agentId: "agent-1", revisionId: "rev-1", state: one.state, metrics: { path: "replay", replay: { outcome: one.outcome }, guards: one.guards }, archivedAt: null, importedFrom: null, costUsd: one.costUsd, startedAt: 1, endedAt: 2 } : inner.runs.get(id);
    };
    runs.launch = async (id) => {
      if (old.has(id)) return { runId: id, body: old.get(id), sealed: null, createdAt: 1 };
      const one = fake.get(id);
      return one ? { runId: id, body: { ...old.get(one.of), replay: { of: one.of, workflow: "answer", digest: DIGEST } }, sealed: null, createdAt: 1 } : inner.runs.launch(id);
    };
    runs.create = async (...args) => {
      if (creates.left !== undefined && creates.left-- <= 0) throw new Error("the server stopped mid-launch");
      return inner.runs.create(...args);
    };
    return runs;
  };
  /** The settings' reads of the grades, held once at `gate.hold` (a promise) while `gate.armed`: a read caught mid-settle. */
  const gate = { armed: false, hold: undefined, reached: undefined };
  const settingsOf = (inner) => new Proxy(inner.settings, {
    get: (target, key) => {
      const value = target[key];
      if (key !== "get") return typeof value === "function" ? value.bind(target) : value;
      return async (name) => {
        if (gate.armed && name === gradesKey("agent-1")) {
          gate.armed = false;
          gate.reached?.();
          await gate.hold;
        }
        return target.get(name);
      };
    },
  });
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
    const settings = settingsOf(inner);
    const readJournal = (id) => inner.readJournal(saying.get(id) ?? id);
    return new Proxy(inner, { get: (target, key) => (key === "runs" ? runs : key === "settings" ? settings : key === "readJournal" ? readJournal : typeof target[key] === "function" ? target[key].bind(target) : target[key]) });
  };
  const clock = { at: T0 };
  const logs = [];
  const ask = () => ({
    store: storeOf(store), agentId: "agent-1", context: BACKGROUND_CONTEXT, log: (line) => logs.push(line),
    folder: () => learningFolderOf(dir, "agent-1"), shown: async () => secretsShown([]),
    launchOf: async (input) => ({ launch: { ...launchOf("asked"), input }, revisionId: "rev-1" }),
    now: () => clock.at,
  });
  /** The replaying record a reservation writes: `runs` reserved for the graded runs in order. */
  const reserve = (replayId, runs, extra = {}) => recordPromotion(store.settings, "agent-1", {
    workflow: "answer", digest: DIGEST, at: new Date(clock.at).toISOString(), decided: "replaying", source: "replay", reason: "replaying, as its owner asked",
    runs, inputs: runs.map((_, i) => gradedRuns[i % gradedRuns.length]), replay_id: replayId, commit: seed, ...extra,
  }, (was) => was?.decided !== "replaying");
  const reopen = async () => {
    await store.close();
    store = await openSqliteStore({ dataDir: dir, role: "server" });
  };
  const records = async () => promotionsOf(store.settings, "agent-1");
  const read = (id) => replayView(ask(), "answer", DIGEST, id);
  return { store: () => store, seed, gradedRuns, replayRun, said, reserve, reopen, records, read, ask, clock, gate, logs, creates };
}

test("two reads settling one replay at once write it once: a newer replay of the same revision started meanwhile stays replaying", async (t) => {
  const w = await world(t);
  const runs = w.gradedRuns.map((of, i) => (w.replayRun(`a-${i}`, of), `a-${i}`));
  await w.reserve("replay-a", runs);
  // The second read is caught after it read A replaying, before it writes A's decision.
  let release;
  w.gate.hold = new Promise((resolve) => (release = resolve));
  const reached = new Promise((resolve) => (w.gate.reached = resolve));
  w.gate.armed = true;
  const late = w.read("replay-a");
  await reached;
  // The first read decides A (held: the workflow's answers are wrong where the agent's were right).
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
  assert.match(late.reason, /none of its 5 replay runs started by the replay's deadline/);
  assert.match(late.reason, /start it again with POST .*\/replays/);
  assert.equal(await count(), before, "past its deadline a GET decides it and still creates no run");

  // Another revision's replay that was never launched and is found only past its deadline: failed, and says why.
  const v = await world(t);
  await v.reserve("replay-x", v.gradedRuns.map((_, i) => `gone-${i}`));
  await v.reopen();
  v.clock.at = T0 + REPLAY_DEADLINE_MS + 1_000;
  const failed = await v.read("replay-x");
  assert.deepEqual([failed.status, failed.decided], ["failed", "hold"], JSON.stringify(failed));
  assert.match(failed.reason, /none of its 5 replay runs started by the replay's deadline/);
  assert.equal(failed.inputs, 5);
  assert.deepEqual([failed.answered, failed.handed_back, failed.failed, failed.skipped_write], [0, 0, 0, 0]);
  assert.equal(promotionOf(await v.records(), "answer", DIGEST)?.decided, "hold", "held: its owner may replay it again");
});

test("a revision promoted, held, then promoted again by a replay serves again; its graded check counts only the grades after", async (t) => {
  // The champion is the digest whose latest promotion is newest; a routine check of a promoted digest is no new one.
  const rec = (digest, decided, extra = {}) => ({ workflow: "answer", digest, at: "t", decided, source: "replay", reason: "r", ...extra });
  const items = [rec("A", "promote", { source: "dry_run" }), rec("A", "hold", { source: "graded" }), rec("B", "promote"), rec("A", "replaying"), rec("A", "promote")];
  assert.equal(championOf(items, "answer")?.digest, "A");
  assert.equal(championOf([...items, rec("B", "promote", { checked: 40 })], "answer")?.digest, "A", "B's routine check is no new promotion");
  assert.equal(championOf([...items, rec("B", "hold"), rec("B", "replaying"), rec("B", "promote")], "answer")?.digest, "B", "B replayed and promoted again after A");
  const filler = Array.from({ length: PROMOTIONS_KEPT }, (_, i) => ({ ...rec(`o${i}`, "replaying"), workflow: "other" }));
  assert.equal(championOf(trimPromotions([...items, ...filler]), "answer")?.digest, "A", "the trim keeps A's latest promotion");

  // Through the read: A served (25 graded runs), was held by them, B promoted, then A's replay promotes it.
  const w = await world(t, { agentCorrect: false });
  for (let i = 0; i < 25; i++) await putGrade(w.store().settings, "agent-1", { run: `served-${i}`, correct: false, source: "eval", at: "t", path: "workflow", workflow: "answer", digest: DIGEST });
  const settings = w.store().settings;
  await recordPromotion(settings, "agent-1", { workflow: "answer", digest: DIGEST, at: "t1", decided: "promote", source: "dry_run", reason: "r", commit: w.seed }, () => true);
  await recordPromotion(settings, "agent-1", { workflow: "answer", digest: DIGEST, at: "t2", decided: "hold", source: "graded", reason: "r" }, () => true);
  await recordPromotion(settings, "agent-1", { workflow: "answer", digest: "bbbbbbbbbbbbbbbb", at: "t3", decided: "promote", source: "dry_run", reason: "r", commit: w.seed }, () => true);
  const runs = w.gradedRuns.map((of, i) => (w.replayRun(`a-${i}`, of), `a-${i}`));
  await w.reserve("replay-a", runs);
  const view = await w.read("replay-a");
  assert.deepEqual([view.status, view.decided], ["done", "promote"], JSON.stringify(view));
  const records = await w.records();
  assert.equal(championOf(records, "answer")?.digest, DIGEST, "A serves again");
  assert.deepEqual(servingOf(records), [{ workflow: "answer", digest: DIGEST, replaying: null }]);
  const seqs = (await gradesOf(settings, "agent-1")).map((one) => one.seq);
  assert.equal(promotionOf(records, "answer", DIGEST)?.since, Math.max(...seqs), "its graded check counts only the grades after the ones it was held on");
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

test("a replay's counts never shrink as newer grades roll its graded runs out of the grades kept", async (t) => {
  const w = await world(t);
  w.gradedRuns.forEach((of, i) => w.replayRun(`a-${i}`, of, { state: i < 2 ? "ended" : "running" }));
  await w.reserve("replay-a", w.gradedRuns.map((_, i) => `a-${i}`));
  const roll = () => w.store().settings.put(gradesKey("agent-1"), { v: 1, items: Array.from({ length: GRADES_KEPT }, (_, i) => ({ run: `newer-${i}`, correct: true, source: "eval", at: "t", path: "agent", seq: 1_000 + i })) });
  const before = await w.read("replay-a");
  assert.equal(before.answered, 2);
  const kept = (await w.store().settings.get(gradesKey("agent-1"))).items;
  await roll();
  const running = await w.read("replay-a");
  assert.equal(running.answered, 2, `its two ended runs still count: ${JSON.stringify(running)}`);
  await w.store().settings.put(gradesKey("agent-1"), { v: 1, items: kept });
  w.gradedRuns.forEach((of, i) => w.replayRun(`a-${i}`, of));
  const decided = await w.read("replay-a");
  assert.deepEqual([decided.status, decided.answered, decided.score.n], ["done", 5, 5], JSON.stringify(decided));
  await roll();
  const later = await w.read("replay-a");
  assert.deepEqual([later.answered, later.handed_back, later.failed, later.skipped_write, later.score.n], [5, 0, 0, 0, 5], `read again after the grades rolled: ${JSON.stringify(later)}`);
});

test("a run answered under its guard's threshold counts answered while the replay runs and once it is decided; alone and the score hand it back", async (t) => {
  // #2823 review: the decided counts were derived from the score, so a run moved from answered to handed_back as it was
  // decided. The record keeps its runs' outcomes; the thresholds' reading stays in `score` and `alone`.
  const w = await world(t);
  const low = w.gradedRuns.length - 1;
  w.gradedRuns.forEach((of, i) => w.replayRun(`g-${i}`, of, { p: i === low ? 0.2 : 0.9, state: i === low ? "running" : "ended" }));
  await w.reserve("replay-g", w.gradedRuns.map((_, i) => `g-${i}`));
  const running = await w.read("replay-g");
  assert.deepEqual([running.status, running.answered, running.handed_back], ["running", 4, 0], JSON.stringify(running));
  w.replayRun(`g-${low}`, w.gradedRuns[low], { p: 0.2 });
  const seen = await w.read("replay-g");
  assert.equal(seen.status, "done", JSON.stringify(seen));
  assert.deepEqual([seen.answered, seen.handed_back, seen.failed, seen.skipped_write], [5, 0, 0, 0], `each run as it ended: ${JSON.stringify(seen)}`);
  assert.deepEqual([seen.score.n, seen.score.handed_back, seen.alone], [5, 1, 4], `the threshold reads the low one as handed back: ${JSON.stringify(seen)}`);
  const record = (await w.records()).findLast((one) => one.replay_id === "replay-g");
  assert.deepEqual(record.replay.outcomes, { answered: 5, handed_back: 0, failed: 0, skipped_write: 0 }, "kept with the decision");
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

// Review on #2823 r7 (Greptile P1s): a revision held on the runs it served graded wrong.
/** DIGEST promoted by a replay on graded-0..4 (graded wrong, the agent's), then serving 20 runs graded wrong: 18 with no
 *  launch (never replayable) and X = graded-5, Y = graded-6, which a replay can run. Ten more agent runs graded right by
 *  hand. Not checked yet: a claim's check (`gate`) holds it on them. */
async function heldOnServedPromoted(t) {
  const w = await world(t, { graded: 7, agentCorrect: false });
  const settings = w.store().settings;
  for (const run of w.gradedRuns) await w.said(run, SAID);
  const older = w.gradedRuns.slice(0, 5);
  const score = { n: 5, agree: 5, agent_acc: 0, wf_acc: 0, delta: 0, handed_back: 0 };
  await recordPromotion(settings, "agent-1", { workflow: "answer", digest: DIGEST, at: "t1", decided: "promote", source: "replay", reason: "r", replay: { ...score, of: older }, commit: w.seed }, () => true);
  for (let i = 0; i < 10; i++) await putGrade(settings, "agent-1", { run: `hand-${i}`, correct: true, source: "eval", at: "t", path: "agent" });
  const served = (run) => putGrade(settings, "agent-1", { run, correct: false, source: "eval", at: "t", path: "workflow", workflow: "answer", digest: DIGEST });
  for (let i = 0; i < 18; i++) await served(`served-${i}`);
  await served("graded-5");
  await served("graded-6");
  const gate = () => promotionGate({ store: w.ask().store, agentId: "agent-1", runId: "now", revisionId: "rev-1", launch: { input: { content: "Now?", question: "Now" }, title: "Now", place: { mode: "runner" }, learning: startAt(w.seed) }, context: BACKGROUND_CONTEXT, log: (line) => w.logs.push(line), now: () => w.clock.at })({ name: "answer", description: "Answers a question as a number", workflow: JSON.stringify(FLOW) }, DIGEST);
  return { w, settings, older, gate };
}

/** heldOnServedPromoted, held by a claim's check on the 20 it served wrong. */
async function heldOnServed(t) {
  const { w, settings, older, gate } = await heldOnServedPromoted(t);
  assert.equal(await gate(), undefined, "held on the 20 it served wrong");
  const held = (await w.records()).at(-1);
  assert.deepEqual([held.decided, held.source], ["hold", "graded"]);
  return { w, settings, older, gate };
}

/** The owner's default replay of DIGEST; its replay runs end as `outcome(of)` says for the graded run each replays, each
 *  answering what `answer(of)` says (undefined: nothing). */
async function ownersReplay(w, outcome, answer = () => undefined) {
  const { replay } = await askReplay(w.ask(), "answer", DIGEST, "held");
  const record = (await w.records()).findLast((one) => one.replay_id === replay);
  for (const [i, id] of record.runs.entries()) {
    w.replayRun(id, record.inputs[i], { outcome: outcome(record.inputs[i]) });
    const text = answer(record.inputs[i]);
    if (text !== undefined) await w.said(id, text);
  }
  return { record, view: await w.read(replay) };
}

test("#2823 r7: a revision held on runs it served graded wrong is replayed on them by default, and a replay that skips them never promotes it", async (t) => {
  const { w, older } = await heldOnServed(t);
  const held = (await w.records()).at(-1);
  assert.ok(held.held_on.includes("graded-5") && held.held_on.includes("graded-6"), `the hold keeps the runs it was held on: ${JSON.stringify(held.held_on)}`);
  // Its default replay covers X and Y as well as the inputs it was last promoted on.
  const skipped = await ownersReplay(w, (of) => (of === "graded-5" || of === "graded-6" ? "skipped_write" : "answered"));
  assert.deepEqual([...skipped.record.inputs].sort(), [...older, "graded-5", "graded-6"].sort(), "X and Y among its inputs");
  assert.deepEqual([...skipped.record.held_on].sort(), ["graded-5", "graded-6"], "the replay names the held runs it must answer on");
  // Every other input passes, X and Y are skipped: the score alone would promote it; it stays held, and says why.
  assert.deepEqual([skipped.view.status, skipped.view.decided], ["done", "hold"], JSON.stringify(skipped.view));
  assert.match(skipped.view.reason, /did not answer on 2 graded runs it was held on/);
  assert.deepEqual([...(await w.records()).at(-1).held_on].sort(), ["graded-5", "graded-6"], "still owed by its next replay");
  // A replay that answers on them too promotes it.
  const answered = await ownersReplay(w, () => "answered", FIXED);
  assert.deepEqual([...answered.record.inputs].sort(), [...older, "graded-5", "graded-6"].sort());
  assert.deepEqual([answered.view.status, answered.view.decided], ["done", "promote"], JSON.stringify(answered.view));
  assert.equal((await w.records()).at(-1).held_on, undefined, "a promotion owes nothing");
});

test("#2823 r7: a revision held, replayed and promoted again is checked only on the grades after that promotion, never the ones it was held on", async (t) => {
  const { w, settings, gate } = await heldOnServed(t);
  const { view } = await ownersReplay(w, () => "answered", FIXED);
  assert.deepEqual([view.status, view.decided], ["done", "promote"], JSON.stringify(view));
  const promoted = (await w.records()).at(-1);
  const grades = await gradesOf(settings, "agent-1");
  assert.equal(promoted.since, Math.max(...grades.map((one) => one.seq)), "it began at the agent's newest grade");
  assert.equal(promoted.checked, undefined, "checked is the next check's cursor, never set by the promotion");
  // A full window of fresh runs it served (each keeps the promotion's since), all right: checked on those 20 alone (100%
  // right), never the 20 wrong before.
  for (let i = 0; i < 20; i++) await putGrade(settings, "agent-1", { run: `fresh-${i}`, correct: true, source: "eval", at: "t", path: "workflow", workflow: "answer", digest: DIGEST, promotion: promoted.since });
  assert.ok(await gate(), `it serves on: ${w.logs.join("\n")}`);
  const after = (await w.records()).at(-1);
  assert.deepEqual([after.decided, after.since, after.checked], ["promote", promoted.since, Math.max(...(await gradesOf(settings, "agent-1")).map((one) => one.seq))], "checked moved; since did not");
});

// Review on #2823 r8 (Greptile P1 "Old checks undo re-promotion"): a check that read promotion P1, delayed while the
// revision was held and its owner's replay promoted it again (P2), writes nothing: neither its `checked` mark (a copy of
// P1 over P2, losing since) nor its hold (on P1's grades).
test("#2823 r8: a stale check that read the promotion before a hold and a re-promotion writes nothing over the new one", async (t) => {
  const { w, gate } = await heldOnServedPromoted(t);
  // The stale claim reads the records (P1 is the champion), then waits at its read of the grades.
  let release;
  const reached = new Promise((resolve) => (w.gate.reached = resolve));
  w.gate.hold = new Promise((resolve) => (release = resolve));
  w.gate.armed = true;
  const stale = gate();
  await reached;
  // Meanwhile another claim's check holds P1 on the 20 it served wrong, and the owner's replay promotes it again: P2.
  assert.equal(await gate(), undefined, "held on the 20 it served wrong");
  const { view } = await ownersReplay(w, () => "answered", FIXED);
  assert.deepEqual([view.status, view.decided], ["done", "promote"], JSON.stringify(view));
  const p2 = (await w.records()).at(-1);
  assert.equal(typeof p2.since, "number");
  const count = (await w.records()).length;
  // The stale check goes on: P1's 20 wrong would hold it, but P1 is no longer the digest's promotion.
  release();
  assert.ok(await stale, `the stale claim reads P2 back and it serves: ${w.logs.join("\n")}`);
  const after = await w.records();
  assert.equal(after.length, count, `the stale check wrote nothing: ${JSON.stringify(after.slice(count))}`);
  assert.deepEqual([after.at(-1).decided, after.at(-1).since, after.at(-1).checked], ["promote", p2.since, undefined], "P2 stays promoted with its since");
});

// TL on #2823 r8: a run served under P1 (before the re-promote) but graded after P2 counts for P1, never for P2's check.
test("#2823 r8: a run served before the re-promotion and graded wrong after it never counts toward the new promotion's check", async (t) => {
  const { w, settings, gate } = await heldOnServed(t);
  const { view } = await ownersReplay(w, () => "answered", FIXED);
  assert.deepEqual([view.status, view.decided], ["done", "promote"], JSON.stringify(view));
  const p2 = (await w.records()).at(-1);
  // 20 runs served under P1 (their grades keep P1's promotion: none) graded wrong now, after P2: never P2's check.
  for (let i = 0; i < 20; i++) await putGrade(settings, "agent-1", { run: `late-${i}`, correct: false, source: "eval", at: "t", path: "workflow", workflow: "answer", digest: DIGEST });
  assert.ok(await gate(), `it serves on: ${w.logs.join("\n")}`);
  const unchecked = (await w.records()).at(-1);
  assert.deepEqual([unchecked.decided, unchecked.since, unchecked.checked], ["promote", p2.since, undefined], "not checked: none of them was served under P2");
  // A run the gate serves now keeps P2's since (WorkflowFirst.promotion), as its WORKFLOW_FIRST entry and its record do.
  assert.equal((await gate())?.promotion, p2.since, "served under P2");
  const entries = [{ kind: WORKFLOW_FIRST, data: { workflow: "answer", digest: DIGEST, promotion: p2.since, revision: w.seed, call: "workflow-first", outcome: "answered" } }];
  assert.equal(servedOf(entries)?.promotion, p2.since);
  assert.equal(pathMetrics({ input: {}, title: "", place: { mode: "runner" }, learning: startAt(w.seed) }, { path: "workflow", workflow: "answer", digest: DIGEST, promotion: p2.since }).workflow_promotion, p2.since);
  // 20 it served under P2, all right: checked on those alone.
  for (let i = 0; i < 20; i++) await putGrade(settings, "agent-1", { run: `p2-${i}`, correct: true, source: "eval", at: "t", path: "workflow", workflow: "answer", digest: DIGEST, promotion: p2.since });
  assert.ok(await gate(), `it serves on: ${w.logs.join("\n")}`);
  assert.deepEqual([(await w.records()).at(-1).decided, (await w.records()).at(-1).since], ["promote", p2.since]);
});

// autoqa on #2823 (main 725382acb0): 20 served runs graded wrong held a revision, and its owner's replay promoted it at
// 0.0% against 0.0%: on a run the workflow served there is no answer of the agent's, so the revision tied its own wrong
// answers. TL ruling: on a wrong grade the bar is the grade. The replay's answer is right only when the grade says so
// (its expected answer, else at least not the answer graded wrong), and the agent's side is its own answer when it gave
// one, else right: a held workflow earns its way back.
/** DIGEST promoted by its dry run, then serving all 20 graded runs (each replayable), graded wrong (`expected` when
 *  given), each having said SAID; ten agent runs graded right by hand. A claim's check holds it on the 20. */
async function heldOnTwenty(t, { expected } = {}) {
  const w = await world(t, { graded: 20, agentCorrect: false });
  const settings = w.store().settings;
  await recordPromotion(settings, "agent-1", { workflow: "answer", digest: DIGEST, at: "t1", decided: "promote", source: "dry_run", reason: "r", commit: w.seed }, () => true);
  for (let i = 0; i < 10; i++) await putGrade(settings, "agent-1", { run: `hand-${i}`, correct: true, source: "eval", at: "t", path: "agent" });
  for (const run of w.gradedRuns) {
    await putGrade(settings, "agent-1", { run, correct: false, source: "eval", at: "t", path: "workflow", workflow: "answer", digest: DIGEST, ...(expected ? { expected } : {}) });
    await w.said(run, SAID);
  }
  const gate = promotionGate({ store: w.ask().store, agentId: "agent-1", runId: "now", revisionId: "rev-1", launch: { input: { content: "Now?", question: "Now" }, title: "Now", place: { mode: "runner" }, learning: startAt(w.seed) }, context: BACKGROUND_CONTEXT, log: (line) => w.logs.push(line), now: () => w.clock.at });
  assert.equal(await gate({ name: "answer", description: "Answers a question as a number", workflow: JSON.stringify(FLOW) }, DIGEST), undefined, "held on the 20 it served wrong");
  const held = (await w.records()).at(-1);
  assert.deepEqual([held.decided, held.source, held.held_on.length], ["hold", "graded", 20]);
  return w;
}

for (const [graded, expected] of [["with the grade's expected answer", { answer: 42 }], ["with no expected answer", undefined]]) {
  test(`a revision held on 20 served runs graded wrong never re-promotes by tying its own wrong answers (${graded}); answering them right promotes it`, async (t) => {
    const w = await heldOnTwenty(t, { expected });
    // The QA shape: the owner's replay answers what each run was graded wrong for.
    const tie = await ownersReplay(w, () => "answered", () => SAID);
    assert.equal(tie.record.inputs.length, 20);
    assert.deepEqual([tie.view.status, tie.view.decided], ["done", "hold"], JSON.stringify(tie.view));
    assert.deepEqual([tie.view.score.wf_acc, tie.view.score.agent_acc, tie.view.score.delta], [0, 1, -1], "the agent's side of a wrong grade it never answered is right");
    assert.match(tie.view.reason, /more than 2 pts under the agent/);
    assert.equal(servingOf(await w.records())[0].digest, null, "still held: nothing serves");
    assert.equal((await w.records()).at(-1).held_on.length, 20, "still owed by its next replay");
    // Its next replay answers them right by the grade: promoted.
    const fixed = await ownersReplay(w, () => "answered", FIXED);
    assert.deepEqual([fixed.view.status, fixed.view.decided], ["done", "promote"], JSON.stringify(fixed.view));
    assert.deepEqual([fixed.view.score.wf_acc, fixed.view.score.agent_acc], [1, 1]);
    assert.equal(servingOf(await w.records())[0].digest, DIGEST, "it serves again");
  });
}

test("a revision held on 20 served runs graded wrong that hands each back to the agent is the agent on them: promoted only on what it answered alone", async (t) => {
  const w = await heldOnTwenty(t);
  // Hands back on 15 (the agent's answer, right by default) and answers 5 alone, the same wrong answer: 75% under 100%.
  const half = await ownersReplay(w, (of) => (Number(of.split("-")[1]) < 15 ? "handed_back" : "answered"), () => SAID);
  assert.deepEqual([half.view.decided, half.view.score.wf_acc, half.view.score.agent_acc, half.view.score.handed_back], ["hold", 0.75, 1, 15], JSON.stringify(half.view));
});

// Greptile P1 on #2877: gains on other inputs never pay for the runs it was held on. Held on X and Y (served, graded wrong),
// its replay answers the five agent inputs right by their expected answer (the agent's were wrong) and says 41 again on X
// and Y: 5/7 against the agent's 2/7 overall, yet each run it was held on is as wrong as before. The runs it was held on
// are scored on their own too, and must be within the bar.
test("a revision held on runs it served wrong never re-promotes on gains elsewhere while it repeats their wrong answers", async (t) => {
  const { w, settings, older } = await heldOnServed(t);
  for (const run of older) await putGrade(settings, "agent-1", { run, correct: false, expected: { answer: 42 }, source: "eval", at: "t", path: "agent" });
  const held = (await w.records()).at(-1).held_on;
  const mixed = await ownersReplay(w, () => "answered", (of) => (held.includes(of) ? SAID : "42"));
  assert.deepEqual([mixed.view.score.wf_acc, mixed.view.score.agent_acc], [0.7143, 0.2857], `overall it clears: ${JSON.stringify(mixed.view)}`);
  assert.deepEqual([mixed.view.status, mixed.view.decided], ["done", "hold"], JSON.stringify(mixed.view));
  assert.match(mixed.view.reason, /on the 2 graded runs it was held on/);
  assert.deepEqual([...(await w.records()).at(-1).held_on].sort(), ["graded-5", "graded-6"], "still owed by its next replay");
  // Right on them too: promoted.
  const fixed = await ownersReplay(w, () => "answered", FIXED);
  assert.deepEqual([fixed.view.status, fixed.view.decided], ["done", "promote"], JSON.stringify(fixed.view));
});
