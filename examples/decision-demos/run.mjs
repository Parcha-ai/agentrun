#!/usr/bin/env node
// Starts agentrun-serve from this checkout's build on 127.0.0.1 with a fresh data directory and the demo documents,
// creates the five decision-demo agents, starts one use case and prints the console link to its run. The server keeps
// running (Ctrl-C stops it) so the run can be watched, paused and inspected in the console.
//
//   node examples/decision-demos/run.mjs <use-case|all> [--input NAME] [--live] [--follow] [--exit]
//                                        [--port N] [--data DIR] [--speed X] [--listen ADDR] [--allow-host NAME]
//   node examples/decision-demos/run.mjs --serve-only [--live] [--port N] [--data DIR] [--listen ADDR] ...
//
//   use-case  doc-valid | batch-20 | kyb | merchant-mcc | jury, or all (one run of each)
//   --serve-only  start the server and create the five agents, start no run (runs start from the console)
//   --input   which input of the use case (inputs/<NAME>.json); default its first (see use-cases.json)
//   --live    real providers: TYPESAFE_API_KEY (or OPENROUTER_API_KEY), PARALLEL_API_KEY, OPENROUTER_API_KEY and a model
//             for the llm report (AGENT_MODEL ...) from this environment; checked by name, never printed. Default: faux
//             providers from faux/, no key, no network
//   --follow  print node states and decisions as the run goes, then the outcome
//   --exit    with --follow: stop the server once the run(s) end
//   --port    the server's port (default any free port); --data  a data directory to use (default a fresh one)
//   --listen  the address serve listens on (default 127.0.0.1; on any other address serve takes every Host name)
//   --allow-host  on loopback, another Host it accepts, written NAME:PORT as the Host header carries it (repeatable)
//   --speed   faux latency multiplier (DEMO_FAUX_SPEED; default 1, 0 answers at once)
//   --report  with --follow: write DIR/<live|faux>-<input>.json per run (verdicts vs labels, latency, cost, models,
//             citations, agent loops), from the run's graph as the server reports it
//
// Build first: npm run build (the repo) and, for the console, cd apps/console && npm run build.
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const here = new URL(".", import.meta.url).pathname;
const root = resolve(here, "../..");
const cases = JSON.parse(readFileSync(join(here, "use-cases.json"), "utf8"));
const TITLES = {
  "doc-valid": "Is this certificate valid?",
  "batch-20": "Review 20 documents",
  kyb: "KYB: registry + documents",
  "merchant-mcc": "Merchant category and risk",
  jury: "Jury of decision models",
};

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    input: { type: "string" }, live: { type: "boolean", default: false }, follow: { type: "boolean", default: false }, exit: { type: "boolean", default: false },
    port: { type: "string", default: "0" }, data: { type: "string" }, report: { type: "string" }, listen: { type: "string", default: "127.0.0.1" }, "allow-host": { type: "string", multiple: true, default: [] },
    "serve-only": { type: "boolean", default: false }, speed: { type: "string" }, help: { type: "boolean", short: "h", default: false },
  },
});
const useCase = positionals[0];
if (opts.help || (!opts["serve-only"] && !cases[useCase] && useCase !== "all")) {
  console.log(readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(1).join("\n").split("\nimport")[0].split("\n").map((l) => l.slice(3)).join("\n"));
  process.exit(useCase ? 2 : 0);
}
const cli = join(root, "packages/serve/dist/cli.js");
if (!existsSync(cli)) {
  console.error(`no serve build at ${cli}: run npm run build first`);
  process.exit(1);
}

// ---- the server's environment
const token = `demo_${randomBytes(24).toString("base64url")}`;
const data = opts.data ? resolve(opts.data) : mkdtempSync(join(tmpdir(), "dwf-usecases-"));
const env = { ...process.env, AGENTRUN_TOKEN: token, AGENTRUN_ACCOUNTS: "0", AGENTRUN_LOG: "quiet" };
// The fakes reach a run only through startServe's options (the server takes no test hook from its environment), so a
// faux server runs in-process, through serve's smoke launcher; a live one is the CLI.
const FAUX = { fauxJev: "jev.mjs", fauxParallel: "parallel.mjs", fauxOpenrouter: "openrouter.mjs", fauxWeb: "web.mjs" };
const launcher = join(root, "packages/serve/scripts/dwf-smoke/serve-faux.mjs");
const KEYS = ["TYPESAFE_API_KEY", "PARALLEL_API_KEY", "OPENROUTER_API_KEY"];
const args = [cli, "--data", data, "--listen", opts.listen, ...opts["allow-host"].flatMap((name) => ["--allow-host", name]), "--port", opts.port, "--documents", join(here, "documents"), "--allow-code-nodes", "--drain-timeout", "5s"];
if (opts.live) {
  const set = (name) => typeof env[name] === "string" && env[name].trim() !== "";
  const missing = [];
  if (!set("TYPESAFE_API_KEY") && !set("OPENROUTER_API_KEY")) missing.push("TYPESAFE_API_KEY (or OPENROUTER_API_KEY) for Jev");
  if (!set("PARALLEL_API_KEY")) missing.push("PARALLEL_API_KEY for kyb and merchant-mcc");
  if (!set("OPENROUTER_API_KEY")) missing.push("OPENROUTER_API_KEY for the jury");
  if (missing.length) console.log(`live: not set here (the use cases that need them will be refused): ${missing.join("; ")}`);
} else {
  // Placeholders, so the providers bind; the faux fetches never send them anywhere. A real key in this shell is not used.
  for (const name of KEYS) env[name] = "faux-not-a-key";
  env.DEMO_FAUX_LOG = join(data, "faux-calls.jsonl");
  if (opts.speed !== undefined) env.DEMO_FAUX_SPEED = opts.speed;
}
const options = {
  data, host: opts.listen, port: Number(opts.port), allowHosts: opts["allow-host"], token, documents: join(here, "documents"), allowCodeNodes: true, drainTimeout: "5s",
  faux: join(here, "faux", "model.mjs"), ...Object.fromEntries(Object.entries(FAUX).map(([option, file]) => [option, join(here, "faux", file)])),
};
const child = spawn(process.execPath, opts.live ? args : [launcher, JSON.stringify(options)], { env, stdio: ["ignore", "pipe", "pipe"] });
let stderr = "";
child.stderr.on("data", (chunk) => (stderr += chunk));
const base = await new Promise((resolveBase, reject) => {
  let text = "";
  child.stdout.on("data", (chunk) => {
    text += chunk;
    const found = /AGENTRUN_BASE_URL=(\S+)/.exec(text)?.[1];
    if (found) resolveBase(found);
  });
  child.once("exit", (code) => reject(new Error(`serve exited ${code}: ${stderr.trim()}`)));
});
const origin = new URL(base).origin;
const stop = () => child.exitCode === null && child.kill("SIGTERM");
process.on("exit", stop);
process.on("SIGINT", () => { stop(); process.exit(130); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(method, path, body) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    } catch (error) {
      // A dropped connection on a loaded box is asked again; a server that has exited is not.
      if (child.exitCode !== null) throw new Error(`serve exited ${child.exitCode}: ${stderr.trim().slice(-2000)}`);
      if (attempt >= 20 || (method !== "GET" && path.endsWith("/runs"))) throw error;
      await sleep(1000);
      continue;
    }
    const answer = { status: res.status, body: await res.json().catch(() => null) };
    if (attempt >= 20 || !answer.body?.error?.retryable) return answer;
    await sleep(answer.body.error.retry_after_ms ?? 500);
  }
}

console.log(`serve ${opts.live ? "LIVE" : "faux"} on ${origin} (data ${data})`);
console.log(`console: ${origin}/?token=${encodeURIComponent(token)}`);

/** The tools a workflow's call nodes name: a revision lists each tool its workflow may call. */
function callTools(node, found = new Set()) {
  if (Array.isArray(node)) node.forEach((n) => callTools(n, found));
  else if (node && typeof node === "object") {
    if (node.node === "call" && node.via === "tool" && typeof node.tool === "string") found.add(node.tool);
    Object.values(node).forEach((v) => callTools(v, found));
  }
  return [...found];
}

// ---- the five agents
for (const [id, { workflow: name }] of Object.entries(cases)) {
  const workflow = JSON.parse(readFileSync(join(here, "workflows", `${name}.json`), "utf8"));
  const tools = callTools(workflow.root);
  const definition = { name: TITLES[id] ?? id, workflow, ...(tools.length ? { tools } : {}) };
  let made = await api("POST", "/agents", { definition: { id, ...definition } });
  if (made.status === 409) made = await api("PUT", `/agents/${id}/definition`, { definition });
  const warnings = (made.body?.warnings ?? []).map((w) => w.message ?? JSON.stringify(w));
  if (made.status >= 300) console.log(`agent ${id}: ${made.status} ${JSON.stringify(made.body?.error ?? made.body)}`);
  else console.log(`agent ${id}: ${made.status === 201 ? "created" : "updated"}${warnings.length ? ` (warnings: ${warnings.join(" | ")})` : ""}`);
}

// ---- the run(s)
const started = [];
for (const id of opts["serve-only"] ? [] : useCase === "all" ? Object.keys(cases) : [useCase]) {
  const inputName = useCase === "all" || !opts.input ? cases[id].inputs[0] : opts.input;
  const file = join(here, "inputs", `${inputName}.json`);
  if (!existsSync(file)) { console.log(`no input ${inputName} (have: ${cases[id].inputs.join(", ")})`); continue; }
  const postedAt = Date.now();
  const run = await api("POST", `/agents/${id}/runs`, { input: JSON.parse(readFileSync(file, "utf8")) });
  if (run.status !== 202) { console.log(`run ${id} (${inputName}): ${run.status} ${JSON.stringify(run.body?.error ?? run.body)}`); continue; }
  const runId = run.body.run_id ?? run.body.id;
  started.push({ id, runId, inputName, postedAt });
  console.log(`run ${id} (${inputName}): ${runId}\n  ${origin}/?token=${encodeURIComponent(token)}#/runs/${encodeURIComponent(runId)}`);
}

// ---- the report of one run
const labels = JSON.parse(readFileSync(join(here, "documents", "labels.json"), "utf8"));
/** The outcome each input should reach where one is known: labels.json for documents and packets, the case's design
 *  otherwise. jury-split has none: whether a social casino's sweeps coins are gambling is what the jurors disagree on. */
const EXPECTED = {
  "merchant-mcc": "approve", "merchant-mcc-restricted": "review", "merchant-mcc-prohibited": "decline", "merchant-mcc-live": "approve",
  jury: "not_gambling",
};
const gitOf = (...args) => { try { return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).replace(/\n$/, ""); } catch { return null; } };
const msBetween = (a, b) => (a && b ? Date.parse(b) - Date.parse(a) : null);
const sumOrNull = (values) => (values.length && values.every((v) => typeof v === "number") ? Number(values.reduce((a, b) => a + b, 0).toFixed(8)) : values.length ? null : 0);
const median = (values) => { const v = values.filter((x) => typeof x === "number").sort((a, b) => a - b); return v.length ? v[Math.floor((v.length - 1) / 2)] : null; };

/** A document verdict against its label: an invalid document passed as valid is the error that matters. */
function scoreDocuments(reviews) {
  const rows = reviews.filter(Boolean).map((r) => {
    const label = labels.documents.find((d) => d.file === r.document);
    const expected = label ? (label.valid ? "valid" : "invalid") : null;
    const outcome = r.verdict === expected ? "correct" : r.verdict === "review" ? "review" : r.verdict === "unreadable" ? "unreadable" : expected === "invalid" && r.verdict === "valid" ? "false_accept" : "false_reject";
    return { document: r.document, expected, defects: label?.defects.map((d) => d.kind) ?? null, verdict: r.verdict, decided_by: r.decided_by ?? null, outcome, reasons: r.reasons ?? [] };
  });
  const count = (o) => rows.filter((r) => r.outcome === o).length;
  return { documents: rows.length, correct: count("correct"), review: count("review"), false_accept: count("false_accept"), false_reject: count("false_reject"), unreadable: count("unreadable"),
    accuracy_of_decided: rows.length - count("review") - count("unreadable") ? Number((count("correct") / (rows.length - count("review") - count("unreadable"))).toFixed(3)) : null, rows };
}

function scoreOf(useCaseId, inputName, input, outcome, output) {
  if (useCaseId === "batch-20") return scoreDocuments(output?.reviews ?? []);
  if (useCaseId === "doc-valid") {
    const verdict = output?.verdict ?? outcome;
    return scoreDocuments([{ document: input.documents[0], verdict: verdict === "doubtful" ? "review" : verdict, decided_by: output?.decided_by, reasons: output?.reasons }]);
  }
  if (useCaseId === "kyb") {
    const packet = Object.values(labels.packets).find((p) => JSON.stringify(p.documents) === JSON.stringify(input.documents));
    return { expected: packet?.expected ?? null, got: outcome, correct: packet ? packet.expected === outcome : null };
  }
  const expected = EXPECTED[inputName] ?? null;
  return { expected, got: outcome, correct: expected === null ? null : expected === outcome };
}

function writeReport({ id, runId, inputName, postedAt }, graphView, view) {
  const { run, graph, nodes, decisions = [], effects = [], totals } = graphView;
  const input = JSON.parse(readFileSync(join(here, "inputs", `${inputName}.json`), "utf8"));
  const labelOf = (path) => graph.nodes.find((n) => n.path === path)?.label ?? path;
  const output = view.result?.output ?? null;
  const outcome = view.review || run.status === "escalated" ? "review" : output?.decision ?? output?.verdict ?? run.status;
  const llm = effects.filter((e) => e.tool === "llm");
  const perNode = graph.nodes.filter((n) => nodes[n.path] && nodes[n.path].status !== "pending" && nodes[n.path].status !== "not_run").map((n) => {
    const mine = decisions.filter((d) => d.node === n.path);
    const calls = effects.filter((e) => e.node === n.path);
    const row = { path: n.path, label: n.label, kind: n.kind, status: nodes[n.path].status, wall_ms: msBetween(nodes[n.path].startedAt, nodes[n.path].endedAt), ...(nodes[n.path].branch ? { branch: nodes[n.path].branch } : {}) };
    if (mine.length) Object.assign(row, { provider: [...new Set(mine.map((d) => d.provider))].join(","), models: [...new Set(mine.map((d) => d.model))], calls: mine.length,
      latency_ms: { median: median(mine.map((d) => d.latency_ms)), max: Math.max(...mine.map((d) => d.latency_ms ?? 0)), sum: mine.reduce((a, d) => a + (d.latency_ms ?? 0), 0) }, cost_usd: sumOrNull(mine.map((d) => d.cost_usd)) });
    if (calls.length) {
      const took = calls.map((e) => msBetween(e.startedAt, e.endedAt));
      Object.assign(row, { tool: calls[0].tool, calls: calls.length, latency_ms: { median: median(took), max: Math.max(...took.map((t) => t ?? 0)), sum: took.reduce((a, t) => a + (t ?? 0), 0) } });
      if (calls[0].tool === "llm") Object.assign(row, { models: [...new Set(calls.map((e) => e.output?.model ?? null))], cost_usd: sumOrNull(calls.map((e) => e.output?.cost_usd ?? null)), usage: calls.map((e) => e.output?.usage ?? null) });
    }
    return row;
  });
  const report = {
    use_case: id, input: inputName, mode: opts.live ? "live" : "faux", run_id: runId, agent: run.agent, revision: run.revision, status: run.status,
    outcome, score: scoreOf(id, inputName, input, outcome, output),
    started_at: run.startedAt, ended_at: run.endedAt, wall_ms: Date.now() - postedAt, server_elapsed_ms: totals.elapsed_ms,
    cost_usd: totals.cost_usd, cost_note: totals.cost_usd === null ? "null: at least one call reported no cost" : "sum of every decision's and llm call's reported cost",
    decisions: totals.decisions, tool_calls: totals.effects, llm_calls: llm.length,
    agent_loops: graph.nodes.filter((n) => (n.kind === "model" || (n.kind === "call" && n.via && n.via !== "tool")) && nodes[n.path] && !["pending", "not_run"].includes(nodes[n.path].status)).length,
    models: [...new Set([...decisions.map((d) => `${d.provider}/${d.model}`), ...llm.map((e) => `llm/${e.output?.model ?? null}`)])],
    nodes: perNode,
    decision_calls: decisions.map((d) => ({ node: labelOf(d.node), kind: d.kind, item: d.item, provider: d.provider, model: d.model, status: d.status, latency_ms: d.latency_ms, cost_usd: d.cost_usd, cost_basis: d.cost_basis,
      answers: d.answers, action: d.action, images: (d.images ?? []).map((i) => i.ref), citations: (d.evidence ?? []).map((e) => ({ url: e.url ?? null, title: e.title ?? null, excerpt: (e.excerpts?.[0] ?? e.excerpt ?? e.text ?? null)?.slice?.(0, 300) ?? null })) })),
    tool_calls_detail: effects.map((e) => ({ node: labelOf(e.node), tool: e.tool, item: e.item, status: e.status, ms: msBetween(e.startedAt, e.endedAt), error: e.error ?? null })),
    output, review: view.review ?? null, error: view.error ?? null,
    serve: { data_dir: data, origin, git_head: gitOf("rev-parse", "HEAD"), git_dirty: gitOf("status", "--porcelain", "--untracked-files=no")?.split("\n").filter(Boolean) ?? null },
  };
  mkdirSync(resolve(opts.report), { recursive: true });
  const file = join(resolve(opts.report), `${report.mode}-${inputName}.json`);
  writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`[${id}] report: ${file}`);
}

// ---- follow
const ENDED = (status) => !["queued", "working", "paused", "input_required"].includes(status);
async function follow({ id, runId, inputName, postedAt }) {
  const seen = new Set();
  let last = "";
  for (;;) {
    const g = await api("GET", `/runs/${runId}/graph`);
    if (g.status !== 200) { console.log(`[${id}] graph: ${g.status} ${JSON.stringify(g.body?.error ?? g.body)}`); return; }
    const { run, graph, nodes, decisions = [], totals } = g.body;
    for (const d of decisions) {
      const key = d.id ?? `${d.node}|${d.executionPath}`;
      if (seen.has(key) || !d.answers) continue;
      seen.add(key);
      const label = graph.nodes.find((n) => n.path === d.node)?.label ?? d.node;
      const answers = Object.entries(d.answers).map(([q, a]) => `${q}=${a.type === "noul" ? a.noul : a.type === "choice" ? `${a.choice}(${a.confidence ?? "?"})` : a.type}`).join(" ");
      console.log(`[${id}] ${label}${d.item !== undefined && d.item !== null ? `[${d.item.index ?? d.item}]` : ""} ${d.provider}/${d.model ?? "?"} ${d.latency_ms ?? "?"} ms $${d.cost_usd ?? "?"}: ${answers}${d.evidence?.length ? ` (+${d.evidence.length} citations)` : ""}`);
    }
    const line = `${run.status}${run.paused ? " (paused)" : ""} | ${Object.entries(nodes).filter(([, n]) => n.status !== "pending" && n.status !== "not_run").map(([path, n]) => `${graph.nodes.find((x) => x.path === path)?.label ?? path}=${n.status}${n.branch ? `->${n.branch}` : ""}`).join(" ")}`;
    if (line !== last) { console.log(`[${id}] ${line}`); last = line; }
    if (ENDED(run.status)) {
      const view = (await api("GET", `/runs/${runId}`)).body ?? {};
      if (opts.report) writeReport({ id, runId, inputName, postedAt }, g.body, view);
      console.log(`[${id}] ended ${run.status}: ${totals.decisions} decisions, ${totals.effects} tool calls, ${(totals.elapsed_ms / 1000).toFixed(1)} s, cost ${totals.cost_usd === null ? "unknown (a provider gave none)" : `$${totals.cost_usd}`}`);
      if (view.review) console.log(`[${id}] review: ${JSON.stringify(view.review)}`);
      if (view.result?.output) console.log(`[${id}] output: ${JSON.stringify(view.result.output).slice(0, 1500)}`);
      if (view.error) console.log(`[${id}] error: ${JSON.stringify(view.error)}`);
      return;
    }
    await sleep(1000);
  }
}
if (opts.follow) await Promise.all(started.map(follow));
if (opts.follow && opts.exit) { stop(); process.exit(0); }
console.log("serving; Ctrl-C stops the server");
child.stdout.pipe(process.stdout);
await new Promise((r) => child.once("exit", r));
