#!/usr/bin/env node
// The decision-workflow serve smoke: serve under faux with faux Jev, Parallel and OpenRouter (dwf-smoke/), a
// documents directory of three small PDFs, and a workflow agent that runs map(pdf_pages -> Jev judge) over them, then a
// code tally, a Parallel judge, an OpenRouter judge (liquid/d1), one `llm` call and a judged route. It polls
// GET /v2/runs/{id}/graph while the run goes, pauses the run once its first decision is in, checks nothing new starts
// while paused, restarts the server with the run paused, checks it is still paused, resumes it and follows it to its end.
//
//   node packages/serve/scripts/dwf-smoke.mjs [--images] [--out FILE]
//
// --images: the judge sees each page image (C1; needs the engine's `images` field). No key, no network: every model
// and decision provider is a local fake. The server binds 127.0.0.1 on a free port.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const { values: opts } = parseArgs({ options: { images: { type: "boolean", default: false }, out: { type: "string" }, keep: { type: "boolean", default: false } } });
const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "dwf-smoke");
const root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "dwf-smoke-"));
const docs = join(root, "documents");
const data = join(root, "data");
mkdirSync(docs);
const out = [];
const say = (line) => {
  const text = `${new Date().toISOString().slice(11, 23)} ${line}`;
  out.push(text);
  console.log(text);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Three small PDFs, two pages each, drawn with Ghostscript.
const companies = [["coi-acme", "Acme Widgets, Inc.", "Delaware"], ["coi-birch", "Birch Analytics LLC", "Wyoming"], ["coi-cobalt", "Cobalt Freight Co.", "Nevada"]];
for (const [stem, name, state] of companies) {
  const ps = join(root, `${stem}.ps`);
  writeFileSync(ps, `%!PS\n/Helvetica-Bold findfont 22 scalefont setfont\n72 700 moveto (CERTIFICATE OF INCORPORATION) show\n/Helvetica findfont 16 scalefont setfont\n72 660 moveto (${name}) show\n72 636 moveto (State of ${state}, filed 2024-03-14) show\nshowpage\n/Helvetica findfont 14 scalefont setfont\n72 700 moveto (Registered agent: Example Agents Corp.) show\nshowpage\n`);
  execFileSync("gs", ["-q", "-dSAFER", "-dBATCH", "-dNOPAUSE", "-sDEVICE=pdfwrite", `-sOutputFile=${join(docs, `${stem}.pdf`)}`, ps]);
}
say(`documents: ${companies.map(([stem]) => `${stem}.pdf`).join(", ")} in ${docs}`);

const token = `smoke_${randomBytes(24).toString("base64url")}`;
const calls = join(root, "decision-calls.jsonl");
const fake = join(fixtures, "faux-decisions.mjs");
const launcher = join(fixtures, "serve-faux.mjs");
/** The server, started on a free loopback port; resolves with its base URL once its banner is out. */
function startServer() {
  const options = { data, host: "127.0.0.1", port: 0, token, faux: join(fixtures, "faux-model.mjs"), fauxJev: fake, fauxParallel: fake, fauxOpenrouter: fake, documents: docs, allowCodeNodes: true, drainTimeout: "2s" };
  const child = spawn(process.execPath, [launcher, JSON.stringify(options)], {
    env: {
      ...process.env, AGENTRUN_LOG: "quiet",
      // The fakes' keys: placeholders the fakes never check, so the providers bind under faux.
      TYPESAFE_API_KEY: "faux-smoke-placeholder", PARALLEL_API_KEY: "faux-smoke-placeholder", OPENROUTER_API_KEY: "faux-smoke-placeholder",
      AGENTRUN_SMOKE_DECISION_CALLS: calls, AGENTRUN_SMOKE_DECISION_MS: "1500",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let err = "";
  child.stderr.on("data", (chunk) => (err += chunk));
  return new Promise((resolve, reject) => {
    let text = "";
    child.stdout.on("data", (chunk) => {
      text += chunk;
      const base = /AGENTRUN_BASE_URL=(\S+)/.exec(text)?.[1];
      if (base) resolve({ child, base });
    });
    child.once("exit", (code) => reject(new Error(`serve exited ${code}: ${err}`)));
  });
}
const stopServer = (child) => new Promise((resolve) => (child.once("exit", resolve), child.kill("SIGTERM")));

let server = await startServer();
// A failed smoke leaves no server behind.
process.on("exit", () => server.child.exitCode === null && server.child.kill("SIGTERM"));
/** One request; a retryable refusal (a busy store, a run's door coming up) is asked again, as a client should. */
const api = async (method, path, body) => {
  for (let attempt = 0; ; attempt++) {
    const answer = await request(method, path, body);
    if (attempt >= 20 || !answer.body?.error?.retryable) return answer;
    await sleep(answer.body.error.retry_after_ms ?? 500);
  }
};
const request = async (method, path, body) => {
  const res = await fetch(`${server.base}${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const type = res.headers.get("content-type") ?? "";
  return { status: res.status, type, body: type.includes("json") ? await res.json() : Buffer.from(await res.arrayBuffer()) };
};
say(`serve on ${server.base} (data ${data})`);

const judgeState = opts.images ? { doc: "{item}", text: "{pages.text}", page: "page_1" } : { doc: "{item}", text: "{pages.text}" };
const workflow = {
  v: 2, name: "coi-batch",
  schemas: {
    In: { type: "object", required: ["documents"], properties: { documents: { type: "array", items: { type: "string" } } } },
    Pages: { type: "object", required: ["name", "pageCount", "pages", "text"], properties: { name: { type: "string" }, pageCount: { type: "integer" }, pages: { type: "array" }, text: { type: "string" } } },
    Verdict: {
      type: "object", additionalProperties: false, required: ["valid", "entity_legible"],
      properties: {
        valid: { type: "boolean", description: "Does `text` read as an unaltered certificate of incorporation?" },
        entity_legible: { type: "boolean", description: "Is the company's name legible in `doc`'s text?" },
      },
    },
    Llm: { type: "object", required: ["text", "model"], properties: { text: { type: "string" }, model: { type: "string" } } },
    Registered: { type: "object", additionalProperties: false, required: ["registered"], properties: { registered: { type: "boolean", description: "Are the companies in `companies` registered and active?" } } },
    Second: { type: "object", additionalProperties: false, required: ["agree"], properties: { agree: { type: "boolean", description: "Does `tally` show every certificate valid?" } } },
    Out: { type: "object", required: ["decision", "summary"], properties: { decision: { type: "string" }, summary: { type: "string" } } },
  },
  input: { schemaId: "In" },
  output: { schemaId: "Out", path: "result" },
  root: {
    node: "chain",
    steps: [
      {
        node: "map", label: "each document", itemsPath: "documents", as: "verdicts", resultPath: "verdict", maxConcurrency: 1, onItemFailure: "collect", failedAs: "failed",
        body: {
          node: "chain",
          steps: [
            { node: "call", label: "pages", via: "tool", tool: "pdf_pages", args: { path: "{item}", maxPages: 2, dpi: 72 }, out: "Pages", as: "pages", deadline_s: 60 },
            { node: "judge", label: "check document", state: judgeState, out: "Verdict", as: "verdict", ...(opts.images ? { images: { page_1: "{pages.pages.0.image}" } } : {}) },
          ],
        },
      },
      { node: "code", label: "tally", code: "(s) => ({ tally: { valid: s.verdicts.filter((v) => v && v.valid).length, total: s.verdicts.length, prompt: ['Write a one-line report on these certificates:', ...s.documents.map((d, i) => '- ' + d + ': ' + (s.verdicts[i] && s.verdicts[i].valid ? 'valid' : 'doubtful'))].join('\\n') } })" },
      { node: "judge", label: "registered", provider: "parallel", state: { companies: "{documents}" }, out: "Registered", as: "registered" },
      { node: "judge", label: "second opinion", provider: "openrouter", model: "liquid/d1", state: { tally: "{tally}" }, out: "Second", as: "second" },
      { node: "call", label: "report", via: "tool", tool: "llm", args: { prompt: "{tally.prompt}", maxTokens: 200 }, out: "Llm", as: "summary", deadline_s: 60 },
      {
        node: "route", label: "decide", state: { tally: "{tally}" }, instructions: "Do all the certificates look valid?",
        branches: {
          approve: { criteria: "Every certificate looks valid.", body: { node: "code", label: "approve", code: "(s) => ({ decision: 'approved' })" } },
          review: { criteria: "Some certificate is doubtful.", body: { node: "code", label: "send to review", code: "(s) => ({ decision: 'review' })" } },
        },
      },
      { node: "code", label: "result", code: "(s) => ({ result: { decision: s.decision, summary: s.summary.text } })" },
    ],
  },
};

const made = await api("POST", "/agents", { definition: { id: "coi-batch", name: "CoI batch", workflow, tools: ["pdf_pages", "llm"] } });
say(`create agent: ${made.status}${made.body.warnings?.length ? ` warnings ${JSON.stringify(made.body.warnings)}` : ""}`);
assert.equal(made.status, 201, JSON.stringify(made.body));
const started = await api("POST", "/agents/coi-batch/runs", { input: { documents: companies.map(([stem]) => `${stem}.pdf`) } });
say(`start run: ${started.status} ${started.body.run_id}`);
assert.equal(started.status, 202, JSON.stringify(started.body));
const id = started.body.run_id;

const line = (g) => {
  const states = Object.entries(g.nodes).filter(([path]) => !/\/body$/.test(path) || path.endsWith("/branches/approve/body") || path.endsWith("/branches/review/body"))
    .map(([path, n]) => `${g.graph.nodes.find((x) => x.path === path)?.label ?? path}=${n.status}${n.branch ? `(${n.branch})` : ""}`);
  const map = Object.values(g.nodes).find((n) => n.items);
  return `run=${g.run.status}${g.run.paused ? " PAUSED" : ""} items=[${map?.items.map((i) => `${i.index}:${i.status}`).join(" ") ?? ""}] decisions=${g.totals.decisions} effects=${g.totals.effects} cost=${g.totals.cost_usd} | ${states.join(", ")}`;
};
// /graph never refuses a poll: a busy store answers the last good view, marked stale. Asked once, never retried.
let stale = 0;
const graph = async () => {
  const g = await request("GET", `/runs/${id}/graph`);
  assert.equal(g.status, 200, JSON.stringify(g.body));
  if (g.body.stale) stale++;
  return g.body;
};

// Live polls until the first decision is in.
let g;
for (let i = 0; ; i++) {
  g = await graph();
  say(`graph: ${line(g)}`);
  if (g.totals.decisions >= 1) break;
  assert.ok(i < 120, "a decision lands within a minute");
  await sleep(500);
}

// Pause: in-flight calls finish, nothing new starts.
const paused = await api("POST", `/runs/${id}/pause`);
say(`pause: ${paused.status} ${JSON.stringify(paused.body)}`);
assert.deepEqual([paused.status, paused.body.paused, paused.body.status], [200, true, "paused"]);
await sleep(4000);
const settled = await graph();
say(`paused, settled: ${line(settled)}`);
await sleep(3000);
const still = await graph();
say(`paused, 3 s later: ${line(still)}`);
assert.equal(still.run.status, "paused");
assert.equal(still.totals.decisions, settled.totals.decisions, "no decision lands while paused");
assert.equal(still.effects.filter((e) => e.status === "working").length, 0, "no call is in flight while paused");
assert.equal(still.totals.effects, settled.totals.effects, "no call starts while paused");
const view = await api("GET", `/runs/${id}`);
say(`GET /runs/${id}: status ${view.body.status}`);
assert.equal(view.body.status, "paused");

// A restart keeps it paused.
await stopServer(server.child);
say("serve stopped (SIGTERM) with the run paused");
server = await startServer();
say(`serve restarted on ${server.base}`);
await sleep(3000);
const after = await graph();
say(`after restart: ${line(after)}`);
assert.equal(after.run.status, "paused");
assert.equal(after.totals.decisions, still.totals.decisions, "the restart asked nothing again");

const resumed = await api("POST", `/runs/${id}/resume`);
say(`resume: ${resumed.status} ${JSON.stringify(resumed.body)}`);
assert.equal(resumed.body.paused, false);
for (let i = 0; ; i++) {
  g = await graph();
  say(`graph: ${line(g)}`);
  if (["completed", "failed", "cancelled"].includes(g.run.status)) break;
  assert.ok(i < 240, "the run ends within two minutes of its resume");
  await sleep(500);
}
const run = (await api("GET", `/runs/${id}`)).body;
say(`run ended: ${run.status} output=${JSON.stringify(run.result?.output)} review=${JSON.stringify(run.review)} cost=${JSON.stringify(run.cost)}`);
say(`graph polls answered stale: ${stale}`);
assert.equal(run.status, "completed", JSON.stringify(run));

// The page images are run files.
const image = g.effects.find((e) => e.tool === "pdf_pages")?.output?.pages?.[0]?.image;
const file = await api("GET", `/runs/${id}/files/${image}`);
say(`GET /runs/${id}/files/${image}: ${file.status} ${file.type} ${file.body.length} bytes, PNG ${file.body.subarray(1, 4).toString() === "PNG"}`);
assert.equal(file.status, 200);
const escape = await api("GET", `/runs/${id}/files/..%2F..%2Fstore.sqlite`);
say(`GET /runs/${id}/files/..%2F..%2Fstore.sqlite: ${escape.status}`);
assert.notEqual(escape.status, 200);

const decided = readFileSync(calls, "utf8").trim().split("\n").map((l) => JSON.parse(l));
say(`decision provider calls: ${decided.length} (${decided.map((c) => `${c.path} ${c.model ?? ""}${c.images ? ` images=${c.images}` : ""}`).join("; ")})`);
assert.equal(decided.length, companies.length + 3, "each document judged once, Parallel, OpenRouter and the route once each: nothing asked twice across the pause and the restart");

// The final graph, whole, for the console crew.
const shown = structuredClone(g);
for (const e of shown.effects) if (e.output?.text && e.output.text.length > 200) e.output.text = `${e.output.text.slice(0, 200)}…`;
say(`final graph JSON:\n${JSON.stringify(shown, null, 1)}`);
await stopServer(server.child);
say("PASS");
if (opts.out) writeFileSync(opts.out, `${out.join("\n")}\n`);
if (!opts.keep) execFileSync("rm", ["-rf", root]);
