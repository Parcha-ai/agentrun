// The learning bench (scripts/learn-bench.mjs) without a model: every job under learn-bench/ reads, becomes a template
// package whose steps the template eval's readCases() checks whole, and the script's --dry plans them; its metrics and
// its summary come out of steps as the schema says (learn-bench/results.schema.json); a job.yaml out of shape is refused.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { metricsOf, packageOf, readJob, render, SCHEMA } from "../scripts/learn-bench.mjs";

const serve = dirname(dirname(fileURLToPath(import.meta.url)));
const jobsDir = join(serve, "learn-bench");
const jobs = readdirSync(jobsDir, { withFileTypes: true }).filter((e) => e.isDirectory() && existsSync(join(jobsDir, e.name, "job.yaml"))).map((e) => e.name).sort();
const scratch = () => mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "learn-bench-test-"));

test("every job reads, and its steps check whole as template eval cases", (t) => {
  assert.ok(jobs.length >= 6, jobs.join(", "));
  const templates = scratch();
  t.after(() => rmSync(templates, { recursive: true, force: true }));
  for (const name of jobs) {
    const job = readJob(join(jobsDir, name));
    const pkg = packageOf(job, templates);
    assert.deepEqual(pkg.cases.map((c) => c.name).sort(), job.steps.map((s) => s.id).sort(), `${name}: one case per step`);
    for (const c of pkg.cases) assert.ok(c.graders.length > 0, `${name}/${c.name} has graders`);
    assert.ok(job.steps.some((s) => s.kind === "teach"), `${name} teaches`);
  }
});

test("--dry plans every job on each of its harnesses, both arms, and spends nothing", () => {
  const out = execFileSync(process.execPath, [join(serve, "scripts", "learn-bench.mjs"), "--dry"], { encoding: "utf8" });
  const plan = out.trim().split("\n").map((line) => JSON.parse(line));
  const expected = jobs.flatMap((name) => readJob(join(jobsDir, name)).harnesses.flatMap((h) => ["on", "off"].map((arm) => `${name}/${h}/${arm}`)));
  assert.deepEqual(plan.map((p) => `${p.job}/${p.harness}/${p.arm}`).sort(), expected.sort());
});

test("a job.yaml out of shape is refused, naming each problem", (t) => {
  const dir = join(scratch(), "bad");
  t.after(() => rmSync(dirname(dir), { recursive: true, force: true }));
  mkdirSync(join(dir, "steps", "01", "graders"), { recursive: true });
  writeFileSync(join(dir, "job.yaml"), "steps:\n  - { id: \"01\", kind: lesson }\nsurprise: 1\n");
  writeFileSync(join(dir, "agent.md"), "---\nname: bad\n---\nx\n");
  writeFileSync(join(dir, "steps", "01", "prompt.md"), "x\n");
  assert.throws(() => readJob(dir), (error) => /no field surprise/.test(error.message) && /kind: teach\|repeat\|change\|plant/.test(error.message));
});

/** A step as the runner records it, with its graders' verdicts. */
const step = (id, kind, graders, extra = {}) => ({
  id, kind, status: "completed", pass: graders.every(([, pass]) => pass), graders: graders.map(([grader, pass]) => ({ grader, type: "regex", pass, reason: "" })),
  cost_usd: 0.002, work_cost_usd: 0.001, reflect_cost_usd: 0.001, grade_cost_usd: 0.0005, grade_cost_unpriced: false, eval_grader_cost_usd: null,
  learning: { state: "merged" }, learned: { notes: [], skills: [], workflows: [] }, workflow_proposed: false, learned_workflow_calls: 0, approvals: [], active_after: { notes: {}, skills: {}, workflows: {} },
  ...extra,
});

test("the metrics: follow on repeat steps, the work cost's trend, workflow reuse, staleness and wrong keeps", () => {
  const steps = [
    step("01", "teach", [["a.md", true]], { work_cost_usd: 0.004, workflow_proposed: true, learned: { notes: [], skills: ["s"], workflows: ["w"] }, active_after: { notes: {}, skills: { s: "1" }, workflows: { w: "1" } } }),
    step("02", "repeat", [["a.md", true]], { work_cost_usd: 0.003, learned_workflow_calls: 1, active_after: { notes: {}, skills: { s: "1" }, workflows: { w: "1" } } }),
    step("03", "change", [["a.md", true]], { work_cost_usd: 0.002, active_after: { notes: {}, skills: { s: "2" }, workflows: { w: "1" } } }),
    step("04", "plant", [["a.md", false], ["change-new.md", true]], { work_cost_usd: 0.002, learned_workflow_calls: 1, active_after: { notes: {}, skills: { s: "2" }, workflows: { w: "1" } } }),
    step("05", "repeat", [["a.md", true], ["change-new.md", false], ["plant-not-kept.md", false]], { work_cost_usd: 0.001, grade_cost_usd: null, grade_cost_unpriced: true, active_after: { notes: {}, skills: { s: "2" }, workflows: { w: "1" } } }),
  ];
  const m = metricsOf(steps, true);
  assert.equal(m.follow_rate, 0.5, "02 passed, 05 did not");
  assert.ok(m.cost_trend_usd_per_run < 0, "the work got cheaper");
  assert.equal(m.workflow_proposal_rate, 1);
  assert.equal(m.reuse_rate, 0.5, "of 02-05 after the workflow kept at 01: 02 and 04 called it");
  assert.deepEqual(m.staleness.map((s) => [s.change_step, s.skill_updated, s.workflow_updated, s.change_graders_pass_rate]), [["03", true, false, 0.5]]);
  assert.equal(m.staleness[0].workflow_follows, true, "the one step after the change that called the workflow (04) passed its change grader");
  assert.deepEqual([m.wrong_keeps, m.plant_graders], [1, 1]);
  assert.equal(m.grade_cost_unknown_steps, 1);
  assert.ok(m.learning_overhead_usd_per_run > 0, "a lower bound with one grade unknown");
});

test("the summary: one table row per series, and a refused series said as stopped", () => {
  const ok = { job: "j", harness: "pi", arm: "on", steps: [step("01", "teach", [["a.md", true]])], error: null };
  ok.metrics = metricsOf(ok.steps, true);
  const stopped = { job: "j", harness: "claude-agent", arm: "on", steps: [], error: "starting the run: 409 not runnable" };
  stopped.metrics = metricsOf([], true);
  const text = render({ schema: SCHEMA, bench: { sha: "0123456789abc" }, hard_stop: null, series: [ok, stopped] });
  assert.match(text, /^Learning bench \(learning-bench\/2\), build 0123456789/);
  assert.equal(text.split("\n").filter((line) => line.startsWith("| j |")).length, 2);
  assert.match(text, /SERIES STOPPED: starting the run: 409/);
});
