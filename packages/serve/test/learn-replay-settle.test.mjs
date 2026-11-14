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
//     graded runs it replayed out of the grades kept.
// The replay runs are records the read reads (row, launch, metrics); the learning folder is real (landWorkflows).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { landWorkflows, startAt } from "./learned-workflow-seed-support.mjs";

const { openSqliteStore } = await import("../dist/store/sqlite/store.js");
const { replayView } = await import("../dist/runner/promotion.js");
const { REPLAY_DEADLINE_MS, REPLAY_LAUNCH_GRACE_MS } = await import("../dist/runner/promotion.js");
const { championOf, GRADES_KEPT, gradesKey, promotionOf, promotionsOf, putGrade, recordPromotion, servingOf, trimPromotions, PROMOTIONS_KEPT } = await import("../dist/learn/promote.js");
const { workflowDigest } = await import("../dist/runner/workflow-first.js");
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
  const storeOf = (inner) => {
    const runs = runsOf(inner);
    const settings = settingsOf(inner);
    return new Proxy(inner, { get: (target, key) => (key === "runs" ? runs : key === "settings" ? settings : typeof target[key] === "function" ? target[key].bind(target) : target[key]) });
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
  return { store: () => store, seed, gradedRuns, replayRun, reserve, reopen, records, read, ask, clock, gate, logs };
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
  const seqs = (await (await import("../dist/learn/promote.js")).gradesOf(settings, "agent-1")).filter((one) => one.digest === DIGEST).map((one) => one.seq);
  assert.equal(promotionOf(records, "answer", DIGEST)?.checked, Math.max(...seqs), "its graded check starts after the grades it was held on");
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
