import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSkillJson, skillEvents } from "../skills.ts";
import { parseHomeSkills, relearnHtml, relearnSummary } from "../relearn.ts";
import { fold } from "../reduce.ts";
import type { ShowEvent, Thread } from "../types.ts";

// The stumble -> relearn card: what the cluster did for a changed body, aggregated from D2's per-skill skill.json files (one per thread): the body each skill was trained for (mjcf_sha256, body_name),
// how long its first passing checkpoint took (passed_at.t), when its thread finished (wall_s), and, from her trainer, how long that skill would take on 8 CPU cores (cpu_estimate_s, with its source).
// Nothing is typed in here: the GPUs are the files with that body, "all passed in N s" is the largest passed_at.t, the CPU time is the sum of the per-skill estimates.
const SPIDER = "f81251c5ed89aaaa";
const HOME = "0f0f0f0f0f0f0f0f";
const sj = (skill: string, over: Record<string, unknown> = {}) =>
  JSON.stringify({ skill, label: skill, command: 0.4, mjcf_sha256: SPIDER, joints: 18, status: "done", started_at: 1791780607.2, wall_s: 90.7, passed_at: { checkpoint: 7, steps: 5898240, t: 83.3, passes: true, metric: { name: "speed backwards", value: -0.31, unit: "m/s", target: "<= -0.25" } }, body_name: "spider", cpu_estimate_s: 11600, cpu_estimate: { cores: "8 Xeon Gold 6312U", measured: "compile plus first checkpoint about 1,255-1,282 s, then about 520 env-steps/s", how: "from this run's own passed_at.steps and the measured throughput" }, ...over }); 

test("skill.json: the body, its name, the timing and the CPU estimate with its source; fields that are not there are null", () => {
  const j = parseSkillJson(sj("backwards"))!;
  assert.deepEqual([j.mjcfSha256, j.bodyName, j.startedAt, j.wallS, j.passedAt?.seconds, j.cpuEstimateS, j.cpuCores], [SPIDER, "spider", 1791780607.2, 90.7, 83.3, 11600, "8 Xeon Gold 6312U"]);
  assert.match(j.cpuHow ?? "", /measured throughput/);
  const old = parseSkillJson(JSON.stringify({ skill: "walk", status: "training", mjcf_sha256: "ab" }))!;
  assert.deepEqual([old.bodyName, old.cpuEstimateS, old.cpuCores, old.startedAt], [null, null, null, null]);
  assert.equal(parseSkillJson(JSON.stringify({ skill: "walk", status: "done", cpu_estimate_s: -5 }))!.cpuEstimateS, null, "a negative time is not one");
});

test("the thread patch carries them, so the stage can aggregate", () => {
  const e = skillEvents("backwards", parseSkillJson(sj("backwards")), [], 5, 0)[0] as Extract<ShowEvent, { t: "thread" }>;
  assert.deepEqual({ mjcf: e.patch.mjcf, bodyName: e.patch.bodyName, passedS: e.patch.passedS, wallS: e.patch.wallS, cpuS: e.patch.cpuS, cpuCores: e.patch.cpuCores }, { mjcf: SPIDER, bodyName: "spider", passedS: 83.3, wallS: 90.7, cpuS: 11600, cpuCores: "8 Xeon Gold 6312U" });
});

test("home/skills.json: the body the robot has now", () => {
  assert.equal(parseHomeSkills(JSON.stringify({ body_mjcf_sha256: HOME, skills: [] }))?.bodySha, HOME);
  assert.equal(parseHomeSkills("not json"), null);
  assert.equal(parseHomeSkills(JSON.stringify({})), null);
});

const threadsFor = (n: number, over: (i: number) => Record<string, unknown> = () => ({})): Thread[] => {
  const ev: ShowEvent[] = [{ t: "run", at: 0, run: "r", origin: 0, environments: [] }];
  for (let i = 0; i < n; i++) ev.push(...skillEvents(`s${i}`, parseSkillJson(sj(`s${i}`, over(i))), [], i, 0));
  return fold(ev).threads;
};

test("the summary: the GPUs are the skills for that body, all passed in the largest first-pass time, all home in the largest wall time, the CPU time is the sum", () => {
  const threads = threadsFor(8, (i) => ({ passed_at: { checkpoint: 3, steps: 1, t: i === 4 ? 83.3 : 53.5, passes: true }, wall_s: i === 4 ? 90.7 : 61 }));
  const s = relearnSummary(threads, HOME)!;
  assert.deepEqual([s.bodyName, s.gpus, s.passedS, s.homeS, s.cpuS, s.cpuCores, s.done, s.relearning], ["spider", 8, 83.3, 90.7, 8 * 11600, "8 Xeon Gold 6312U", true, true]);
  assert.equal(s.passed, 8);
  // Skills for another body are not this body's GPUs.
  const mixed = [...threads, ...threadsFor(2, () => ({ mjcf_sha256: HOME }))].map((t, i) => ({ ...t, id: `x${i}` }));
  assert.equal(relearnSummary(mixed, HOME)!.gpus, 8, "the body in question is the one that differs from the robot's home body");
});

test("while it is learning: how many have passed so far, no total yet, no CPU time until every skill has an estimate", () => {
  const threads = threadsFor(8, (i) => ({ status: i < 3 ? "done" : "training", wall_s: i < 3 ? 61 : null, passed_at: i < 5 ? { checkpoint: 3, steps: 1, t: 50 + i, passes: true } : null, cpu_estimate_s: i === 7 ? null : 11600 }));
  const s = relearnSummary(threads, HOME)!;
  assert.deepEqual([s.passed, s.passedS, s.homeS, s.done, s.cpuS], [5, null, null, false, null]);
});

test("the same body as the robot's home body is not a relearn; no threads, nothing", () => {
  assert.equal(relearnSummary([], HOME), null);
  assert.equal(relearnSummary(threadsFor(2), SPIDER)!.relearning, false);
  assert.equal(relearnSummary(threadsFor(2, () => ({ mjcf_sha256: null })), HOME), null, "no body named: the stage does not guess");
});

test("the card says it in plain words, from the numbers: GPUs, all passed in N s, one machine's CPU estimate with its source; nothing it was not given", () => {
  const threads = threadsFor(8, (i) => ({ passed_at: { checkpoint: 3, steps: 1, t: i === 4 ? 83.3 : 53.5, passes: true }, wall_s: 90.7 }));
  const html = relearnHtml(relearnSummary(threads, HOME)!);
  assert.match(html, /new body/i);
  assert.match(html, /spider/);
  assert.match(html, /8 GPUs/);
  assert.match(html, /all 8 skills passed in 83 s/);
  assert.match(html, /one machine with 8 Xeon Gold 6312U/);
  assert.match(html, /one skill after another/);
  assert.match(html, /25\.8 hours|25 hours|about 26 hours/);
  assert.match(html, /estimate/i);
  // Learning: counts, no claims of totals.
  const part = threadsFor(8, (i) => ({ status: "training", wall_s: null, passed_at: i < 2 ? { checkpoint: 3, steps: 1, t: 40, passes: true } : null }));
  const learning = relearnHtml(relearnSummary(part, HOME)!);
  assert.match(learning, /2 of 8 skills have passed/);
  assert.doesNotMatch(learning, /passed in/);
  assert.equal(relearnHtml(null), "");
  assert.doesNotMatch(relearnHtml({ ...relearnSummary(threads, HOME)!, bodyName: "<img src=x onerror=1>" }), /<img/);
  // No CPU estimate in the files: the card does not make one up.
  const noCpu = relearnHtml(relearnSummary(threadsFor(8, () => ({ cpu_estimate_s: null, cpu_estimate: null })), HOME)!);
  assert.doesNotMatch(noCpu, /one machine/);
});

// ---- Review: a skill retrained for another body starts over, and the single-machine comparison needs one machine named by every skill.
test("a completed skill retrained for another body starts over: its old passes, times, status and checkpoints are not the new body's", async () => {
  const { SkillsPoller } = await import("../page/skills-poller.ts");
  const files = new Map<string, string>();
  const emitted: ShowEvent[] = [];
  const poller = new SkillsPoller({ read: async (p) => files.get(p), emit: (e) => emitted.push(e), now: () => 1, skills: ["walk"] });
  const A = "aaaaaaaaaaaaaaaa";
  files.set("skills/walk/skill.json", sj("walk", { mjcf_sha256: A, status: "done", wall_s: 51.4, passed_at: { checkpoint: 5, steps: 1, t: 36.3, passes: true } }));
  files.set("skills/walk/skill-progress.jsonl", [1, 2, 3, 4, 5].map((n) => JSON.stringify({ checkpoint: n, t: n * 7, passes: n >= 5, metric: { name: "speed", value: n * 0.1, unit: "m/s", target: ">= 0.4" } })).join("\n") + "\n");
  await poller.tick();
  // The trainer reruns the skill for the spider body in the same folder: a fresh skill.json (training, no times) and a fresh progress file.
  files.set("skills/walk/skill.json", JSON.stringify({ skill: "walk", label: "walk", status: "training", mjcf_sha256: SPIDER, body_name: "spider", started_at: 1791780900 }));
  files.set("skills/walk/skill-progress.jsonl", JSON.stringify({ checkpoint: 1, t: 8, passes: false, metric: { name: "speed", value: 0.05, unit: "m/s", target: ">= 0.4" } }) + "\n");
  await poller.tick();
  const s = fold([{ t: "run", at: 0, run: "r", origin: 0, environments: [] }, ...emitted]);
  const t = s.threads[0]!;
  assert.deepEqual([t.mjcf, t.status, t.passedS, t.wallS, t.cpuS, t.points.map((p) => p.n)], [SPIDER, "learning", null, null, null, [1]], "nothing of the old body is left");
  const r = relearnSummary(s.threads, A)!;
  assert.deepEqual([r.done, r.passed, r.homeS, r.passedS], [false, 0, null, null], "the card does not claim the new body is learned");
  assert.doesNotMatch(relearnHtml(r), /All home/);
});

test("the single-machine comparison needs every skill to name the same machine: a missing or different label shows no CPU total", () => {
  const same = threadsFor(3);
  assert.equal(relearnSummary(same, HOME)!.cpuCores, "8 Xeon Gold 6312U");
  const missing = threadsFor(3, (i) => ({ cpu_estimate: i === 1 ? null : { cores: "8 Xeon Gold 6312U" } }));
  const m = relearnSummary(missing, HOME)!;
  assert.deepEqual([m.cpuS, m.cpuCores], [null, null], "one skill names no machine");
  assert.doesNotMatch(relearnHtml(m), /one machine/);
  const different = threadsFor(3, (i) => ({ cpu_estimate: { cores: i === 2 ? "16 EPYC cores" : "8 Xeon Gold 6312U" } }));
  const d = relearnSummary(different, HOME)!;
  assert.deepEqual([d.cpuS, d.cpuCores], [null, null], "two machines: the total is not one machine's time");
  assert.doesNotMatch(relearnHtml(d), /one machine/);
});

// ---- D2's round.json (work/skills/round.json, written by the assembler after the threads): the round's own summary. The stage prefers it once it is there; before, it aggregates the skill files.
import { parseRound } from "../relearn.ts";

const ROUND = {
  version: 1, body_mjcf_sha256: SPIDER, body_name: "spider", previous_body_mjcf_sha256: HOME, relearn: true, gpus: 8,
  skills: { walk: { status: "done", first_pass_s: 36.3, steps_at_first_pass: 491520, wall_s: 51.4, cpu_estimate_s: 2216 }, backwards: { status: "done", first_pass_s: 82.9, steps_at_first_pass: 5898240, wall_s: 90.3, cpu_estimate_s: 11652 } },
  all_passed_s: 82.9, all_done_s: 90.3, cpu_estimate_s: 38700, cpu_estimate: { cores: "8 Xeon Gold 6312U", measured: "compile plus first checkpoint about 1,255-1,282 s, then about 520 env-steps/s", how: "from this run's own passed_at.steps" },
  measured: ["all_passed_s", "all_done_s", "skills.*.first_pass_s", "skills.*.wall_s"], estimated: ["cpu_estimate_s", "skills.*.cpu_estimate_s"],
};

test("round.json: the round's body, whether it was a relearn, the GPUs, the largest times, the CPU estimate with its machine; an unknown version or a damaged file is nothing", () => {
  const r = parseRound(JSON.stringify(ROUND))!;
  assert.deepEqual([r.bodySha, r.bodyName, r.previousSha, r.relearn, r.gpus, r.allPassedS, r.allDoneS, r.cpuS, r.cpuCores], [SPIDER, "spider", HOME, true, 8, 82.9, 90.3, 38700, "8 Xeon Gold 6312U"]);
  assert.deepEqual(r.estimated, ["cpu_estimate_s", "skills.*.cpu_estimate_s"]);
  const first = parseRound(JSON.stringify({ ...ROUND, body_name: null, previous_body_mjcf_sha256: null, relearn: false, all_passed_s: null, cpu_estimate_s: null, cpu_estimate: null }))!;
  assert.deepEqual([first.bodyName, first.previousSha, first.relearn, first.allPassedS, first.cpuS, first.cpuCores], [null, null, false, null, null, null]);
  assert.equal(parseRound(JSON.stringify({ ...ROUND, version: 2 })), null, "a version the stage does not know is not guessed at");
  assert.equal(parseRound(JSON.stringify({ version: 1 })), null, "no body: nothing");
  assert.equal(parseRound("nope"), null);
});

test("with the round: the card says relearned, and uses the round's own totals; without it, the aggregate; a total the round left null falls back to the files", () => {
  const threads = threadsFor(8, (i) => ({ passed_at: { checkpoint: 3, steps: 1, t: i === 4 ? 83.3 : 53.5, passes: true }, wall_s: 90.7 }));
  const round = parseRound(JSON.stringify(ROUND))!;
  const s = relearnSummary(threads, HOME, round)!;
  assert.deepEqual([s.passedS, s.homeS, s.cpuS, s.gpus, s.done, s.relearning, s.fromRound], [82.9, 90.3, 38700, 8, true, true, true]);
  const html = relearnHtml(s);
  assert.match(html, /Relearned its new body/);
  assert.match(html, /all 8 skills passed in 83 s/);
  assert.match(html, /10\.8 hours/);
  assert.match(html, /from each thread(&#39;|')s start/);
  const noTotal = relearnSummary(threads, HOME, parseRound(JSON.stringify({ ...ROUND, all_passed_s: null, cpu_estimate_s: null }))!)!;
  assert.equal(noTotal.passedS, 83.3, "from the files' own largest first-pass time");
  assert.equal(noTotal.cpuS, 8 * 11600);
  const firstRound = relearnHtml(relearnSummary(threads, HOME, parseRound(JSON.stringify({ ...ROUND, relearn: false, previous_body_mjcf_sha256: null }))!)!);
  assert.doesNotMatch(firstRound, /Relearned/);
  assert.match(firstRound, /Learned its body/);
});
