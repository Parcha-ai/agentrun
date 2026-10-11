// Property test of the recovery driver's path guards: over random desugared documents of chains, loops
// and maps of code nodes, the interpreter's own commit order is accepted, and each single perturbation
// of it is refused with the named fault. The interpreter never violates a guard, so this is the only
// place each one fires: a repeat commit, a chain step behind its frontier, iteration k+1 before k, a
// resume of a released path, a node's input changed after it started, the materialized input changed
// across processes, a session asked of a non-LLM node, and a path the document does not hold.
// A failure names its seed; replay it with RECOVERY_PATHS_SEED=<seed>.
import assert from "node:assert/strict";
import { test } from "node:test";
import { runWorkflow } from "@parcha/agentrun-dsl";
import { openRecovery, memoryStore, nodeAt, pathSegments, enclosingIterations, chainStep, isWithin } from "@parcha/agentrun-dsl/recovery";

/** mulberry32: a small seeded generator, so every document replays from its seed. */
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const pick = (rand, xs) => xs[Math.floor(rand() * xs.length)];
const int = (rand, lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));

/** A random document: a root chain of leaves, nested chains, counted loops and one-wide maps, every
 *  leaf a code node, so the interpreter runs it in process with no model. Each loop counts its own
 *  iterations to a fixed number; each map seeds its own items just before it. */
function document(rand, seed) {
  let ids = 0;
  const leaf = () => { const k = `k${ids++}`; return { node: "code", label: k, code: `(s) => ({ ${k}: (s.${k} || 0) + 1 })` }; };
  const structure = (depth) => {
    const kind = depth >= 2 ? "leaf" : pick(rand, ["leaf", "leaf", "chain", "loop", "map"]);
    if (kind === "leaf") return [leaf()];
    if (kind === "chain") return [{ node: "chain", steps: Array.from({ length: int(rand, 1, 3) }, () => structure(depth + 1)).flat() }];
    if (kind === "loop") {
      const c = `c${ids++}`; const n = int(rand, 1, 3);
      const body = { node: "chain", steps: [{ node: "code", label: c, code: `(s) => ({ ${c}: (s.${c} || 0) + 1 })` }, ...structure(depth + 1)] };
      return [{ node: "loop", label: `loop-${c}`, body: rand() < 0.5 ? body : body.steps.length === 1 ? body.steps[0] : body, until: { predicate: "field_equals", path: c, value: n }, maxIters: n }];
    }
    const m = `m${ids++}`; const items = Array.from({ length: int(rand, 1, 3) }, (_, i) => `${m}-${i}`);
    return [
      { node: "code", label: `seed-${m}`, code: `() => ({ ${m}: ${JSON.stringify(items)} })` },
      { node: "map", label: `map-${m}`, itemsPath: m, as: `out-${m}`, maxConcurrency: 1, body: { node: "chain", steps: structure(depth + 1) } },
    ];
  };
  const steps = [...Array.from({ length: int(rand, 1, 4) }, () => structure(0)).flat(), { node: "code", label: "finish", code: "() => ({ final: { ok: true } })" }];
  return {
    v: 2, name: `guards-${seed}`, schemas: { Output: { type: "object", additionalProperties: false, required: ["ok"], properties: { ok: { type: "boolean" } } } },
    output: { schemaId: "Output", path: "final" }, root: { node: "chain", steps },
  };
}

const INPUT = { question: "q", context: {}, files: [] };
/** A fresh driver on `doc` in its own store (or in the same store when one is given: a later process). */
async function driver(doc, store = memoryStore()) {
  const adapter = await openRecovery(store, doc, { key: "guards", bind: { config: { job_id: "guards", question: "q" } } });
  return { adapter, store, recovery: adapter.recovery, close: () => adapter.close() };
}

/** Run the interpreter on `doc` over a real driver, recording every commit in the order it made them. */
async function record(doc) {
  const d = await driver(doc);
  const commits = [];
  const recovery = { ...d.recovery, commit: async (node, state, item, executionPath) => { commits.push({ node, state: structuredClone(state), item, path: executionPath }); return d.recovery.commit(node, state, item, executionPath); } };
  try {
    const run = await runWorkflow(doc, INPUT, { recovery });
    assert.equal(run.status, "complete", `the interpreter's own order is accepted: ${run.status}`);
  } finally { await d.close(); }
  return commits;
}

/** Replay `commits[0..upTo)` into a fresh driver, as the interpreter would, then hand it over. */
async function replay(doc, commits, upTo = commits.length) {
  const d = await driver(doc);
  for (const c of commits.slice(0, upTo)) {
    // A node started resumes to undefined (it binds its input), then commits.
    assert.equal(await d.recovery.resume(c.node, c.state, c.item, c.path), undefined, `replaying ${c.path}`);
    await d.recovery.commit(c.node, c.state, c.item, c.path);
  }
  return d;
}

const fault = (code, message) => (error) => { assert.equal(error.code, code, error.message); if (message) assert.match(error.message, message); return true; };

/** One document: the accepted order, then every perturbation of it. Returns which guards fired. */
async function run(seed) {
  const rand = rng(seed);
  const doc = document(rand, seed);
  const commits = await record(doc);
  const fired = new Set();
  const where = (what) => `seed ${seed}: ${what}`;
  assert.ok(commits.length >= 2, where("at least the finish step and one more commit"));
  assert.ok(commits.every((c) => nodeAt(doc, c.path)), where("every committed path resolves in the document"));

  // 1. A path commits once: after the full order, any committed path again is refused.
  { const d = await replay(doc, commits); try {
      const c = pick(rand, commits);
      await assert.rejects(d.recovery.commit(c.node, c.state, c.item, c.path), fault("FROZEN_PATH_INVALID", /A path commits once/), where(`repeat ${c.path}`));
      fired.add("once");
    } finally { await d.close(); } }

  // 2. A chain step behind its frontier: two steps of one chain in the order, the later committed first.
  { const steps = commits.map((c, i) => ({ c, i, step: chainStep(c.path) })).filter((x) => x.step);
    const pair = (() => { for (let a = 0; a < steps.length; a++) for (let b = a + 1; b < steps.length; b++) if (steps[a].step.chain === steps[b].step.chain && steps[a].step.index < steps[b].step.index && enclosingIterations(steps[a].c.path).length === 0) return [steps[a], steps[b]]; return null; })();
    if (pair) {
      const [early, late] = pair;
      const d = await replay(doc, commits, early.i); try {
        await d.recovery.commit(late.c.node, late.c.state, late.c.item, late.c.path);
        await assert.rejects(d.recovery.commit(early.c.node, early.c.state, early.c.item, early.c.path), fault("FROZEN_PATH_INVALID", /behind its chain's frontier/), where(`${early.c.path} after ${late.c.path}`));
        fired.add("frontier");
      } finally { await d.close(); } } }

  // 3. Iteration k+1 before k: the first commit inside iteration 1 of a loop, before iteration 0 committed anything.
  { const inside = commits.map((c, i) => ({ c, i, it: enclosingIterations(c.path).at(-1) })).filter((x) => x.it);
    const first0 = inside.find((x) => x.it.index === 0);
    const first1 = first0 && inside.find((x) => x.it.loop === first0.it.loop && x.it.index === 1);
    if (first1) {
      const d = await replay(doc, commits, first0.i); try {
        await assert.rejects(d.recovery.commit(first1.c.node, first1.c.state, first1.c.item, first1.c.path), fault("FROZEN_PATH_INVALID", /Iteration 1 committed while its loop is on iteration 0/), where(`${first1.c.path} before iteration 0`));
        fired.add("iteration");
      } finally { await d.close(); } } }

  // 4. A released path: a loop's or map's commit releases the states of the paths inside it, and until
  //    the enclosing chain's frontier moves past that step nothing answers them, so asking again is
  //    refused. After the full order every committed path is answered from the frontier or refused,
  //    never started again.
  { const enclosing = (() => { for (let i = 0; i < commits.length; i++) for (let j = 0; j < i; j++) if (commits[j].path !== commits[i].path && isWithin(commits[j].path, commits[i].path)) return { i, j }; return null; })();
    if (enclosing) {
      const d = await replay(doc, commits, enclosing.i + 1); try {
        const inner = commits[enclosing.j];
        await assert.rejects(d.recovery.resume(inner.node, inner.state, inner.item, inner.path), fault("FROZEN_PATH_INVALID", /asked for again after its state was released/), where(`${inner.path} after ${commits[enclosing.i].path} committed`));
        fired.add("released");
      } finally { await d.close(); } }
    const d = await replay(doc, commits); try {
      for (const c of commits) {
        let answered;
        try { answered = await d.recovery.resume(c.node, c.state, c.item, c.path); }
        catch (error) { fault("FROZEN_PATH_INVALID", /asked for again after its state was released/)(error); continue; }
        assert.notEqual(answered, undefined, where(`${c.path} committed, then asked again: answered or refused, never restarted`));
      }
    } finally { await d.close(); } }

  // 5. A node's input changed after it started: the same path, started with one state, resumed with another.
  { const d = await driver(doc); try {
      const c = commits[0];
      assert.equal(await d.recovery.resume(c.node, c.state, c.item, c.path), undefined);
      await assert.rejects(d.recovery.resume(c.node, { ...c.state, changed: true }, c.item, c.path), fault("FROZEN_INPUT_CHANGED", /changed since it started/), where(`${c.path} input`));
      fired.add("input");
    } finally { await d.close(); } }

  // 6. The materialized input changed across processes: the first process starts the document with one
  //    state; a later process on the same store resumes with that same state and goes on, and one
  //    resuming with that state plus a field is refused. Same state on both sides, so the field is the
  //    only difference.
  { const first = await driver(doc); const store = first.store; const input = commits[0].state;
    try { await first.recovery.resume(commits[0].node, input, commits[0].item, commits[0].path); await first.recovery.commit(commits[0].node, input, commits[0].item, commits[0].path); } finally { await first.close(); }
    const same = await driver(doc, store); try {
      await same.recovery.resume(commits[1].node, input, commits[1].item, commits[1].path);
    } finally { await same.close(); }
    const later = await driver(doc, store); try {
      await assert.rejects(later.recovery.resume(commits[1].node, { ...input, other: "input" }, commits[1].item, commits[1].path), fault("FROZEN_INPUT_CHANGED", /Materialized workflow input changed/), where("input across processes"));
      fired.add("materialized");
    } finally { await later.close(); } }

  // 7. Only an LLM step has a session; 8. a path the document does not hold.
  { const d = await driver(doc); try {
      assert.throws(() => d.adapter.stepSession(commits[0].path, "code"), fault("FROZEN_PATH_INVALID", /Only an LLM step has a session/), where("session of a code node"));
      await assert.rejects(d.recovery.commit(commits[0].node, commits[0].state, undefined, "/root/steps/99"), fault("FROZEN_PATH_INVALID", /does not hold/), where("unknown path"));
      await assert.rejects(d.recovery.resume(commits[0].node, commits[0].state, undefined, "not-a-path"), fault("FROZEN_PATH_INVALID", /does not hold/), where("not a path"));
      fired.add("session"); fired.add("unknown");
    } finally { await d.close(); } }
  return { fired, commits: commits.length, segments: Math.max(...commits.map((c) => pathSegments(c.path).length)) };
}

test("the driver accepts the interpreter's order on random documents and refuses each perturbation with its named fault", { timeout: 600000 }, async () => {
  const only = process.env.RECOVERY_PATHS_SEED;
  const seeds = only ? [Number(only)] : Array.from({ length: 120 }, (_, i) => 7919 * (i + 1));
  const fired = new Set(); let deepest = 0;
  for (const seed of seeds) { const r = await run(seed); for (const f of r.fired) fired.add(f); deepest = Math.max(deepest, r.segments); }
  // Every guard fired somewhere in the corpus, or the generator stopped producing the structure it
  // needs. One replayed seed is one document: its own checks ran; the corpus claims are not its.
  if (!only) {
    assert.deepEqual([...fired].sort(), ["frontier", "input", "iteration", "materialized", "once", "released", "session", "unknown"], `guards fired over ${seeds.length} documents`);
    assert.ok(deepest >= 7, `the corpus nests structure (deepest path has ${deepest} segments)`);
  }
});
