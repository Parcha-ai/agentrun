// teach_skills end to end over a real Harness on SQLite, with fake GPU boxes and a scripted model: each case runs
// spike/spike.ts, which SIGKILLs the first host while the parent waits on its threads and finishes in a second one.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { foldText, SKILLS, skillsToTeach, type ThreadResult } from "../teach-skills.ts";

const here = dirname(fileURLToPath(import.meta.url));
const spike = join(here, "..", "spike", "spike.ts");
const host = join(here, "..", "spike", "host.ts");
const spikePlan = join(here, "..", "spike", "spike_plan.ts");

function runPlan(...extra: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "teach-plan-"));
  const r = spawnSync(process.execPath, [spikePlan, "--dir", dir, "--tick", "200", ...extra], { encoding: "utf8", timeout: 120_000 });
  return { status: r.status, verdict: JSON.parse(readFileSync(join(dir, "verdict.json"), "utf8")) };
}

function runSpike(capacity: number, ...extra: string[]) {
  const dir = mkdtempSync(join(tmpdir(), `teach-skills-${capacity}-`));
  const r = spawnSync(process.execPath, [spike, "--dir", dir, "--tick", "150", "--capacity", String(capacity), ...extra], { encoding: "utf8", timeout: 120_000 });
  const verdict = JSON.parse(readFileSync(join(dir, "verdict.json"), "utf8"));
  return { status: r.status, verdict };
}

test("eight threads survive a SIGKILL of the host while the parent waits allSettled, and GPU 3 reads back", () => {
  const { status, verdict } = runSpike(8);
  // The scripted session calls teach_skills({}) for "Teach it to move.": no skills named forks all eight threads.
  assert.equal(verdict.checks.omitted_skills_teach_all_eight, true);
  assert.equal(verdict.checks.passed_skills_are_home, true);
  for (const [name, passed] of Object.entries(verdict.checks)) assert.equal(passed, true, name);
  assert.equal(status, 0);
  assert.equal(verdict.peak_boxes, 8);
  assert.match(verdict.ask, /GPU 3 \(backwards\)/);
  // Threads cut off by the kill reran through pi-run, which stopped the earlier run first; finished ones did not rerun.
  const reran = verdict.reruns.filter((r: { runs: string[] }) => r.runs.includes("pi-run.stopped-previous"));
  assert.ok(reran.length >= 1);
  for (const r of reran) assert.deepEqual(r.runs.slice(-2), ["pi-run.stopped-previous", "train.start"]);
});

test("a pool of two boxes queues the threads in acquire and still joins all eight", () => {
  const { status, verdict } = runSpike(2);
  for (const [name, passed] of Object.entries(verdict.checks)) assert.equal(passed, true, name);
  assert.equal(status, 0);
  assert.equal(verdict.peak_boxes, 2);
});

test("a replay of a skill that already passed reports that run's checkpoint and seconds, not invented ones", () => {
  const { status, verdict } = runSpike(8, "--done-before", "get-up:4:30");
  assert.equal(verdict.checks["replayed_get-up_reports_its_saved_run"], true);
  for (const [name, passed] of Object.entries(verdict.checks)) assert.equal(passed, true, name);
  assert.equal(status, 0);
});

test("finished skills lower the kill point instead of leaving the spike waiting for checkpoints that never come", () => {
  // These three finish before the run starts, leaving 24 checkpoints: more than half of them, but fewer than 30.
  const { status, verdict } = runSpike(8, "--done-before", "backwards:6:30,spin:6:30,get-up:6:30");
  for (const [name, passed] of Object.entries(verdict.checks)) assert.equal(passed, true, name);
  assert.equal(status, 0);
});

test("a spike where every skill is already done is refused at once, not left waiting", () => {
  const dir = mkdtempSync(join(tmpdir(), "teach-skills-none-"));
  const all = ["walk", "sprint", "backwards", "turn-left", "turn-right", "spin", "wave", "get-up"].map((s) => `${s}:3:20`).join(",");
  const r = spawnSync(process.execPath, [spike, "--dir", dir, "--tick", "150", "--done-before", all], { encoding: "utf8", timeout: 30_000 });
  assert.notEqual(r.status, 0);
  assert.equal(r.signal, null, "it exited by itself, not by the test's timeout");
  assert.match(r.stdout + r.stderr, /no thread trains/);
});

test("aborting the run mid-way stops every artifact mirror and gives every box back", () => {
  const dir = mkdtempSync(join(tmpdir(), "teach-skills-abort-"));
  const r = spawnSync(process.execPath, [host, "--dir", dir, "--mode", "abort", "--tick", "150"], { encoding: "utf8", timeout: 120_000 });
  assert.equal(r.status, 0, r.stderr);
  const report = JSON.parse(readFileSync(join(dir, "abort-report.json"), "utf8"));
  assert.ok(report.mirrorsBefore > 0, "mirrors were running when the run was aborted");
  assert.equal(report.mirrorsAfter, 0);
  assert.equal(report.teach, "aborted");
  assert.deepEqual(report.tasks_after, []);
  const pool = readFileSync(join(dir, "pool", "log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(pool.filter((p) => p.event === "pool.release").length, pool.filter((p) => p.event === "pool.create").length);
});

test("a failing assemble is reported in the tool's result and every thread's result is kept", () => {
  const { status, verdict } = runSpike(8, "--assemble-fails");
  assert.equal(verdict.checks.home_failure_reported_with_thread_results_kept, true);
  for (const [name, passed] of Object.entries(verdict.checks)) assert.equal(passed, true, name);
  assert.equal(status, 0);
});

test("a call teaches the skills named, else every skill offered, each once", () => {
  assert.deepEqual(skillsToTeach(undefined, undefined), [...SKILLS]);
  assert.deepEqual(skillsToTeach([], ["walk", "spin"]), ["walk", "spin"]);
  assert.deepEqual(skillsToTeach(undefined, ["walk", "walk", "spin", "walk"]), ["walk", "spin"]);
  assert.deepEqual(skillsToTeach(["spin", "spin"], ["walk"]), ["spin"]);
});

test("code mode: the session plans skills with briefs, each thread writes and runs its own training, survives a SIGKILL", () => {
  const { status, verdict } = runPlan();
  for (const [name, passed] of Object.entries(verdict.checks)) assert.equal(passed, true, name);
  assert.equal(status, 0);
  assert.deepEqual(verdict.threads.map((t: { skill: string; status: string }) => [t.skill, t.status]), [["walk", "passed"], ["spin", "passed"], ["wave", "never-passed"]]);
});

test("code mode: a thread past its deadline is stopped and folds as timed out, the others are kept", () => {
  const { status, verdict } = runPlan("--deadline-ms", "900");
  for (const [name, passed] of Object.entries(verdict.checks)) assert.equal(passed, true, name);
  assert.equal(status, 0);
});

test("the fold says which skills came home, or why they could not", () => {
  const t: ThreadResult = { skill: "walk", gpu: 1, conversationId: 3, boxId: "sb-1", status: "passed", checkpoint: 3, seconds: 21, summary: "walk passed." };
  assert.match(foldText([t], { skills: ["walk"] }), /^Home: 1 skill \(walk\)\.$/m);
  assert.match(foldText([t], { error: "assemble-skills exited 1" }), /^Bringing the skills home failed: assemble-skills exited 1$/m);
  assert.doesNotMatch(foldText([t]), /Home:|home failed/);
});

test("the fold names every thread, passed or not, in its own words", () => {
  const threads: ThreadResult[] = [
    { skill: "walk", gpu: 1, conversationId: 3, boxId: "sb-1", status: "passed", checkpoint: 3, seconds: 21, summary: "walk passed at checkpoint 3." },
    { skill: "wave", gpu: 7, conversationId: 9, boxId: "sb-7", status: "never-passed", summary: "wave never passed its test." },
  ];
  assert.equal(
    foldText(threads),
    [
      "2 threads finished: 1 passed, 1 did not.",
      "- GPU 1 · walk: passed at checkpoint 3 in 21 s. walk passed at checkpoint 3.",
      "- GPU 7 · wave: never passed. wave never passed its test.",
      "Each thread's own conversation: read_thread with its skill or GPU number.",
    ].join("\n"),
  );
});
