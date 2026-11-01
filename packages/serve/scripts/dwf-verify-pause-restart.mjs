#!/usr/bin/env node
// A paused workflow run keeps its place across a server restart. serve --faux (faux Jev, each call 1.5 s), a map at
// maxConcurrency 4 of pdf_pages -> Jev image judge over eight documents, paused mid-map. It notes the done items and
// the decisions from /graph, stops serve with SIGTERM, starts it on the same --data, and checks the run reads paused
// with the same items done, the same decisions and no new provider call. Then it resumes, follows the run to its end,
// and checks each decision was made once: one receipt per id, one provider call per item.
//
//   node packages/serve/scripts/dwf-verify-pause-restart.mjs [--out FILE]
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const { values: opts } = parseArgs({ options: { out: { type: "string" } } });
const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "dwf-smoke");
const root = mkdtempSync("/tmp/dwf-serve-verify-");
const docs = join(root, "documents");
const data = join(root, "data");
const calls = join(root, "provider-calls.jsonl");
mkdirSync(docs);
const out = [];
const say = (line) => {
  const text = `${new Date().toISOString().slice(11, 23)} ${line}`;
  out.push(text);
  console.log(text);
};
process.on("exit", () => opts.out && writeFileSync(opts.out, `${out.join("\n")}\n`));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const names = ["alder", "birch", "cedar", "dogwood", "elm", "fir", "ginkgo", "hazel"];
for (const name of names) {
  const ps = join(root, `${name}.ps`);
  writeFileSync(ps, `%!PS\n/Helvetica-Bold findfont 22 scalefont setfont\n72 700 moveto (CERTIFICATE OF INCORPORATION) show\n/Helvetica findfont 16 scalefont setfont\n72 660 moveto (${name} Holdings, Inc.) show\nshowpage\n`);
  execFileSync("gs", ["-q", "-dSAFER", "-dBATCH", "-dNOPAUSE", "-sDEVICE=pdfwrite", `-sOutputFile=${join(docs, `${name}.pdf`)}`, ps]);
}
const token = `verify_${randomBytes(24).toString("base64url")}`;
const fake = join(fixtures, "faux-decisions.mjs");
/** The fake's key: a stand-in it never checks, held in a name so no key literal sits beside a key variable. */
const STAND_IN = "faux-verify-placeholder";
function startServer() {
  const options = { data, host: "127.0.0.1", port: 0, token, faux: join(fixtures, "faux-model.mjs"), fauxJev: fake, documents: docs, allowCodeNodes: true, drainTimeout: "2s" };
  const child = spawn(process.execPath, [join(fixtures, "serve-faux.mjs"), JSON.stringify(options)], {
    env: { ...process.env, AGENTRUN_LOG: "quiet", TYPESAFE_API_KEY: STAND_IN, AGENTRUN_SMOKE_DECISION_CALLS: calls, AGENTRUN_SMOKE_DECISION_MS: "1500" },
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
let server = await startServer();
process.on("exit", () => server.child.exitCode === null && server.child.kill("SIGTERM"));
const request = async (method, path, body) => {
  const res = await fetch(`${server.base}${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const providerCalls = () => (existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n").filter(Boolean).length : 0);
say(`serve on ${server.base}, data ${data}`);

const workflow = {
  v: 2, name: "verify-batch",
  schemas: {
    In: { type: "object", required: ["documents"], properties: { documents: { type: "array", items: { type: "string" } } } },
    Pages: { type: "object", required: ["pages", "text"], properties: { pages: { type: "array" }, text: { type: "string" } } },
    Verdict: { type: "object", additionalProperties: false, required: ["valid"], properties: { valid: { type: "boolean", description: "Does <page_1> show an unaltered certificate of incorporation?" } } },
    Out: { type: "object", required: ["valid"], properties: { valid: { type: "integer" } } },
  },
  input: { schemaId: "In" },
  output: { schemaId: "Out", path: "result" },
  root: { node: "chain", steps: [
    { node: "map", label: "each document", itemsPath: "documents", as: "verdicts", resultPath: "verdict", maxConcurrency: 4, onItemFailure: "collect", failedAs: "unreadable", body: { node: "chain", steps: [
      { node: "call", label: "render", via: "tool", tool: "pdf_pages", args: { path: "{item}", maxPages: 1, dpi: 72 }, out: "Pages", as: "pages", deadline_s: 60 },
      { node: "judge", label: "inspect", images: { "<page_1>": "{pages.pages.0.image}" }, state: { page: "<page_1>", text: "{pages.text}" }, out: "Verdict", as: "verdict" },
    ] } },
    { node: "code", label: "result", code: "(s) => ({ result: { valid: s.verdicts.filter((v) => v && v.valid).length } })" },
  ] },
};
assert.equal((await request("POST", "/agents", { definition: { id: "verify-batch", name: "Verify batch", workflow, tools: ["pdf_pages"] } })).status, 201);
const started = await request("POST", "/agents/verify-batch/runs", { input: { documents: names.map((n) => `${n}.pdf`) } });
const id = started.body.run_id;
say(`run ${id} "${started.body.title}": map of ${names.length} at maxConcurrency 4, each item pdf_pages -> Jev image judge (faux, 1.5 s)`);

const graph = async () => {
  const g = await request("GET", `/runs/${id}/graph`);
  assert.equal(g.status, 200, JSON.stringify(g.body));
  return g.body;
};
const items = (g) => g.nodes["/root/steps/0"].items;
const done = (g) => items(g).filter((i) => i.status === "done").map((i) => i.label);
const line = (g) => `run=${g.run.status} paused=${g.run.paused} items=[${items(g).map((i) => `${i.label.replace(".pdf", "")}:${i.status}`).join(" ")}] decisions=${g.totals.decisions}`;

let g;
for (const end = Date.now() + 60_000; ; ) {
  g = await graph();
  if (g.totals.decisions >= 2) break;
  assert.ok(Date.now() < end, "two decisions land within a minute");
  await sleep(200);
}
say(`before pause: ${line(g)}`);
const paused = await request("POST", `/runs/${id}/pause`);
say(`POST pause: ${paused.status} ${JSON.stringify(paused.body)}`);
await sleep(4000);
const held = await graph();
await sleep(1500);
const before = await graph();
say(`paused, settled: ${line(before)}`);
assert.equal(before.run.status, "paused");
assert.deepEqual([before.totals.decisions, done(before)], [held.totals.decisions, done(held)], "nothing lands while paused");
assert.ok(done(before).length > 0 && done(before).length < names.length, "paused mid-map");
const callsBefore = providerCalls();
const receiptsBefore = before.decisions.map((d) => d.id);
say(`noted: done ${JSON.stringify(done(before))}, decisions ${before.totals.decisions}, provider calls ${callsBefore}`);

server.child.kill("SIGTERM");
await new Promise((resolve) => server.child.once("exit", resolve));
say("serve stopped with SIGTERM");
server = await startServer();
say(`serve started again on the same --data: ${server.base}`);
await sleep(5000);
const after = await graph();
say(`after restart (5 s): ${line(after)}`);
const run = (await request("GET", `/runs/${id}`)).body;
say(`GET /runs/${id}: status ${run.status}`);
assert.equal(after.run.status, "paused");
assert.equal(run.status, "paused");
assert.deepEqual(done(after), done(before), "the same items done");
assert.deepEqual(after.decisions.map((d) => d.id), receiptsBefore, "the same decisions");
assert.equal(providerCalls(), callsBefore, "no new provider call across the restart");
say(`checked: paused, same ${done(after).length} items done, same ${after.totals.decisions} decisions, provider calls still ${providerCalls()}`);

say(`POST resume: ${JSON.stringify((await request("POST", `/runs/${id}/resume`)).body)}`);
for (const end = Date.now() + 120_000; ; ) {
  g = await graph();
  if (["completed", "failed", "cancelled"].includes(g.run.status)) break;
  assert.ok(Date.now() < end, "the run ends within two minutes");
  await sleep(500);
}
say(`ended: ${line(g)}`);
const final = (await request("GET", `/runs/${id}`)).body;
say(`run ${final.status}, output ${JSON.stringify(final.result?.output)}, cost ${JSON.stringify(final.cost)}`);
const ids = g.decisions.map((d) => d.id);
const perItem = g.decisions.map((d) => d.item).sort((a, b) => a - b);
say(`receipts: ${ids.length}, distinct ids ${new Set(ids).size}, items ${JSON.stringify(perItem)}; provider calls ${providerCalls()}`);
assert.equal(final.status, "completed");
assert.equal(new Set(ids).size, ids.length, "each receipt id once");
assert.deepEqual(perItem, names.map((_, i) => i), "one decision per item");
assert.equal(providerCalls(), names.length, "one provider call per item, none repeated");
say("PASS");
server.child.kill("SIGTERM");
