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
