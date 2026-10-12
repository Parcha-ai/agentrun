import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyState, fold, reduce } from "../reduce.ts";
import { sparkPoints, threadsHtml, threadsPhase } from "../threads-view.ts";
import type { ShowEvent } from "../types.ts";

// One robot, eight teachers: the agent split into threads (child conversations of the one session), each with its compute on its own GPU, each teaching the robot one skill. The stage folds
// per-thread events into `threads` (the shape here is the stage's own; the feed adapts D1's per-child events to it) and shows one tile per thread, then the moment every skill lands in the one robot.
const run: ShowEvent = { t: "run", at: 0, run: "demo-1", origin: 1000, environments: [] };
const SKILLS = ["walk", "sprint", "walk backwards", "turn", "spin", "get up", "jump", "crouch"];
const pt = (n: number, value: number | null, extra: Partial<{ passes: boolean | null; fell: boolean; seconds: number | null }> = {}) => ({ n, value, at: 0, passes: null, fell: false, seconds: null, ...extra });
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
  assert.equal(sparkPoints([pt(1, 3)], 100, 40), "50.0,20.0");
  const p = sparkPoints([pt(1, 0), pt(2, 2), pt(3, 1)], 100, 40).split(" ");
  assert.deepEqual(p, ["0.0,40.0", "50.0,0.0", "100.0,20.0"]);
  assert.deepEqual(sparkPoints([pt(1, null), pt(2, 1), pt(3, null), pt(4, 3)], 100, 40).split(" "), ["33.3,40.0", "100.0,0.0"], "a checkpoint with no value (get-up before it succeeds) is not drawn, and the others keep their places");
  assert.deepEqual(sparkPoints([pt(1, 5), pt(2, 5)], 100, 40).split(" "), ["0.0,20.0", "100.0,20.0"], "a flat line sits in the middle");
});

test("the tiles: one per thread with its skill, its GPU, its status, and its latest checkpoint in the skill's own metric and unit with pass or fail; nothing said that an event did not carry", () => {
  const s = fold([
    run,
    start(0), start(1),
    { t: "thread", at: 20, id: "t0", patch: { status: "learning", acquireMs: 2100, costUsd: 0.12, metric: "speed", unit: "m/s", target: ">= 0.4" } },
    { t: "thread.point", at: 30, id: "t0", n: 3, value: 1.25, unit: "m/s", passes: true, fell: false, seconds: 44.2 },
  ]);
  const html = threadsHtml(s.threads);
  assert.match(html, /The agent split into 2 threads, one per GPU/);
  assert.match(html, /data-status="learning"/);
  assert.match(html, /walk/);
  assert.match(html, /H100 #1/);
  assert.match(html, /checkpoint 3/);
  assert.match(html, /speed 1\.25 m\/s/);
  assert.match(html, /class="pass yes"/);
  assert.match(html, /44 s in/);
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

test("a checkpoint that has not passed says what passing needs; one that fell says so; get-up with no value yet says that", () => {
  const base = fold([run, start(7)]).threads[0]!;
  const t = { ...base, metric: "speed", unit: "m/s", target: ">= 0.4", status: "learning" as const };
  const notYet = threadsHtml([{ ...t, points: [pt(2, 0.2, { passes: false, seconds: 21 })] }]);
  assert.match(notYet, /class="pass no"/);
  assert.match(notYet, /needs &gt;= 0\.4/);
  const fell = threadsHtml([{ ...t, points: [pt(2, 0.1, { passes: false, fell: true, seconds: 21 })] }]);
  assert.match(fell, /fell in its test/);
  const getUp = threadsHtml([{ ...t, metric: "slowest get-up", unit: "s", target: "rights itself from left, right and back", points: [pt(1, null, { passes: false })] }]);
  assert.match(getUp, /slowest get-up: no value yet/);
  assert.doesNotMatch(getUp, /NaN|null/);
  const none = threadsHtml([{ ...t, points: [pt(1, 0.5, { passes: null })] }]);
  assert.doesNotMatch(none, /class="pass/, "no verdict in the file: none is claimed");
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

import { nextToLand } from "../threads-view.ts";
import { tabEventsFrom } from "../page/tab-link.ts";

test("landing: once every thread has finished and the run is home, the skills go into the robot one at a time, in their order, never a failed one", () => {
  const base = fold([run, ...SKILLS.map((_, i) => start(i))]).threads.map((t) => ({ ...t, status: "done" as const }));
  assert.equal(nextToLand(base.map((t) => ({ ...t, status: "learning" as const })), true), null, "not while any is learning");
  assert.equal(nextToLand(base, false), null, "not before the run is home");
  assert.equal(nextToLand(base, true), "t0");
  assert.equal(nextToLand(base.map((t, i) => ({ ...t, home: i < 3 })), true), "t3");
  assert.equal(nextToLand(base.map((t) => ({ ...t, home: true })), true), null);
  assert.equal(nextToLand(base.map((t, i) => ({ ...t, status: i === 0 ? ("failed" as const) : t.status })), true), "t1", "a failed skill is skipped");
  assert.equal(nextToLand([], true), null);
});

test("the tab's own word that a skill is installed marks that thread's skill as in the robot", () => {
  assert.deepEqual(tabEventsFrom({ type: "skill-installed", run: null, detail: { skill: "spin", sha: "ab12", ms: 340 } }, 9), [{ t: "thread", at: 9, id: "spin", patch: { home: true } }]);
  assert.deepEqual(tabEventsFrom({ type: "skill-installed", run: null, detail: { sha: "x" } }, 9), [], "no skill named: nothing");
});

import { LandingDriver } from "../threads-view.ts";

test("the landing driver: once the tab has said a skill is installed the stage stops landing them itself; a new run starts over", () => {
  const base = fold([run, ...SKILLS.map((_, i) => start(i))]).threads.map((t) => ({ ...t, status: "done" as const }));
  const d = new LandingDriver();
  assert.equal(d.next(base, true), "t0");
  d.noteInstalled();
  assert.equal(d.next(base, true), null, "the tab is telling the stage itself");
  d.reset();
  assert.equal(d.next(base, true), "t0", "a retake: what the page knew about the old run is gone");
});

// ---- What the first live run showed (D4's rehearsal, 2026-10-12): the live feed's place after coming back is "tab" (not "home"), so the skills never landed; the threads appeared one by one, so the
// header said "split into 1 thread" and grew; and the cartoon robot covered the real creature under it.
import { runIsHome, withExpected } from "../threads-view.ts";
import { SKILLS as EIGHT, SKILL_LABELS } from "../skills.ts";

test("the run is home when the place says home, or when it is back in the tab after being away (the live feed says tab); never while it is away or has not left", () => {
  const away = { stays: [{ id: "s1", lane: "run", host: "your browser", hostKind: "tab", from: 0 }, { id: "s2", lane: "run", host: "a Modal VM", hostKind: "vm", from: 5 }] };
  assert.equal(runIsHome({ place: { where: "home", host: "x" }, stays: [] } as never), true);
  assert.equal(runIsHome({ place: { where: "tab", host: "your browser" }, ...away } as never), true, "back in the tab after a stay on a VM");
  assert.equal(runIsHome({ place: { where: "tab", host: "your browser" }, stays: [away.stays[0]] } as never), false, "never left: not home from anywhere");
  assert.equal(runIsHome({ place: { where: "cloud", host: "a Modal VM" }, ...away } as never), false);
  assert.equal(runIsHome({ place: { where: "moving", to: "your browser", host: "a Modal VM" }, ...away } as never), false);
});

test("while the threads learn, the skills that have no thread yet are shown waiting for their box, so the agent is one agent split into eight from the first thread on; they do not count toward the phase", () => {
  // The threads are named by their skill (the poller makes them from the skill folders).
  const byDir = (dir: string): ShowEvent => ({ t: "thread", at: 1, id: dir, patch: { skill: dir, host: null, status: "learning" } });
  const one = fold([run, byDir("walk")]).threads;
  const shown = withExpected(one, EIGHT);
  assert.deepEqual(shown.map((t) => t.id), [...EIGHT]);
  assert.equal(shown[0]!.status, "learning", "the real thread keeps its own status");
  assert.equal(shown[1]!.status, "starting");
  assert.equal(shown[5]!.skill, SKILL_LABELS.spin);
  assert.equal(shown[5]!.status, "starting");
  assert.match(threadsHtml(one, EIGHT), /The agent split into 8 threads, one per GPU/);
  assert.equal((threadsHtml(one, EIGHT).match(/class="tile"/g) ?? []).length, 8);
  assert.match(threadsHtml(one, EIGHT), /getting a GPU/);
  // Only the real threads decide the phase: a run that teaches fewer skills still lands them.
  const three = fold([run, byDir("walk"), byDir("sprint"), byDir("spin")]).threads.map((t) => ({ ...t, status: "done" as const }));
  assert.equal(threadsPhase(three), "landing");
  assert.doesNotMatch(threadsHtml(three, EIGHT), /class="tile"/, "once they have finished, the placeholders are gone");
  // No thread yet: nothing is shown (the stage does not announce eight threads before there is one).
  assert.equal(threadsHtml([], EIGHT), "");
  // A thread whose id is not one of the eight stays, after them.
  assert.deepEqual(withExpected(fold([run, byDir("walk"), { t: "thread", at: 1, id: "extra", patch: { skill: "x", status: "starting" } } as ShowEvent]).threads, EIGHT).map((t) => t.id).slice(-1), ["extra"]);
});

test("landing and home show the skills and the count but not a drawing of a robot: the real creature in the page stays visible beneath", () => {
  const base = fold([run, ...SKILLS.map((_, i) => start(i))]).threads.map((t) => ({ ...t, status: "done" as const }));
  const html = threadsHtml(base.map((t, i) => ({ ...t, home: i < 3 })));
  assert.doesNotMatch(html, /<svg class="robot"/);
  assert.match(html, /3 of 8 skills are in the robot/);
  assert.equal((html.match(/class="skill in"/g) ?? []).length, 3);
});
