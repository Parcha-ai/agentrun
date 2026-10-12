import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyState, fold, reduce } from "../reduce.ts";
import { sparkPoints, threadsHtml, threadsPhase } from "../threads-view.ts";
import type { ShowEvent } from "../types.ts";

// One robot, eight teachers: the agent split into threads (child conversations of the one session), each with its compute on its own GPU, each teaching the robot one skill. The stage folds
// per-thread events into `threads` (the shape here is the stage's own; the feed adapts D1's per-child events to it) and shows one tile per thread, then the moment every skill lands in the one robot.
const run: ShowEvent = { t: "run", at: 0, run: "demo-1", origin: 1000, environments: [] };
const SKILLS = ["walk", "sprint", "walk backwards", "turn", "spin", "get up", "jump", "crouch"];
const start = (i: number, at = 10): ShowEvent => ({ t: "thread", at, id: `t${i}`, patch: { skill: SKILLS[i]!, host: `H100 #${i + 1}`, status: "starting" } });

test("a thread's patches merge, its checkpoints accumulate in order with their unit, and a thread keeps its place in the grid", () => {
  const s = fold([
    run,
    start(0), start(1),
    { t: "thread", at: 20, id: "t0", patch: { status: "learning", acquireMs: 2100 } },
    { t: "thread.point", at: 30, id: "t0", n: 1, value: 0.4, unit: "m in 10 s" },
    { t: "thread.point", at: 40, id: "t0", n: 2, value: 1.1, unit: "m in 10 s" },
    { t: "thread.point", at: 41, id: "t1", n: 1, value: 2.0, unit: "m/s" },
    { t: "thread", at: 50, id: "t0", patch: { costUsd: 0.12 } },
  ]);
  assert.deepEqual(s.threads.map((t) => t.id), ["t0", "t1"], "insertion order, so a tile never moves");
  const t0 = s.threads[0]!;
  assert.deepEqual({ skill: t0.skill, host: t0.host, status: t0.status, acquireMs: t0.acquireMs, costUsd: t0.costUsd, unit: t0.unit }, { skill: "walk", host: "H100 #1", status: "learning", acquireMs: 2100, costUsd: 0.12, unit: "m in 10 s" });
  assert.deepEqual(t0.points.map((p) => [p.n, p.value]), [[1, 0.4], [2, 1.1]]);
  assert.equal(s.threads[1]!.unit, "m/s");
  assert.equal(emptyState().threads.length, 0);
});

test("a repeated checkpoint (the same thread and n) is one point, a point for an unknown thread makes the thread, and an older n after a newer one is ignored", () => {
  let s = fold([run, start(0)]);
  s = reduce(s, { t: "thread.point", at: 20, id: "t0", n: 2, value: 1, unit: "m" });
  s = reduce(s, { t: "thread.point", at: 21, id: "t0", n: 2, value: 1, unit: "m" });
  s = reduce(s, { t: "thread.point", at: 22, id: "t0", n: 1, value: 0.5, unit: "m" });
  assert.deepEqual(s.threads[0]!.points.map((p) => p.n), [2]);
  s = reduce(s, { t: "thread.point", at: 30, id: "late", n: 1, value: 3, unit: "m" });
  assert.deepEqual(s.threads.map((t) => t.id), ["t0", "late"]);
  assert.equal(s.threads[1]!.status, "learning", "a thread that reports a checkpoint is learning");
});

test("the phase: learning while any thread is not finished, then the skills landing in the robot, then home when every skill that finished is in", () => {
  assert.equal(threadsPhase([]), "none");
  const base = fold([run, ...SKILLS.map((_, i) => start(i))]).threads;
  assert.equal(threadsPhase(base), "learning");
  const done = base.map((t) => ({ ...t, status: "done" as const }));
  assert.equal(threadsPhase(done), "landing", "all done, none installed yet");
  assert.equal(threadsPhase(done.map((t, i) => ({ ...t, home: i < 3 }))), "landing");
  assert.equal(threadsPhase(done.map((t) => ({ ...t, home: true }))), "home");
  assert.equal(threadsPhase(done.map((t, i) => ({ ...t, status: i === 2 ? ("failed" as const) : t.status, home: i !== 2 }))), "home", "a thread that failed does not hold the robot back; the tile says so");
  assert.equal(threadsPhase(base.map((t, i) => (i === 0 ? { ...t, status: "done" as const } : t))), "learning");
});

test("sparkline points are the checkpoints' values scaled into the box, in order; one point is a dot; none is nothing", () => {
  assert.equal(sparkPoints([], 100, 40), "");
  assert.equal(sparkPoints([{ n: 1, value: 3, at: 0 }], 100, 40), "50.0,20.0");
  const p = sparkPoints([{ n: 1, value: 0, at: 0 }, { n: 2, value: 2, at: 0 }, { n: 3, value: 1, at: 0 }], 100, 40).split(" ");
  assert.deepEqual(p, ["0.0,40.0", "50.0,0.0", "100.0,20.0"]);
  assert.deepEqual(sparkPoints([{ n: 1, value: 5, at: 0 }, { n: 2, value: 5, at: 0 }], 100, 40).split(" "), ["0.0,20.0", "100.0,20.0"], "a flat line sits in the middle");
});

test("the tiles: one per thread with its skill, its GPU, its status and its latest value in its own unit; nothing said that an event did not carry; the agent is one agent split into threads", () => {
  const s = fold([
    run,
    start(0), start(1),
    { t: "thread", at: 20, id: "t0", patch: { status: "learning", acquireMs: 2100, costUsd: 0.12 } },
    { t: "thread.point", at: 30, id: "t0", n: 3, value: 1.25, unit: "m in 10 s" },
  ]);
  const html = threadsHtml(s.threads);
  assert.match(html, /The agent split into 2 threads, one per GPU/);
  assert.match(html, /data-status="learning"/);
  assert.match(html, /walk/);
  assert.match(html, /H100 #1/);
  assert.match(html, /1\.25 m in 10 s/);
  assert.match(html, /GPU in 2\.1 s/);
  assert.match(html, /\$0\.12/);
  assert.match(html, /sprint/);
  assert.equal((html.match(/class="tile"/g) ?? []).length, 2);
  // t1 has no point, no acquire time and no cost: none of those are claimed for it.
  const t1 = html.slice(html.indexOf('data-id="t1"'));
  assert.doesNotMatch(t1, /GPU in/);
  assert.doesNotMatch(t1, /\$/);
  assert.match(t1, /waiting for its first checkpoint/);
  assert.doesNotMatch(threadsHtml([{ ...s.threads[0]!, skill: "<img src=x onerror=1>" }]), /<img/);
  assert.equal(threadsHtml([]), "");
  assert.match(threadsHtml([{ ...s.threads[0]!, status: "failed" }]), /data-status="failed"/);
});

test("home: every skill lights in the one robot as its thread's skill is installed, and the line says how many are in", () => {
  const base = fold([run, ...SKILLS.map((_, i) => start(i))]).threads.map((t) => ({ ...t, status: "done" as const }));
  const some = base.map((t, i) => ({ ...t, home: i < 3 }));
  const html = threadsHtml(some);
  assert.match(html, /3 of 8 skills are in the robot/);
  assert.equal((html.match(/class="skill in"/g) ?? []).length, 3);
  assert.equal((html.match(/class="skill"/g) ?? []).length, 5);
  const all = threadsHtml(base.map((t) => ({ ...t, home: true })));
  assert.match(all, /All 8 skills are in the robot/);
  assert.match(all, /data-phase="home"/);
  assert.doesNotMatch(all, /class="tile"/, "home shows the one robot, not the tiles");
});
