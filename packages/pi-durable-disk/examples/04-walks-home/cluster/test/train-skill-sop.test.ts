// train-skill.md's answers to the trainer's diagnoses: which ones get a retry, and which mean the body cannot do the
// skill, so the thread reports instead of training again (D2's #295 diagnoses).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const spikePlan = join(here, "..", "spike", "spike_plan.ts");
function runPlan(...extra: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "teach-plan-"));
  const r = spawnSync(process.execPath, [spikePlan, "--dir", dir, "--tick", "200", ...extra], { encoding: "utf8", timeout: 120_000 });
  return { status: r.status, verdict: JSON.parse(readFileSync(join(dir, "verdict.json"), "utf8")) };
}

test("a skill the trainer finds was never measured is reported after its one try: no 40M, no edit, the diagnosis in the fold", () => {
  const { status, verdict } = runPlan("--unmeasured");
  for (const [name, passed] of Object.entries(verdict.checks)) assert.equal(passed, true, name);
  assert.equal(status, 0);
  assert.deepEqual(verdict.ladder["get-up"], ["copy", "12M"], "one 12M try, then a report");
  const getUp = verdict.threads.find((t: { skill: string }) => t.skill === "get-up");
  assert.equal(getUp.status, "never-passed");
  assert.match(getUp.reason, /^self-righting was never measured/);
  const tools = verdict.tools.find((t: { skill: string }) => t.skill === "get-up").tools as string[];
  assert.equal(tools.filter((t) => t.startsWith("edit") || t.startsWith("write")).length, 0, "no weight edit and no new file");
  assert.equal(verdict.checks.the_thread_reports_its_diagnosis_in_its_own_words, true, "it says this body cannot do it, and why");
});

test("a skill whose metric never settles is reported after its one try with what the body needs: no 40M, no edit", () => {
  const { status, verdict } = runPlan("--unsettled");
  for (const [name, passed] of Object.entries(verdict.checks)) assert.equal(passed, true, name);
  assert.equal(status, 0);
  assert.deepEqual(verdict.ladder["turn-right"], ["copy", "12M"], "one 12M try, then a report: training longer rarely settles it");
  const turn = verdict.threads.find((t: { skill: string }) => t.skill === "turn-right");
  assert.equal(turn.status, "never-passed");
  assert.match(turn.reason, /^yaw rate never settles/);
  const tools = verdict.tools.find((t: { skill: string }) => t.skill === "turn-right").tools as string[];
  assert.equal(tools.filter((t) => t.startsWith("edit") || t.startsWith("write")).length, 0, "no weight edit and no new file");
  assert.equal(verdict.checks.the_thread_reports_its_diagnosis_in_its_own_words, true, "it says what the body needs (flat feet), not that the skill is impossible");
});

test("the spike refuses plan flags that would pick two different third skills, before anything runs", () => {
  const dir = mkdtempSync(join(tmpdir(), "teach-plan-"));
  const r = spawnSync(process.execPath, [spikePlan, "--dir", dir, "--unmeasured", "--new-skill"], { encoding: "utf8", timeout: 60_000 });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /pick one of --new-skill, --unmeasured and --unsettled/);
  assert.throws(() => readFileSync(join(dir, "verdict.json")), "no run, no verdict");
});

test("train-skill.md retries only a try that is still changing or a reward without gradient; never settles and never measured are reported", () => {
  const sop = readFileSync(join(here, "..", "sop", "train-skill.md"), "utf8").replace(/\s+/g, " ");
  assert.match(sop, /Never settles, or was never measured: no retry, since the body and not the training is the problem/);
  assert.match(sop, /\*\*Never settles\*\* \(the metric swings with no trend\): do not train longer/);
  assert.match(sop, /report never passed with the trainer's diagnosis and what the body needs \(for example "flat feet"\)/);
  assert.match(sop, /\*\*Was never measured\*\* \(the skill never happened at any checkpoint: a get-up that never righted, a pose never reached\): do not retry\./);
  assert.match(sop, /Report that this body cannot do it and why/);
});
