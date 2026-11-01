#!/usr/bin/env node
// The decision-workflow live serve smoke: serve with no --faux, real Jev (images), Parallel and an OpenRouter
// model for the `llm` call. A workflow agent runs map(pdf_pages -> Jev image judge) over three documents, then a
// Parallel web-grounded judge and one `llm` call. It polls GET /v2/runs/{id}/graph throughout (each poll asked once,
// never retried), pauses the run once its first decision is in, checks nothing new starts while paused, resumes it and
// follows it to its end. It prints receipts, costs and latencies; never a key.
//
//   node packages/serve/scripts/dwf-smoke-live.mjs --documents DIR [--out FILE] [--model ID]
//
// Needs TYPESAFE_API_KEY, PARALLEL_API_KEY and OPENROUTER_API_KEY in its environment. The
// server binds 127.0.0.1 on a free port; its data directory is under /tmp.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const { values: opts } = parseArgs({ options: { documents: { type: "string" }, out: { type: "string" }, model: { type: "string", default: "openrouter/anthropic/claude-haiku-5.5" }, files: { type: "string", default: "coi-bramblewick-tidal-instruments.pdf,ein-dunmore-kiln-works.pdf,bank-osterby-orchard-supply.pdf" } } });
assert.ok(opts.documents, "--documents DIR");
for (const name of ["TYPESAFE_API_KEY", "PARALLEL_API_KEY", "OPENROUTER_API_KEY"]) assert.ok(process.env[name], `${name} is not set: the live smoke needs it in its environment`);
const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "..", "dist", "cli.js");
const data = join(mkdtempSync("/tmp/dwf-serve-live-"), "data");
const files = opts.files.split(",");
const out = [];
const say = (line) => {
  const text = `${new Date().toISOString().slice(11, 23)} ${line}`;
  out.push(text);
  console.log(text);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const save = () => opts.out && writeFileSync(opts.out, `${out.join("\n")}\n`);
process.on("exit", save);

const token = `live_${randomBytes(24).toString("base64url")}`;
const child = spawn(process.execPath, [cli, "--data", data, "--listen", "127.0.0.1", "--port", "0", "--documents", opts.documents, "--allow-code-nodes", "--drain-timeout", "5s"], {
  env: { ...process.env, AGENTRUN_TOKEN: token, AGENTRUN_ACCOUNTS: "0", AGENTRUN_LOG: "quiet", AGENT_MODEL: opts.model },
  stdio: ["ignore", "pipe", "pipe"],
});
let err = "";
child.stderr.on("data", (chunk) => (err += chunk));
process.on("exit", () => child.exitCode === null && child.kill("SIGTERM"));
const base = await new Promise((resolve, reject) => {
  let text = "";
  child.stdout.on("data", (chunk) => {
    text += chunk;
    const found = /AGENTRUN_BASE_URL=(\S+)/.exec(text)?.[1];
    if (found) resolve(found);
  });
  child.once("exit", (code) => reject(new Error(`serve exited ${code}: ${err.slice(-2000)}`)));
});
const request = async (method, path, body) => {
  const started = Date.now();
  const res = await fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null), ms: Date.now() - started };
};
say(`serve on ${base} (data ${data}), llm model ${opts.model}, documents ${files.join(", ")}`);
const caps = (await request("GET", "/capabilities")).body;
say(`capabilities: decisions ${JSON.stringify(caps.workflows.decisions.providers.map((p) => [p.id, p.available]))}, models ${JSON.stringify(caps.models ?? caps.model ?? null)}`);

const workflow = {
  v: 2, name: "live-smoke",
  schemas: {
    In: { type: "object", required: ["documents", "as_of"], properties: { documents: { type: "array", items: { type: "string" } }, as_of: { type: "string" } } },
    Pages: { type: "object", required: ["name", "pageCount", "pages", "text"], properties: { name: { type: "string" }, pageCount: { type: "integer" }, pages: { type: "array", items: { type: "object", required: ["page", "image"], properties: { page: { type: "integer" }, image: { type: "string" } } } }, text: { type: "string" } } },
    Checks: {
      type: "object", additionalProperties: false, required: ["doc_type", "looks_altered", "authenticated"],
      properties: {
        doc_type: { type: "string", enum: ["certificate_of_incorporation", "ein_letter", "bank_letter", "other"], description: "What kind of document is shown in <page_1>?", criteria: { certificate_of_incorporation: "A certificate or articles of incorporation filed with a US state's filing office.", ein_letter: "An IRS notice assigning an Employer Identification Number (CP 575 or similar).", bank_letter: "A bank's letter confirming a business account.", other: "Any other document, or a page that cannot be read." } },
        looks_altered: { type: "boolean", description: "Does <page_1> show signs that someone edited the document after it was issued: a field covered over or pasted on, a date typed over another, or a value in a different typeface from the text around it?" },
        authenticated: { type: "boolean", description: "Does <page_1> carry the marks a document of its kind is issued with (a filing office's seal and signatures; a bank officer's signature; the IRS header and notice number)?" },
      },
    },
    Grounded: { type: "object", additionalProperties: false, required: ["is_filing_office"], properties: { is_filing_office: { type: "boolean", description: "Is the Delaware Division of Corporations the office that files certificates of incorporation for Delaware corporations, as `question` asks?" } } },
    Llm: { type: "object", required: ["text"], properties: { text: { type: "string" }, model: { type: ["string", "null"] }, cost_usd: { type: ["number", "null"] } } },
    Out: { type: "object", required: ["summary"], properties: { summary: { type: "string" } } },
  },
  input: { schemaId: "In" },
  output: { schemaId: "Out", path: "result" },
  root: {
    node: "chain",
    steps: [
      {
        node: "map", label: "each document", itemsPath: "documents", as: "checked", resultPath: "checks", maxConcurrency: 2, onItemFailure: "collect", failedAs: "unreadable",
        body: {
          node: "chain",
          steps: [
            { node: "call", label: "render", via: "tool", tool: "pdf_pages", args: { path: "{item}", maxPages: 1, dpi: 110 }, out: "Pages", as: "pages", deadline_s: 60 },
            { node: "judge", label: "inspect", provider: "jev", timeoutMs: 60000, images: { "<page_1>": "{pages.pages.0.image}" }, state: { file: "{pages.name}", page_image: "<page_1>", as_of: "{as_of}" }, out: "Checks", as: "checks" },
          ],
        },
      },
      { node: "judge", label: "registry", provider: "parallel", state: { question: "Who files certificates of incorporation for Delaware corporations?" }, out: "Grounded", as: "registry" },
      { node: "code", label: "prompt", code: "(s) => ({ prompt: 'In two sentences, summarize these document checks for a compliance reviewer: ' + JSON.stringify(s.checked) })" },
      { node: "call", label: "summary", via: "tool", tool: "llm", args: { prompt: "{prompt}", maxTokens: 200 }, out: "Llm", as: "summary", deadline_s: 120 },
      { node: "code", label: "result", code: "(s) => ({ result: { summary: s.summary.text } })" },
    ],
  },
};

const checked = await request("POST", "/workflows/validate", { workflow, tools: ["pdf_pages", "llm"] });
say(`validate: ${checked.status} ok=${checked.body.ok} issues=${JSON.stringify(checked.body.issues)}`);
const made = await request("POST", "/agents", { definition: { id: "live-smoke", name: "Live smoke", workflow, tools: ["pdf_pages", "llm"] } });
say(`create agent: ${made.status}${made.body.warnings?.length ? ` warnings ${JSON.stringify(made.body.warnings)}` : ""}`);
assert.equal(made.status, 201, JSON.stringify(made.body));
const started = await request("POST", "/agents/live-smoke/runs", { input: { documents: files, as_of: "2026-10-30" } });
say(`start run: ${started.status} ${started.body.run_id} title "${started.body.title}"`);
assert.equal(started.status, 202, JSON.stringify(started.body));
const id = started.body.run_id;

let polls = 0, refused = 0, stale = 0, slowest = 0;
const graph = async () => {
  const g = await request("GET", `/runs/${id}/graph`);
  polls++;
  slowest = Math.max(slowest, g.ms);
  if (g.status !== 200) {
    refused++;
    say(`graph: ${g.status} ${JSON.stringify(g.body).slice(0, 200)}`);
    return undefined;
  }
  if (g.body.stale) stale++;
  return g.body;
};
const line = (g) => {
  const map = g.nodes["/root/steps/0"];
  const states = g.graph.nodes.filter((n) => !["chain"].includes(n.kind)).map((n) => `${n.label}=${g.nodes[n.path].status}`);
  return `run=${g.run.status}${g.run.paused ? " PAUSED" : ""} items=[${map.items.map((i) => `${i.label}:${i.status}`).join(" ")}] decisions=${g.totals.decisions} effects=${g.totals.effects} cost=${g.totals.cost_usd} | ${states.join(", ")}`;
};

let g;
let last = "";
const show = (prefix, view) => {
  const text = line(view);
  if (text !== last) say(`${prefix}${text}`);
  last = text;
};
for (const end = Date.now() + 180_000; ; ) {
  g = (await graph()) ?? g;
  if (g) show("graph: ", g);
  if (g && g.totals.decisions >= 1) break;
  assert.ok(Date.now() < end, "a decision lands within three minutes");
  await sleep(250);
}
const paused = await request("POST", `/runs/${id}/pause`);
say(`pause: ${paused.status} ${JSON.stringify(paused.body)}`);
const right = await graph();
say(`graph right after pause: ${right ? `200 in ${slowest} ms max so far, stale ${right.stale}` : "refused"}`);
await sleep(8000);
const settled = await graph();
show("paused, settled: ", settled);
await sleep(4000);
const still = await graph();
show("paused, 4 s later: ", still);
assert.equal(still.run.status, "paused");
assert.equal(still.totals.decisions, settled.totals.decisions, "no decision lands while paused");
assert.equal(still.totals.effects, settled.totals.effects, "no call starts while paused");
const resumed = await request("POST", `/runs/${id}/resume`);
say(`resume: ${resumed.status} ${JSON.stringify(resumed.body)}`);
for (const end = Date.now() + 300_000; ; ) {
  g = (await graph()) ?? g;
  show("graph: ", g);
  if (["completed", "failed", "cancelled"].includes(g.run.status)) break;
  assert.ok(Date.now() < end, "the run ends within five minutes of its resume");
  await sleep(500);
}
const run = (await request("GET", `/runs/${id}`)).body;
say(`run ended: ${run.status} cost=${JSON.stringify(run.cost)} error=${JSON.stringify(run.error)}`);
say(`output: ${JSON.stringify(run.result?.output)}`);
g = await graph();
for (const d of g.decisions) {
  const answers = Object.fromEntries(Object.entries(d.answers ?? {}).map(([q, a]) => [q, a?.choice ?? a?.noul ?? a?.score ?? a]));
  say(`decision ${d.id?.slice(0, 12)} ${d.kind} item=${d.item} provider=${d.provider} model=${d.model} status=${d.status} cost=${d.cost_usd} (${d.cost_basis}) latency=${d.latency_ms} ms images=${d.images.map((i) => i.ref).join(",")} state=${d.state ? "kept" : "none"} answers=${JSON.stringify(answers)} evidence=${d.evidence.length}${d.evidence[0] ? ` first ${d.evidence[0].url}` : ""}`);
}
for (const e of g.effects) say(`effect ${e.tool} item=${e.item} ${e.status} ${e.error ?? ""} ${e.tool === "llm" ? `model=${e.output?.model} cost=${e.output?.cost_usd} usage=${JSON.stringify(e.output?.usage)}` : `pages=${e.output?.pageCount ?? ""}`}`);
say(`totals: ${JSON.stringify(g.totals)}`);
const image = g.decisions.find((d) => d.images.length)?.images[0];
if (image) {
  const res = await fetch(`${base.replace(/\/v2$/, "")}${image.url}`, { headers: { authorization: `Bearer ${token}` } });
  say(`GET ${image.url}: ${res.status} ${res.headers.get("content-type")} ${(await res.arrayBuffer()).byteLength} bytes`);
}
say(`graph polls: ${polls}, refused ${refused}, stale ${stale}, slowest ${slowest} ms`);
assert.equal(refused, 0, "no graph poll was refused");
assert.equal(run.status, "completed");
say("PASS");
child.kill("SIGTERM");
