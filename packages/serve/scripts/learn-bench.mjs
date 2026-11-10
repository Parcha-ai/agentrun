#!/usr/bin/env node
// The learning bench (sprint LS-01): repeated jobs, learning off vs on, into one JSON results file
// (learn-bench/results.schema.json, learning-bench/2). On demand and nightly; never on a PR. It calls real models and spends.
//
// A job is a folder under learn-bench/ (learn-bench/README.md): job.yaml (template?, parameters, grants, fakes, deny,
// harnesses, steps [{id, kind: teach|repeat|change|plant}]), steps/<id>/prompt.md and graders/*.md, fixtures/, and, for a
// job with no template, its own agent.md. Each job becomes a template package in a scratch templates folder: the template's
// files (its own evals left out) or the job's agent.md, plus one eval case per step (evals/<id>/: prompt.md, graders/, a
// case.yaml made from the job's parameters, grants and fakes, the fixtures copied in). The template eval's readCases()
// checks every step whole before anything runs, and its graders run as the template eval runs them (gradeDeterministic;
// an llm grader is a run of the grader agent on graderInput, read with verdictOf): no grader of the bench's own.
//
// Per job, harness and arm, one series of the job's steps in order:
//   on   ONE agent applied from the package with learning on; each step its next run, its learning settled before the next
//        step; a pending item approved by the owner after each step (--no-approve leaves it pending), as an owner who
//        wants it learned would;
//   off  a fresh agent per step, learning off.
// Every agent: the series' harness, the runner place (no box, no shell), the job's `deny` tools set to deny, the model the
// bench names for the harness. What the runner adds to the graders' pass/fail: cost per run and its trend, the follow rate
// on repeat steps, the workflow proposal rate after teach steps and the reuse rate (learned_workflow calls), staleness
// after a change step (did the kept skill and workflow change; did a learned_workflow call pass the change graders), wrong
// keeps (plant-*.md graders failed after a plant step), and the learning grade's cost.
//
// The server is this process's own (startServe on a data directory of --data, accounts on, a runner beside it), as the
// template eval starts one. Models come from this process's environment (AGENT_MODEL_BASE_URL with AGENT_MODEL_API_KEY
// and AGENT_MODEL for pi and the default grader; ANTHROPIC_BASE_URL with ANTHROPIC_API_KEY for claude-agent): the bench
// wrapper hands them placeholder keys and a broker. Hard stop: each step's run capped by its prompt's max_cost_usd; the
// server's whole spend (GET /v2/stats) read before each step, the bench ending past --max-usd; --deadline-s for the whole.
//
//   node packages/serve/scripts/learn-bench.mjs --out DIR [--jobs DIR] [--job expense,...] [--harness pi,claude-agent]
//     [--arms on,off] [--steps N] [--data DIR] [--max-usd 10] [--deadline-s 5400] [--no-approve]
//     [--pi-model provider/id] [--claude-model provider/id] [--eval-grader-model provider/id] [--serve DIR] [--dry]
//     [--harness-max-runs claude-agent=120]   a harness's step runs bounded by count (one whose spend the server can't see)
//   node packages/serve/scripts/learn-bench.mjs --render results.json      the summary table (markdown)
import { createHash, randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { parseArgs } from "node:util";

// --serve DIR: the serve package whose dist/ and templates/ the bench runs on (default: this script's own), so a frozen copy
// of the script outside the repo runs the build it is pointed at.
const serveAt = process.argv.indexOf("--serve");
const serveDir = resolve(serveAt > 0 ? process.argv[serveAt + 1] : join(dirname(fileURLToPath(import.meta.url)), ".."));
const dist = (file) => pathToFileURL(join(serveDir, "dist", file)).href;
const TE = await import(dist("template-eval.js"));
const { applyBodyOf, compiled } = await import(dist("templates.js"));
// yaml as serve resolves it, so a frozen copy outside the repo reads job.yaml with serve's own parser.
const { parseDocument } = await import(pathToFileURL(createRequire(join(serveDir, "package.json")).resolve("yaml")).href);

export const SCHEMA = "learning-bench/2";
const KINDS = ["teach", "repeat", "change", "plant"];
const JOB_FIELDS = ["template", "parameters", "grants", "fakes", "deny", "harnesses", "steps"];
const DEFAULT_MODELS = { pi: null, "claude-agent": "anthropic/claude-haiku-5-5" };

// ---- jobs -------------------------------------------------------------------------------------------------------------

function yamlOf(text, what) {
  const doc = parseDocument(text, { schema: "core", merge: false, uniqueKeys: true, strict: true });
  if (doc.errors.length) throw new Error(`${what}: not YAML: ${doc.errors[0].message.split("\n")[0]}`);
  return doc.toJS({ maxAliasCount: 0 }) ?? {};
}

/** A job folder read: its job.yaml checked, its steps in order. Throws naming every problem. */
export function readJob(dir) {
  const name = dir.split("/").pop();
  const spec = yamlOf(readFileSync(join(dir, "job.yaml"), "utf8"), `${name}/job.yaml`);
  const bad = [];
  for (const key of Object.keys(spec)) if (!JOB_FIELDS.includes(key)) bad.push(`job.yaml: no field ${key}: its fields are ${JOB_FIELDS.join(", ")}`);
  if (spec.template !== undefined && typeof spec.template !== "string") bad.push("job.yaml: template is a folder under templates/");
  if (spec.template === undefined && !existsSync(join(dir, "agent.md"))) bad.push("a job with no template holds its own agent.md");
  if (spec.template !== undefined && !existsSync(join(serveDir, "templates", spec.template, "agent.md"))) bad.push(`job.yaml: template ${spec.template} is not a folder under templates/`);
  const steps = Array.isArray(spec.steps) ? spec.steps : (bad.push("job.yaml: steps is a list of {id, kind}"), []);
  for (const [i, step] of steps.entries()) {
    if (!step || typeof step.id !== "string" || !KINDS.includes(step.kind)) bad.push(`job.yaml: steps[${i}] is {id: "NN", kind: ${KINDS.join("|")}}`);
    else if (!existsSync(join(dir, "steps", step.id, "prompt.md"))) bad.push(`steps/${step.id}/prompt.md: missing`);
  }
  for (const key of ["deny", "grants", "harnesses"]) if (spec[key] !== undefined && !(Array.isArray(spec[key]) && spec[key].every((x) => typeof x === "string"))) bad.push(`job.yaml: ${key} is a list of names`);
  if (spec.fakes !== undefined && (typeof spec.fakes !== "object" || Array.isArray(spec.fakes))) bad.push("job.yaml: fakes is a mapping of an MCP server's name to its fixture file in the job");
  if (bad.length) throw new Error(`${name}: the job does not check:\n${bad.map((b) => `- ${b}`).join("\n")}`);
  return { name, dir, template: spec.template ?? null, parameters: spec.parameters ?? {}, grants: spec.grants ?? [], fakes: spec.fakes ?? {}, deny: spec.deny ?? [], harnesses: spec.harnesses ?? ["pi"], steps };
}

/** The job as a template package in `templates` (a scratch folder): the package's files and one eval case per step. Its
 *  name is the package's own (agent.md's), the folder the server applies it by. readCases() then checks it whole. */
export function packageOf(job, templates) {
  const source = job.template ? join(serveDir, "templates", job.template) : job.dir;
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(readFileSync(join(source, "agent.md"), "utf8"));
  const pkgName = front ? yamlOf(front[1], `${job.name}: agent.md front matter`).name : undefined;
  if (typeof pkgName !== "string") throw new Error(`${job.name}: its package's agent.md names no package (name:)`);
  const pkg = join(templates, pkgName);
  rmSync(pkg, { recursive: true, force: true });
  mkdirSync(pkg, { recursive: true });
  if (job.template) cpSync(source, pkg, { recursive: true, filter: (from) => !from.startsWith(join(source, "evals")) });
  else cpSync(join(job.dir, "agent.md"), join(pkg, "agent.md"));
  for (const step of job.steps) {
    const at = join(pkg, "evals", step.id);
    mkdirSync(at, { recursive: true });
    cpSync(join(job.dir, "steps", step.id, "prompt.md"), join(at, "prompt.md"));
    cpSync(join(job.dir, "steps", step.id, "graders"), join(at, "graders"), { recursive: true });
    if (existsSync(join(job.dir, "fixtures"))) cpSync(join(job.dir, "fixtures"), join(at, "fixtures"), { recursive: true });
    const lines = [`parameters: ${JSON.stringify(job.parameters)}`, `grants: ${JSON.stringify(job.grants)}`];
    if (Object.keys(job.fakes).length) lines.push(`mcp: ${JSON.stringify(job.fakes)}`);
    writeFileSync(join(at, "case.yaml"), `${lines.join("\n")}\n`);
  }
  return { pkgName, pkgDir: pkg, ...TE.readCases(pkg) };
}

// ---- the server and its API ---------------------------------------------------------------------------------------------

function apiOf(base, token) {
  return async (method, path, body, headers = {}) => {
    const raw = typeof body === "string";
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": raw ? "text/markdown" : "application/json" }), ...headers },
      ...(body === undefined ? {} : { body: raw ? body : JSON.stringify(body) }),
    });
    const text = await res.text();
    let json;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { status: res.status, body: json, headers: res.headers };
  };
}
const ok = (what, got, codes = [200, 201, 202, 204]) => {
  if (!codes.includes(got.status)) throw new Error(`${what}: ${got.status} ${JSON.stringify(got.body).slice(0, 400)}`);
  return got.body;
};
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const sha = (text) => createHash("sha256").update(text ?? "").digest("hex");
const usd = (x) => (typeof x === "number" ? x : null);
const q = (path) => encodeURIComponent(path);

/** This process's server on `data` (accounts on, its setup open: no public address) and a runner beside it, as the
 *  template eval starts one, with `templates` as its templates folder. */
async function startServer(data, templates) {
  const { startServe } = await import(dist("server.js"));
  const { runnerBeside } = await import(dist("runner/beside.js"));
  const token = randomBytes(24).toString("base64url");
  const serve = await startServe({ data, port: 0, token, templates, drainTimeout: "5s", accounts: true, openSetup: true });
  const beside = await runnerBeside(data, {});
  // A store handle of the bench's own on the same data (a runner's, as a test's): each step's kept learning row says what
  // its job had cost when it answered and what looking back cost (runner/reflect-hook.ts looked), which no route serves.
  const { openSqliteStore } = await import(dist("store/index.js"));
  const store = await openSqliteStore({ dataDir: data, role: "runner" });
  const base = serve.baseUrl.replace(/\/+$/, "").replace(/(\/v2)?$/, "/v2");
  return { api: apiOf(base, token), base, store, close: async () => { await store.close(); await beside.close(); await serve.close(); } };
}

/** Each harness of the plan installed before its first series: a claude-agent or codex that this data directory has not
 *  installed yet installs on first use (capabilities `installs: on_first_use`), and a run that starts while it installs
 *  fails, so its teaching step would be lost. An agent saved on it starts the install; the bench waits for it. */
async function installed(api, harnesses, log) {
  for (const harness of harnesses) {
    const offer = () => api("GET", "/capabilities").then((got) => (got.body?.harnesses ?? []).find((h) => h.id === harness));
    if (!(await offer())?.installs) continue;
    log(`installing ${harness} (first use) before its series`);
    ok(`saving an agent on ${harness}`, await api("POST", "/agents", { definition: { version: 1, name: `Bench install ${harness}`, description: "Saved by the learning bench to install its harness before the runs.", instructions: "Answer briefly.", harness, skills: [], tools: [], learning: false, place: { mode: "runner" } } }));
    const until = Date.now() + 10 * 60_000;
    for (;;) {
      const now = await offer();
      if (!now?.installs) break;
      if (Date.now() > until) throw new Error(`${harness} did not install within 10 minutes`);
      await sleep(3000);
    }
    log(`${harness} installed`);
  }
}

/** The owner's password session: setup with a password made here, held in memory alone. */
async function ownerOf(api, base) {
  const origin = base.replace(/\/v2$/, "");
  const password = randomBytes(18).toString("base64url");
  const set = await api("POST", "/setup", { password }, { origin });
  ok("setting the owner's password", set, [200, 201]);
  const cookie = (set.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
  if (!cookie) throw new Error("the owner's setup set no cookie");
  return { cookie, origin };
}

// ---- one series ------------------------------------------------------------------------------------------------------

/** The agent's active learned items now: each name with its text's sha256, and the files waiting for the owner's OK. */
async function activeOf(api, agentId) {
  const view = ok("reading the agent's learning", await api("GET", `/agents/${q(agentId)}/learning`)) ?? {};
  const text = async (file) => {
    const got = await api("GET", `/agents/${q(agentId)}/learning/files/${q(file)}`);
    return got.status === 200 ? (typeof got.body === "string" ? got.body : JSON.stringify(got.body)) : "";
  };
  const notes = {}, skills = {}, workflows = {};
  for (const n of view.notes?.items ?? []) if (n.status === "active") notes[n.file] = sha(n.text ?? "");
  for (const s of view.skills ?? []) if (s.status === "active") skills[s.name] = sha(await text(s.file));
  for (const w of view.workflows ?? []) if (w.status === "active") workflows[w.name] = sha(await text(w.file));
  const pending = [...(view.notes?.items ?? []).filter((n) => n.status === "pending").map((n) => n.file), ...(view.skills ?? []).filter((s) => s.status === "pending").map((s) => s.file), ...(view.workflows ?? []).filter((w) => w.status === "pending").map((w) => w.readme ?? w.file)];
  return { notes, skills, workflows, pending };
}

/** A fresh agent of the job's package for `harness`, learning on or off: applied, its triggers deleted, then its
 *  definition set to the harness, the runner place, the learning and the job's denied tools. */
async function agentFor(ctx, job, harness, learns) {
  const { api, pkgName, models } = ctx;
  const model = models[harness];
  const applied = ok(`applying ${pkgName}`, await api("POST", `/templates/${pkgName}/apply`, { parameters: job.parameters, grants: job.grants, ...(model ? { overrides: { model } } : {}) }));
  const agentId = String(applied.agent_id);
  for (const id of applied.trigger_ids ?? []) await api("DELETE", `/triggers/${q(String(id))}`);
  const agent = ok(`reading ${agentId}`, await api("GET", `/agents/${q(agentId)}`));
  const settings = { ...(agent.definition.tool_settings ?? {}) };
  for (const tool of job.deny) settings[tool] = { ...(settings[tool] ?? {}), permission: "deny" };
  const definition = { ...agent.definition, harness, learning: learns, place: { mode: "runner" }, ...(job.deny.length ? { tool_settings: settings } : {}), ...(model ? { model } : {}) };
  delete definition.version;
  // `place` and `computer` say one setting two ways: the runner place alone.
  delete definition.computer;
  ok(`setting ${agentId}'s definition`, await api("PUT", `/agents/${q(agentId)}/definition`, { definition }));
  return agentId;
}

/** Waits for run `runId` to end and, for a learning agent, for its learning to settle. */
async function settled(api, runId, learns, deadline) {
  for (;;) {
    const view = ok(`reading run ${runId}`, await api("GET", `/runs/${runId}`));
    const learning = view.learning;
    const ended = !["queued", "working"].includes(view.status);
    if (ended && view.status === "input_required") return { view, timedOut: false };
    if (ended && (!learns || !learning || ["merged", "dropped"].includes(learning.state))) return { view, timedOut: false };
    if (Date.now() > deadline) {
      await api("POST", `/runs/${runId}/cancel`, {});
      return { view, timedOut: true };
    }
    await sleep(3000);
  }
}

/** One step's run graded by its case's graders, as the template eval grades one. */
async function step(ctx, job, one, kase, agentId, harness, learns) {
  const { api, options } = ctx;
  const started = ok("starting the run", await api("POST", `/agents/${q(agentId)}/runs`, { input: { content: kase.input }, ...(kase.maxCostUsd !== undefined ? { max_cost_usd: kase.maxCostUsd } : {}) }));
  const runId = String(started.run_id);
  const { view, timedOut } = await settled(api, runId, learns, Date.now() + options.runTimeoutMs);
  const rows = (ok("reading the timeline", await api("GET", `/runs/${runId}/timeline`))?.rows) ?? [];
  const servers = Object.keys(kase.mcp);
  const record = { answer: typeof view.result?.final_answer === "string" ? view.result.final_answer : "", calls: TE.callsOf(rows, harness, servers), mcpCalls: ctx.fakes.flatMap((f) => f.calls.map((c) => ({ ...c }))), files: await filesOf(api, runId, kase) };
  for (const fake of ctx.fakes) fake.calls.length = 0;
  const graded = view.status === "completed";
  const graders = [];
  for (const grader of kase.graders) {
    if (grader.type !== "llm") { graders.push({ grader: grader.file, type: grader.type, cost_usd: null, ...TE.gradeDeterministic(grader, record, servers) }); continue; }
    if (!graded) { graders.push({ grader: grader.file, type: grader.type, pass: false, reason: "not graded: the run did not finish", cost_usd: null }); continue; }
    graders.push({ grader: grader.file, type: grader.type, ...(await gradeLlm(ctx, TE.graderInput(grader, kase.input, record))) });
  }
  const learning = learns ? (await api("GET", `/runs/${runId}/learning`)).body ?? {} : null;
  const approvals = [];
  if (learns && options.approve) {
    for (const file of (await activeOf(api, agentId)).pending) {
      const etag = (await api("GET", `/agents/${q(agentId)}/learning/files/${q(file)}`)).headers.get("etag");
      const answer = await api("POST", `/agents/${q(agentId)}/learning/files/${q(file)}/approve`, {}, { cookie: ctx.owner.cookie, origin: ctx.owner.origin, "if-match": etag });
      approvals.push({ file, status: answer.status });
    }
  }
  const verdictFiles = (learning?.verdict?.items ?? []).map((item) => item.file ?? "");
  // A run that answered cost something: $0 is a usage with no price (a harness whose requests the server could not price),
  // so it reads unknown, never $0 (cost_unpriced), as an unpriced grade does.
  const priced = usd(view.cost?.usd);
  const costUnpriced = priced === 0 && view.status === "completed";
  const total = costUnpriced ? null : priced;
  // The run's cost split: its job's own turns (what it had cost when the job answered) and its end-of-run learning turn
  // (what looking back cost), from its kept learning row. A run that did not learn, or did not look back, spent it all on
  // its job.
  const kept = learns ? ((await ctx.store.learning.proposal(runId))?.proposal ?? {}) : {};
  const looked = learns && kept.answered_at !== undefined;
  const work = costUnpriced ? null : looked ? usd(kept.job_cost_usd) : total;
  const reflect = looked ? usd(kept.look_back_usd) : total === null ? null : 0;
  // The grade's cost as its learning says it; 0 with tokens counted is a usage with no price (LS-09): unknown, never $0.
  const gradeTokens = learning?.tokens?.grade;
  const counted = gradeTokens && typeof gradeTokens === "object" && Object.values(gradeTokens).some((n) => typeof n === "number" && n > 0);
  // A learning that ended with no grade run (dropped before it was proposed: empty, unparsed, the checks) graded nothing: 0.
  const gradeRan = Boolean(learning?.verdict) || learning?.state === "merged" || learning?.reason === "grader";
  const gradeRaw = !learning ? null : learning.cost_usd?.grade !== undefined ? usd(learning.cost_usd.grade) : ["merged", "dropped"].includes(learning.state) && !gradeRan ? 0 : null;
  const unpriced = Boolean(learning && gradeRaw === 0 && counted);
  const learned = learning ? { notes: (learning.learned ?? []).map((x) => x.name), skills: (learning.skills ?? []).map((x) => x.name), workflows: (learning.workflows ?? []).map((x) => x.name) } : null;
  const toolRows = rows.filter((r) => r.kind === "tool_use" && r.agent_label !== "learning" && r.tool_name);
  return {
    id: one.id, kind: one.kind, agent_id: agentId, run_id: runId, status: timedOut ? "timed_out" : view.status,
    error: view.status === "completed" ? null : (view.error ? JSON.stringify(view.error).slice(0, 600) : timedOut ? "timed out" : null),
    pass: graded && graders.every((g) => g.pass), graders,
    // The answer the graders read, its head: what a failed grader is checked against when its reason is not enough.
    answer: record.answer.slice(0, 4000),
    cost_usd: total, cost_unpriced: costUnpriced, work_cost_usd: work,
    // The run's usage row as the timeline gives it (its requests, tokens and cost): why a cost reads unknown.
    usage: (() => { const u = rows.findLast((r) => r.kind === "usage")?.usage; return u ? JSON.parse(JSON.stringify(u)) : null; })(),
    cost_view: view.cost ?? null, reflect_cost_usd: learns ? reflect : 0, eval_grader_cost_usd: graders.some((g) => g.type === "llm") ? round(graders.reduce((s, g) => s + (g.cost_usd ?? 0), 0)) : null,
    learning: learning ? { state: learning.state ?? null, reason: learning.reason ?? null, detail: learning.detail ?? null } : null,
    grade_cost_usd: unpriced ? null : gradeRaw, grade_cost_unpriced: unpriced,
    learned, workflow_proposed: Boolean(learned && (learned.workflows.length || verdictFiles.some((f) => f.startsWith("workflows/")))),
    learned_workflow_calls: toolRows.filter((r) => r.tool_name === "learned_workflow").length,
    tools: [...new Set(toolRows.map((r) => r.tool_name))].sort(),
    approvals,
    active_after: learns ? (({ pending, ...items }) => items)(await activeOf(api, agentId)) : null,
  };
}

/** The run's files a file_exists grader may name: its listing, and each named path read one by one (the listing is
 *  capped), as the template eval reads them. */
async function filesOf(api, runId, kase) {
  const named = kase.graders.filter((g) => g.type === "file_exists").map((g) => g.path);
  if (!named.length) return [];
  const listed = ((await api("GET", `/runs/${runId}/files`)).body?.files ?? []).map((f) => f.path).filter((p) => typeof p === "string");
  for (const path of named) if (!listed.includes(path) && (await api("GET", `/runs/${runId}/files/${path.split("/").map(q).join("/")}`)).status === 200) listed.push(path);
  return listed;
}

/** An llm grader's verdict: one run of the grader agent on the grader's input, read as {pass, reason}. */
async function gradeLlm(ctx, input) {
  const { api, options } = ctx;
  if (!ctx.grader) {
    const made = ok("making the grader agent", await api("POST", "/agents", { definition: { version: 1, name: TE.GRADER_NAME, description: "Grades the learning bench's runs against a rubric: answers {pass, reason}.", instructions: TE.GRADER_INSTRUCTIONS, skills: [], tools: [], learning: false, place: { mode: "runner" }, max_cost_usd: TE.GRADER_CAP_USD, ...(options.evalGraderModel ? { model: options.evalGraderModel } : {}) } }));
    ctx.grader = String(made.agent_id);
  }
  const started = ok("starting a grader run", await api("POST", `/agents/${q(ctx.grader)}/runs`, { input: { content: input } }));
  const { view } = await settled(api, String(started.run_id), false, Date.now() + options.runTimeoutMs);
  const verdict = view.status === "completed" ? TE.verdictOf(view.result?.final_answer ?? "") : undefined;
  return { pass: verdict?.pass ?? false, reason: verdict?.reason ?? `the grader run ended ${view.status}`, cost_usd: usd(view.cost?.usd), run_id: String(started.run_id) };
}

const round = (x) => Math.round(x * 1e6) / 1e6;
const rate = (xs) => { const ys = xs.filter((x) => x !== null && x !== undefined); return ys.length ? round(ys.filter(Boolean).length / ys.length) : null; };
const mean = (xs) => { const ys = xs.filter((x) => typeof x === "number"); return ys.length ? round(ys.reduce((a, b) => a + b, 0) / ys.length) : null; };
function slope(points) {
  const pts = points.filter(([, y]) => typeof y === "number");
  if (pts.length < 2) return null;
  const mx = pts.reduce((s, [x]) => s + x, 0) / pts.length;
  const my = pts.reduce((s, [, y]) => s + y, 0) / pts.length;
  const den = pts.reduce((s, [x]) => s + (x - mx) ** 2, 0);
  return den === 0 ? null : round(pts.reduce((s, [x, y]) => s + (x - mx) * (y - my), 0) / den);
}

/** The series' metrics from its steps (results.schema.json `metrics`). */
export function metricsOf(steps, learns) {
  const at = (pred) => steps.filter(pred);
  const graderRates = {};
  for (const name of [...new Set(steps.flatMap((s) => s.graders.map((g) => g.grader)))].sort()) graderRates[name] = rate(steps.flatMap((s) => s.graders.filter((g) => g.grader === name).map((g) => g.pass)));
  const firstFlow = steps.findIndex((s) => s.learned?.workflows?.length);
  const staleness = [];
  if (learns) for (const [i, s] of steps.entries()) {
    if (s.kind !== "change") continue;
    const before = i > 0 ? steps[i - 1].active_after : null;
    const end = steps.at(-1).active_after;
    const after = steps.slice(i + 1);
    const changeGraders = after.flatMap((x) => x.graders.filter((g) => g.grader.startsWith("change-")));
    const updated = (kind) => (end && Object.keys(end[kind]).length ? Object.entries(end[kind]).some(([name, digest]) => !before || before[kind][name] !== digest) : null);
    const flowSteps = after.filter((x) => x.learned_workflow_calls > 0);
    staleness.push({
      change_step: s.id, pass_rate_after: rate(after.map((x) => x.pass)), change_graders_pass_rate: rate(changeGraders.map((g) => g.pass)),
      skill_updated: updated("skills"), workflow_updated: updated("workflows"),
      workflow_follows: flowSteps.length ? flowSteps.every((x) => x.graders.filter((g) => g.grader.startsWith("change-")).every((g) => g.pass)) : null,
    });
  }
  const plantAt = steps.findIndex((s) => s.kind === "plant");
  const plantGraders = plantAt < 0 ? [] : steps.slice(plantAt + 1).flatMap((x) => x.graders.filter((g) => g.grader.startsWith("plant-")));
  return {
    follow_rate: rate(at((s) => s.kind === "repeat").map((s) => s.pass)),
    pass_rate: rate(steps.map((s) => s.pass)),
    grader_pass_rates: graderRates,
    cost_per_run_usd: mean(steps.map((s) => s.cost_usd)),
    work_cost_per_run_usd: mean(steps.map((s) => s.work_cost_usd)),
    cost_trend_usd_per_run: slope(steps.map((s, i) => [i, s.work_cost_usd])),
    cost_first_usd: steps[0]?.work_cost_usd ?? null, cost_last_usd: steps.at(-1)?.work_cost_usd ?? null,
    reflect_cost_per_run_usd: learns ? mean(steps.map((s) => s.reflect_cost_usd)) : null,
    // What learning adds to each run: its end-of-run turn and its grade, where both are known.
    // A grade whose cost is unknown counts 0 here: then the overhead is a lower bound, and grade_cost_unknown_steps says so.
    learning_overhead_usd_per_run: learns ? mean(steps.map((s) => (s.reflect_cost_usd === null ? null : s.reflect_cost_usd + (s.grade_cost_usd ?? 0)))) : null,
    workflow_proposal_rate: learns ? rate(at((s) => s.kind === "teach").map((s) => s.workflow_proposed)) : null,
    reuse_rate: learns && firstFlow >= 0 ? rate(steps.slice(firstFlow + 1).map((s) => s.learned_workflow_calls > 0)) : null,
    staleness,
    wrong_keeps: learns && plantAt >= 0 ? plantGraders.filter((g) => !g.pass).length : null,
    plant_graders: learns && plantAt >= 0 ? plantGraders.length : null,
    grade_cost_usd: learns ? round(steps.reduce((s, x) => s + (x.grade_cost_usd ?? 0), 0)) : null,
    grade_cost_unknown_steps: learns ? steps.filter((x) => x.grade_cost_unpriced || (x.learning?.state === "merged" && x.grade_cost_usd === null)).length : null,
    eval_grader_cost_usd: steps.some((s) => s.eval_grader_cost_usd !== null) ? round(steps.reduce((s, x) => s + (x.eval_grader_cost_usd ?? 0), 0)) : null,
    approvals: steps.reduce((n, s) => n + (s.approvals?.length ?? 0), 0),
    cost_unknown_steps: steps.filter((s) => s.cost_unpriced).length,
  };
}

async function series(ctx, job, cases, harness, arm, steps) {
  const learns = arm === "on";
  const out = { job: job.name, template: job.template, harness, arm, agents: [], hard_stop: null, error: null, steps: [] };
  try {
    await seriesSteps(ctx, job, cases, harness, learns, steps, out);
  } catch (error) {
    // The series stops where the server refused it, said why; the steps it ran are kept, and the bench goes on.
    out.error = String(error?.message ?? error).slice(0, 600);
    ctx.options.log(`${job.name} ${harness} ${arm}: series stopped: ${out.error}`);
  }
  out.metrics = metricsOf(out.steps, learns);
  return out;
}

async function seriesSteps(ctx, job, cases, harness, learns, steps, out) {
  const { api, options } = ctx;
  const arm = learns ? "on" : "off";
  let agentId = learns ? await agentFor(ctx, job, harness, true) : null;
  if (agentId) out.agents.push(agentId);
  for (const one of steps) {
    const spent = (await api("GET", "/stats")).body?.analytics?.totals?.cost_usd ?? 0;
    if (spent > options.maxUsd) { out.hard_stop = `the server's spend ${spent} passed --max-usd ${options.maxUsd} before step ${one.id}`; break; }
    if (Date.now() > options.deadline) { out.hard_stop = `the bench's deadline passed before step ${one.id}`; break; }
    const cap = options.harnessMaxRuns[harness];
    if (cap !== undefined && (options.runsBy[harness] ?? 0) >= cap) { out.hard_stop = `${harness}'s run cap (${cap} step runs, --harness-max-runs) reached before step ${one.id}`; break; }
    options.runsBy[harness] = (options.runsBy[harness] ?? 0) + 1;
    if (!learns) { agentId = await agentFor(ctx, job, harness, false); out.agents.push(agentId); }
    const result = await step(ctx, job, one, cases.get(one.id), agentId, harness, learns);
    options.log(`${job.name} ${harness} ${arm} step ${one.id} (${one.kind}): ${result.status}, ${result.pass ? "pass" : "FAIL"}${result.cost_usd === null ? "" : ` $${result.cost_usd}`}`);
    out.steps.push(result);
  }
}

// ---- main ------------------------------------------------------------------------------------------------------------

async function main() {
  const { values } = parseArgs({ options: {
    out: { type: "string" }, jobs: { type: "string", default: join(serveDir, "learn-bench") }, job: { type: "string" }, harness: { type: "string" }, arms: { type: "string", default: "on,off" },
    steps: { type: "string" }, data: { type: "string" }, "max-usd": { type: "string", default: "10" }, "deadline-s": { type: "string", default: "5400" }, "no-approve": { type: "boolean", default: false },
    "pi-model": { type: "string" }, "claude-model": { type: "string" }, "eval-grader-model": { type: "string" }, dry: { type: "boolean", default: false }, "run-timeout-s": { type: "string", default: "900" },
    serve: { type: "string" }, render: { type: "string" }, "harness-max-runs": { type: "string" },
  } });
  if (values.render) {
    const files = values.render.split(",").map((file) => JSON.parse(readFileSync(file, "utf8")));
    return void process.stdout.write(render({ ...files[0], series: files.flatMap((f) => f.series), hard_stop: files.map((f) => f.hard_stop).find(Boolean) ?? null }));
  }
  const jobsDir = resolve(values.jobs);
  const names = values.job ? values.job.split(",") : readdirSync(jobsDir, { withFileTypes: true }).filter((e) => e.isDirectory() && existsSync(join(jobsDir, e.name, "job.yaml"))).map((e) => e.name).sort();
  const arms = values.arms.split(",");
  const limit = values.steps ? Number(values.steps) : undefined;
  const models = { pi: values["pi-model"] ?? DEFAULT_MODELS.pi, "claude-agent": values["claude-model"] ?? DEFAULT_MODELS["claude-agent"] };
  const scratch = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "learn-bench-"));
  const templates = join(scratch, "templates");
  const plan = [];
  try {
    for (const name of names) {
      const job = readJob(join(jobsDir, name));
      const pkg = packageOf(job, templates);
      const cases = new Map(pkg.cases.map((c) => [c.name, c]));
      const steps = job.steps.slice(0, limit);
      for (const harness of values.harness ? values.harness.split(",").filter((h) => job.harnesses.includes(h)) : job.harnesses) for (const arm of arms) plan.push({ job, pkg, cases, harness, arm, steps });
    }
    for (const p of plan) console.log(JSON.stringify({ job: p.job.name, template: p.job.template, harness: p.harness, arm: p.arm, model: models[p.harness] ?? "server default (AGENT_MODEL)", steps: p.steps.map((s) => `${s.id}:${s.kind}`), graders: Object.fromEntries(p.steps.map((s) => [s.id, p.cases.get(s.id).graders.map((g) => `${g.file}:${g.type}`)])), fakes: Object.keys(p.job.fakes), deny: p.job.deny }));
    if (values.dry) return;
    if (!values.out) throw new Error("--out DIR is where results.json goes");
    mkdirSync(values.out, { recursive: true });
    const data = values.data ?? join(scratch, "data");
    const started = new Date().toISOString();
    const server = await startServer(data, templates);
    const harnessMaxRuns = Object.fromEntries((values["harness-max-runs"] ?? "").split(",").filter(Boolean).map((pair) => { const [h, n] = pair.split("="); return [h, Number(n)]; }));
    const options = { harnessMaxRuns, runsBy: {}, maxUsd: Number(values["max-usd"]), deadline: Date.now() + Number(values["deadline-s"]) * 1000, approve: !values["no-approve"], evalGraderModel: values["eval-grader-model"], runTimeoutMs: Number(values["run-timeout-s"]) * 1000, log: (line) => console.error(line) };
    const results = { schema: SCHEMA, bench: { sha: process.env.BENCH_SHA ?? "unknown", frozen: process.env.BENCH_FROZEN ? JSON.parse(process.env.BENCH_FROZEN) : {}, models: { pi: models.pi ?? process.env.AGENT_MODEL ?? null, "claude-agent": models["claude-agent"], learning_grader: process.env.AGENTRUN_SERVE_GRADE_MODEL ?? null, eval_grader: options.evalGraderModel ?? null }, caps: { bench_max_usd: options.maxUsd, deadline_s: Number(values["deadline-s"]), harness_max_runs: harnessMaxRuns }, started_at: started, ended_at: null }, hard_stop: null, series: [] };
    const write = () => writeFileSync(join(values.out, "results.json"), `${JSON.stringify(results, null, 1)}\n`);
    try {
      const owner = await ownerOf(server.api, server.base);
      await installed(server.api, [...new Set(plan.map((p) => p.harness))], options.log);
      for (const p of plan) {
        const fakes = [];
        try {
          for (const [name, fixture] of Object.entries(p.cases.get(p.steps[0].id).mcp)) {
            const fake = await TE.startFake(name, fixture);
            fakes.push(fake);
            ok(`saving the fake ${name}`, await server.api("PUT", `/settings/mcp-servers/${name}`, { url: fake.url, auth: { type: "none" } }));
          }
          await serverPins(server.api, p.pkg.pkg, p.job);
          const done = await series({ api: server.api, store: server.store, pkgName: p.pkg.pkgName, models, options, owner, fakes }, p.job, p.cases, p.harness, p.arm, p.steps);
          results.series.push(done);
          write();
          if (done.hard_stop && !/--harness-max-runs/.test(done.hard_stop)) { results.hard_stop = done.hard_stop; break; }
        } finally {
          for (const fake of fakes) { await server.api("DELETE", `/settings/mcp-servers/${fake.name}`); await fake.close(); }
        }
      }
    } finally {
      results.bench.ended_at = new Date().toISOString();
      write();
      await server.close();
    }
    console.log(`${join(values.out, "results.json")}: ${results.series.length} series`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** The summary of a results file: one table row per series, then each series' steps, one line each. */
export function render(results) {
  const pct = (x) => (x === null || x === undefined ? "-" : `${Math.round(100 * x)}%`);
  const money = (x) => (x === null || x === undefined ? "-" : `$${x.toFixed(4)}`);
  const yes = (x) => (x === null || x === undefined ? "-" : x ? "yes" : "no");
  const out = [`Learning bench (${results.schema}), build ${String(results.bench?.sha ?? "?").slice(0, 10)}${results.hard_stop ? `, HARD STOP: ${results.hard_stop}` : ""}`, ""];
  out.push("| Job | Harness | Arm | Steps | Follow (repeat) | Pass (all) | Work cost/run | Work cost trend /run | Learning overhead/run | Grade cost | Workflow proposed (teach) | Reuse | After change: graders / skill updated / workflow updated | Wrong keeps |");
  out.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  const order = [...results.series].sort((a, b) => `${a.job}${a.harness}${a.arm}`.localeCompare(`${b.job}${b.harness}${b.arm}`));
  for (const s of order) {
    const m = s.metrics;
    const st = (m.staleness ?? []).map((x) => `${x.change_step}: ${pct(x.change_graders_pass_rate)} / ${yes(x.skill_updated)} / ${yes(x.workflow_updated)}`).join("; ") || "-";
    const trend = m.cost_trend_usd_per_run === null ? "-" : `${m.cost_trend_usd_per_run >= 0 ? "+" : ""}${m.cost_trend_usd_per_run.toFixed(5)}`;
    const grade = s.arm === "off" ? "-" : `${money(m.grade_cost_usd)}${m.grade_cost_unknown_steps ? ` (+${m.grade_cost_unknown_steps} unknown)` : ""}`;
    out.push(`| ${s.job} | ${s.harness} | ${s.arm} | ${s.steps.length} | ${pct(m.follow_rate)} | ${pct(m.pass_rate)} | ${m.cost_unknown_steps === s.steps.length ? "unknown" : money(m.work_cost_per_run_usd)} | ${trend} | ${m.grade_cost_unknown_steps ? "≥" : ""}${money(m.learning_overhead_usd_per_run)} | ${grade} | ${pct(m.workflow_proposal_rate)} | ${pct(m.reuse_rate)} | ${st} | ${m.wrong_keeps ?? "-"} |`);
  }
  for (const s of order) {
    out.push("", `${s.job} / ${s.harness} / ${s.arm}${s.error ? ` (SERIES STOPPED: ${s.error.slice(0, 200)})` : ""}: graders ${Object.entries(s.metrics.grader_pass_rates ?? {}).map(([g, r]) => `${g} ${pct(r)}`).join(", ")}`);
    for (const x of s.steps) {
      const failed = x.graders.filter((g) => !g.pass).map((g) => g.grader);
      const kept = x.learned ? Object.entries(x.learned).filter(([, v]) => v.length).map(([k, v]) => `${k.slice(0, -1)} ${v.join(", ")}`).join("; ") : "";
      out.push(`  ${x.id} ${x.kind.padEnd(6)} ${x.status.padEnd(10)} ${x.pass ? "pass" : "FAIL"} work=${money(x.work_cost_usd)}${x.learning ? ` reflect=${money(x.reflect_cost_usd)} learning=${x.learning.state ?? "-"} grade=${x.grade_cost_unpriced ? "unknown" : money(x.grade_cost_usd)}` : ""}${kept ? ` kept=${kept}` : ""}${x.learned_workflow_calls ? ` wf_calls=${x.learned_workflow_calls}` : ""}${failed.length ? ` failed=${failed.join(",")}` : ""}${x.error ? ` error=${x.error.slice(0, 160)}` : ""}`);
    }
  }
  return out.join("\n") + "\n";
}

/** The pins a job's apply fills set on this server first, as the template eval sets them (serverPins). */
async function serverPins(api, pkg, job) {
  const { parameters } = applyBodyOf(pkg, { parameters: job.parameters, grants: job.grants });
  const { unkept } = compiled(pkg, parameters, { mcp: pkg.mcp, defaultTools: [], grants: [], pins: false });
  if (!unkept.length) return;
  const settings = ok("reading the server's tool settings", await api("GET", "/settings/tools"));
  for (const { tool, pin } of unkept) settings[tool] = { ...(settings[tool] ?? {}), pin };
  ok("pinning the job's writes on the server", await api("PUT", "/settings/tools", settings));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`learn-bench: ${error.message}`);
    process.exit(1);
  });
}
