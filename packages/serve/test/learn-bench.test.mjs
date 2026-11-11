// The learning bench (scripts/learn-bench.mjs) without a model: every job under learn-bench/ reads, becomes a template
// package whose steps the template eval's readCases() checks whole, and the script's --dry plans them; its metrics and
// its summary come out of steps as the schema says (learn-bench/results.schema.json); a job.yaml out of shape is refused.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
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
  tokens: { input: 900, cache_read: 0, cache_write: 0, output: 100, requests: 2, unmetered: 0 }, learning: { state: "merged" }, learned: { notes: [], skills: [], workflows: [] }, workflow_proposed: false, learned_workflow_calls: 0, approvals: [], active_after: { notes: {}, skills: {}, workflows: {} },
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
  assert.deepEqual([m.follow_k, m.follow_n, m.pass_k, m.pass_n], [1, 2, 3, 5], "the counts beside the rates");
  assert.deepEqual([m.tokens_per_run, m.tokens_per_pass, m.tokens_known_steps], [1000, Math.round(5000 / 3), 5], "input + output per run, and per passing step");
  assert.equal(metricsOf(steps.map((x) => ({ ...x, tokens: null })), true).tokens_per_pass, null, "unknown when no run booked its tokens");
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

// The review's four: the bench's deadline caps every wait and starts no grader past it; a known $0 stays $0 and only a
// run that booked no request reads unknown; the active and pending items follow the notes' pages.
const bench = await import("../scripts/learn-bench.mjs");

test("a wait ends at the earlier of the run's timeout and the bench's deadline", () => {
  const now = 1_000_000;
  assert.equal(bench.waitUntil({ runTimeoutMs: 900_000, deadline: now + 60_000 }, now), now + 60_000);
  assert.equal(bench.waitUntil({ runTimeoutMs: 30_000, deadline: now + 60_000 }, now), now + 30_000);
});

test("no grader run starts past the bench's deadline", async () => {
  const calls = [];
  const api = async (method, path) => (calls.push(`${method} ${path}`), { status: 500, body: null, headers: new Headers() });
  const verdict = await bench.gradeLlm({ api, options: { deadline: Date.now() - 1, runTimeoutMs: 1000 } }, "rubric");
  assert.deepEqual([verdict.pass, verdict.cost_usd, calls], [false, null, []]);
  assert.match(verdict.reason, /deadline/);
});

test("a known $0 stays $0; only a completed run that booked no request reads unknown", () => {
  const view = (usd, status = "completed") => ({ status, cost: { usd } });
  assert.deepEqual(bench.runCost(view(0), { usd: 0, requests: 2 }, { requests: 2 }), { total: 0, unpriced: false }, "priced at zero");
  assert.deepEqual(bench.runCost(view(0), null, null), { total: null, unpriced: true }, "no request booked");
  assert.deepEqual(bench.runCost(view(null), null, null), { total: null, unpriced: false }, "the server's own unknown");
  assert.deepEqual(bench.runCost(view(0.002), { usd: 0.002, requests: 1 }, { requests: 1 }), { total: 0.002, unpriced: false });
});

test("the active and pending items follow the notes' pages", async () => {
  const note = (i, status) => ({ file: `n${i}.md`, status, text: `note ${i}` });
  const api = async (method, path) => {
    if (path.endsWith("/learning")) return { status: 200, body: { notes: { items: [note(1, "active")], next_cursor: "c2" }, skills: [], workflows: [] }, headers: new Headers() };
    if (path.includes("/learning/notes?cursor=c2")) return { status: 200, body: { items: [note(2, "pending"), note(3, "active")], next_cursor: null }, headers: new Headers() };
    return { status: 404, body: null, headers: new Headers() };
  };
  const got = await bench.activeOf(api, "a");
  assert.deepEqual(Object.keys(got.notes).sort(), ["n1.md", "n3.md"]);
  assert.deepEqual(got.pending, ["n2.md"]);
});

test("a run with unmetered requests is left out of the tokens metrics, and counted apart", () => {
  const metered = (id, pass) => step(id, "repeat", [["a.md", pass]], { tokens: { input: 900, cache_read: 0, cache_write: 0, output: 100, requests: 2, unmetered: 0 } });
  const partial = step("03", "repeat", [["a.md", true]], { tokens: { input: 50, cache_read: 0, cache_write: 0, output: 10, requests: 3, unmetered: 2 } });
  const m = metricsOf([metered("01", true), metered("02", false), partial], true);
  assert.deepEqual([m.tokens_per_run, m.tokens_per_pass, m.tokens_known_steps, m.tokens_unmetered_steps], [1000, 2000, 2, 1], "the partial run's low count is in neither figure");
  const all = metricsOf([partial], true);
  assert.deepEqual([all.tokens_per_run, all.tokens_per_pass, all.tokens_known_steps, all.tokens_unmetered_steps], [null, null, 0, 1], "only unmetered runs: unknown, not low");
});

test("a job's filled pins are set on the server before its apply, as the template eval sets them", async () => {
  const { readPackage } = await import("../dist/templates.js");
  const pkg = readPackage(join(serve, "templates", "release-notes"));
  const puts = [];
  const api = async (method, path, body) => {
    if (method === "GET" && path === "/settings/tools") return { status: 200, body: {}, headers: new Headers() };
    if (method === "PUT" && path === "/settings/tools") return (puts.push(body), { status: 200, body, headers: new Headers() });
    return { status: 404, body: null, headers: new Headers() };
  };
  await bench.serverPins(api, pkg, { parameters: { repo: "example/shop" }, grants: [] });
  assert.equal(puts.length, 1, "one write of the server's tool settings");
  assert.ok(Object.values(puts[0]).some((setting) => setting.pin), JSON.stringify(puts[0]));
});

// The review's second round: a finished run whose learning has not settled is left alone and stops its series; every
// timeline page is read; a grader that fails keeps the step.
test("a finished run whose learning has not settled by the deadline is not cancelled, and says so", async () => {
  const posts = [];
  const api = async (method, path) => {
    if (method === "POST") return (posts.push(path), { status: 202, body: {}, headers: new Headers() });
    return { status: 200, body: { status: "completed", learning: { state: "proposed" } }, headers: new Headers() };
  };
  const got = await bench.settled(api, "run-1", true, Date.now() - 1);
  assert.deepEqual([got.timedOut, got.learningUnsettled, posts], [false, true, []], "the finished run stands; its learning is the open part");
});

test("a step's timeline is read page by page, through next_after while has_more", async () => {
  const pages = { 0: { rows: [{ id: "a", seq: 1 }], has_more: true, next_after: 1 }, 1: { rows: [{ id: "b", seq: 2 }, { id: "c", seq: 3, kind: "usage" }], has_more: false, next_after: 3 } };
  const api = async (_method, path) => ({ status: 200, body: pages[Number(/after=(\d+)/.exec(path)?.[1] ?? 0)], headers: new Headers() });
  assert.deepEqual((await bench.timelineRows(api, "run-1")).map((row) => row.id), ["a", "b", "c"]);
});

test("a grader whose run fails is recorded as not graded, and the step is kept", async () => {
  const api = async () => ({ status: 500, body: { error: "down" }, headers: new Headers() });
  const ctx = { api, options: { deadline: Date.now() + 60_000, runTimeoutMs: 1000 } };
  const got = await bench.gradeOne(ctx, { file: "finds.md", type: "llm", rubric: "r" }, { input: "x" }, { answer: "", calls: [], mcpCalls: [], files: [] }, [], true);
  assert.deepEqual([got.grader, got.pass, got.cost_usd], ["finds.md", false, null]);
  assert.match(got.reason, /^not graded: /);
});

test("a step whose learning had not settled stops its series, naming the step: no later step runs without its lesson", () => {
  assert.match(bench.unsettledStop({ id: "03", learning_unsettled: true }), /step 03.*not settled/);
  assert.equal(bench.unsettledStop({ id: "03", learning_unsettled: false }), null);
});

test("the owner's approve goes with the session cookie alone: the route refuses any request that carries a token", async () => {
  const { createServer } = await import("node:http");
  const seen = [];
  const server = createServer((req, res) => { seen.push(req.headers); res.end("{}"); });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  try {
    const api = bench.apiOf(`http://127.0.0.1:${server.address().port}`, "tok");
    await api("POST", "/approve", {}, bench.ownerHeaders({ cookie: "s=1", origin: "http://o" }, "etag-1"));
    await api("GET", "/plain");
  } finally { server.close(); }
  assert.deepEqual(seen.map((h) => [h.authorization ?? null, h.cookie ?? null, h["if-match"] ?? null]), [[null, "s=1", "etag-1"], ["Bearer tok", null, null]]);
});

test("an ungraded check is no wrong keep: a grader outage after the plant is counted apart, and the summary says how many", () => {
  const ungraded = (s) => ({ ...s, pass: false, graders: s.graders.map((g) => (g.grader.startsWith("plant-") ? { ...g, type: "llm", pass: false, ungraded: true, reason: "not graded: down", cost_usd: null } : g)) });
  const steps = [
    step("01", "teach", [["a.md", true]]),
    step("02", "plant", [["a.md", true]]),
    ungraded(step("03", "repeat", [["a.md", true], ["plant-not-kept.md", false]])),
    step("04", "repeat", [["a.md", true], ["plant-not-kept.md", true]]),
  ];
  const m = metricsOf(steps, true);
  assert.deepEqual([m.wrong_keeps, m.plant_graders, m.plant_ungraded, m.ungraded_checks], [0, 1, 1, 1], "03's outage is no keep; 04 graded");
  const text = render({ schema: SCHEMA, bench: { sha: "abc" }, hard_stop: null, series: [{ job: "j", harness: "pi", arm: "on", steps, metrics: m }] });
  assert.match(text, /\| 0 \(\+1 ungraded\) \|/, "the wrong keeps cell names the ungraded plant checks");
  assert.match(text, /03 repeat .*ungraded=plant-not-kept\.md/, "the step line names its ungraded check apart from its failed ones");
  assert.doesNotMatch(text, /03 repeat .*failed=[^ ]*plant-not-kept/);
});

test("a grader that could not grade says so: ungraded, from a run that did not finish, a grader run that failed, or the deadline", async () => {
  const kase = { input: "x" }; const record = { answer: "", calls: [], mcpCalls: [], files: [] };
  const llm = { file: "finds.md", type: "llm", rubric: "r" };
  const down = { api: async () => ({ status: 500, body: {}, headers: new Headers() }), options: { deadline: Date.now() + 60_000, runTimeoutMs: 1000 } };
  assert.equal((await bench.gradeOne(down, llm, kase, record, [], false)).ungraded, true, "the run did not finish");
  assert.equal((await bench.gradeOne(down, llm, kase, record, [], true)).ungraded, true, "the grader run failed");
  assert.equal((await bench.gradeLlm({ ...down, options: { deadline: Date.now() - 1, runTimeoutMs: 1000 } }, "x")).ungraded, true, "the deadline passed");
});

// C3: workflow reuse. The #2282 ask fires once a learned skill has served DRAFT_AFTER_RUNS earlier runs (learn/reflect.ts),
// so a skill taught at the teach step is first asked for as a workflow at the step DRAFT_AFTER_RUNS + 1 after it, and a
// workflow kept there is first callable at the step after that. A job that measures reuse (job.yaml `reuse: true`) runs at
// least REUSE_STEPS steps past that point, and each series where a workflow was kept says how its later steps used it.
const { DRAFT_AFTER_RUNS } = await import("../dist/learn/reflect.js");

test("a job that measures workflow reuse runs at least 3 steps after the earliest step a workflow can be kept; expense is one", () => {
  const reuse = jobs.map((name) => readJob(join(jobsDir, name))).filter((job) => job.reuse);
  assert.ok(reuse.some((job) => job.name === "expense"), "expense teaches a skill: it measures reuse");
  for (const job of reuse) {
    const teach = job.steps.findIndex((s) => s.kind === "teach");
    const keptAt = teach + 1 + DRAFT_AFTER_RUNS;
    assert.ok(job.steps.length - (keptAt + 1) >= bench.REUSE_STEPS, `${job.name}: ${job.steps.length} steps, a workflow kept at step ${job.steps[keptAt]?.id ?? keptAt + 1} at the earliest, ${job.steps.length - (keptAt + 1)} after it`);
  }
  assert.equal(bench.REUSE_STEPS, 3);
});

/** A series of ten: the skill taught at 01, a workflow kept at 05; 06, 07 and 09 call it (06 and 09 pass), 08 and 10 do not. */
const reuseSeries = () => {
  const io = (input, output) => ({ input, cache_read: 0, cache_write: 0, output, requests: 2, unmetered: 0 });
  const ids = ["01", "02", "03", "04", "05", "06", "07", "08", "09", "10"];
  return ids.map((id, i) => {
    const calls = ["06", "07", "09"].includes(id) ? 1 : 0;
    const pass = !["07", "10", "03"].includes(id);
    return step(id, i === 0 ? "teach" : "repeat", [["a.md", pass]], {
      learned_workflow_calls: calls,
      tokens: calls ? io(500, 100) : io(1500, 300),
      learned: { notes: [], skills: id === "01" ? ["weekly"] : [], workflows: id === "05" ? ["weekly"] : [] },
      workflow_proposed: id === "05",
    });
  });
};

test("reuse: for a series that kept a workflow, its later steps that called learned_workflow, how many passed, and tokens per passing step with the workflow against the skill-only steps", () => {
  const m = metricsOf(reuseSeries(), true);
  assert.deepEqual(m.reuse, {
    kept_step: "05", steps_after: 5, call_steps: 3, call_passes: 2,
    // Calling steps 06, 07, 09: 600 tokens each, 2 passes. Skill-only steps (the skill active, no workflow call): 02-05,
    // 08 and 10, 1,800 tokens each; 03 and 10 failed, so 4 passes.
    tokens_per_pass_workflow: Math.round((3 * 600) / 2), tokens_per_pass_skill_only: Math.round((6 * 1800) / 4), workflow_steps_known: 3, skill_only_steps_known: 6,
  });
  // No workflow kept, or learning off: no reuse to say.
  assert.equal(metricsOf(reuseSeries().map((x) => ({ ...x, learned: { notes: [], skills: x.learned.skills, workflows: [] } })), true).reuse, null);
  assert.equal(metricsOf(reuseSeries(), false).reuse, null);
  // A harness whose tokens are unknown: the counts stand, the token figures are unknown.
  const blind = metricsOf(reuseSeries().map((x) => ({ ...x, tokens: null })), true).reuse;
  assert.deepEqual([blind.call_steps, blind.call_passes, blind.tokens_per_pass_workflow, blind.tokens_per_pass_skill_only], [3, 2, null, null]);
});

test("the summary says each series' reuse: where the workflow was kept, how many later steps called it and passed, and the two token figures", () => {
  const steps = reuseSeries();
  const text = render({ schema: SCHEMA, bench: { sha: "abc" }, hard_stop: null, series: [{ job: "expense", harness: "pi", arm: "on", steps, metrics: metricsOf(steps, true) }] });
  assert.match(text, /expense \/ pi \/ on reuse: workflow kept at 05; 3 of the 5 steps after called it, 2 passed; tokens per passing step 900 with it, 2700 skill-only/);
});

test("the results schema holds the reuse block", () => {
  const schema = JSON.parse(readFileSync(join(jobsDir, "results.schema.json"), "utf8"));
  const reuse = schema.properties.series.items.properties.metrics.properties.reuse;
  assert.ok(reuse, "metrics.reuse");
  assert.deepEqual(Object.keys(reuse.anyOf?.[0]?.properties ?? reuse.properties ?? {}).sort(), ["call_passes", "call_steps", "kept_step", "skill_only_steps_known", "steps_after", "tokens_per_pass_skill_only", "tokens_per_pass_workflow", "workflow_steps_known"]);
});
