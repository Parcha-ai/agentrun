// The decision-workflow demo's serve pieces: the call tools pdf_pages and llm, code nodes, the documents directory,
// GET /v2/runs/{id}/graph and pause/resume. Code nodes run only on a server that allows them. Faux model, no key, no network.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { completer } from "../dist/llm.js";
import { documentPath, MAX_PAGE_PX, pdfPages } from "../dist/pdf-pages.js";
import { gated, RUN_PAUSED } from "../dist/pause.js";
import { flowAgent, follow, scratch, serve, withEnv } from "./support.mjs";

/** A fake's key: a stand-in it never checks, held in a name so no key literal sits beside a key variable. */
const STAND_IN = "faux-test-placeholder";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A two-page PDF drawn with Ghostscript. */
function pdf(file, title) {
  const ps = `${file}.ps`;
  execFileSync("sh", ["-c", `cat > '${ps}'`], { input: `%!PS\n/Helvetica findfont 20 scalefont setfont\n72 700 moveto (${title}) show\nshowpage\n72 700 moveto (Page two) show\nshowpage\n` });
  execFileSync("gs", ["-q", "-dSAFER", "-dBATCH", "-dNOPAUSE", "-sDEVICE=pdfwrite", `-sOutputFile=${file}`, ps]);
}

test("pdf_pages draws a document's first pages into the run's work directory, with its text; a PNG passes through", async (t) => {
  const dir = await scratch(t);
  const [docs, work] = [join(dir, "docs"), join(dir, "work")];
  await mkdir(docs);
  await mkdir(work);
  pdf(join(docs, "coi acme.pdf"), "CERTIFICATE OF INCORPORATION Acme");
  const out = await pdfPages({ path: "coi acme.pdf", maxPages: 1, dpi: 50 }, { work, documents: docs });
  assert.deepEqual([out.name, out.pageCount, out.dpi, out.pages], ["coi acme.pdf", 2, 50, [{ page: 1, image: "pages/coi_acme/50/1.png" }]]);
  assert.match(out.text, /CERTIFICATE OF INCORPORATION Acme/);
  const png = await readFile(join(work, "pages/coi_acme/50/1.png"));
  assert.equal(png.subarray(1, 4).toString(), "PNG");
  // Drawn again at another dpi, the earlier image stays; asked past the cap, the page is drawn at the dpi that fits.
  const big = await pdfPages({ path: "coi acme.pdf", maxPages: 1, dpi: 300 }, { work, documents: docs });
  // Ghostscript's page is A4 (842 points tall) or letter (792), whichever its default is here.
  assert.ok([842, 792].map((points) => Math.floor(((MAX_PAGE_PX - 2) * 72) / points)).includes(big.dpi), String(big.dpi));
  assert.equal(big.pages[0].image, `pages/coi_acme/${big.dpi}/1.png`);
  assert.ok(Math.max(png.readUInt32BE(16), png.readUInt32BE(20)) <= MAX_PAGE_PX);
  const drawn = await readFile(join(work, big.pages[0].image));
  assert.ok(Math.max(drawn.readUInt32BE(16), drawn.readUInt32BE(20)) <= MAX_PAGE_PX, `${drawn.readUInt32BE(16)} x ${drawn.readUInt32BE(20)}`);
  assert.deepEqual(await readFile(join(work, "pages/coi_acme/50/1.png")), png);
  await writeFile(join(work, "scan.png"), png);
  assert.deepEqual(await pdfPages({ path: "scan.png" }, { work, documents: docs }), { name: "scan.png", pageCount: 1, dpi: null, pages: [{ page: 1, image: "pages/scan/1.png" }], text: "" });
  // A scan over the cap passes through scaled to it, its proportions kept.
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=white:s=2000x1000", "-frames:v", "1", join(work, "wide.png")]);
  const wide = await pdfPages({ path: "wide.png" }, { work, documents: docs });
  const scaled = await readFile(join(work, wide.pages[0].image));
  assert.deepEqual([scaled.readUInt32BE(16), scaled.readUInt32BE(20)], [MAX_PAGE_PX, 784]);
});

test("pdf_pages reads only under the documents and the work directory: no absolute path, no .., no symlink out", async (t) => {
  const dir = await scratch(t);
  const [docs, work, outside] = [join(dir, "docs"), join(dir, "work"), join(dir, "outside")];
  for (const d of [docs, work, outside]) await mkdir(d);
  await writeFile(join(outside, "secret.pdf"), "x");
  await symlink(join(outside, "secret.pdf"), join(docs, "link.pdf"));
  for (const path of [join(outside, "secret.pdf"), "../outside/secret.pdf", "link.pdf", "missing.pdf", ""]) {
    await assert.rejects(documentPath(path, { work, documents: docs }), /pdf_pages:/, path);
  }
  await assert.rejects(pdfPages({ path: "x.pdf", maxPages: 0 }, { work, documents: docs }), /pdf_pages:/);
});

test("llm completes once on the tier's model: text, model, usage, and a null cost for an unpriced model", async () => {
  const sent = [];
  const models = {
    getModel: (provider, id) => ({ provider, id, cost: id === "priced" ? { input: 1, output: 1 } : { input: 0, output: 0 } }),
    completeSimple: async (model, context, options) => {
      sent.push({ model: model.id, context, options });
      return { content: [{ type: "text", text: "hello" }], usage: { input: 3, output: 2, cacheRead: 7, cacheWrite: 0, cost: { total: model.id === "priced" ? 0.5 : 0 } }, stopReason: "stop" };
    },
  };
  const complete = completer(models, (tier) => ({ provider: "faux", modelId: tier === "strong" ? "priced" : "free" }), "medium");
  const free = await complete({ prompt: "Say hi", system: "Be brief", maxTokens: 50 }, AbortSignal.timeout(1000));
  assert.deepEqual(free, { text: "hello", model: "faux/free", usage: { input_tokens: 10, output_tokens: 2, cached_input_tokens: 7 }, cost_usd: null }, "the input counts its cached tokens");
  assert.deepEqual([sent[0].context.systemPrompt, sent[0].context.messages[0].content, sent[0].options.maxTokens, sent[0].options.reasoning], ["Be brief", "Say hi", 50, "medium"]);
  assert.equal((await complete({ prompt: "x", tier: "strong" }, AbortSignal.timeout(1000))).cost_usd, 0.5);
  await assert.rejects(complete({ prompt: "" }, AbortSignal.timeout(1000)), /prompt/);
});

test("the pause gate holds a call while the mark is there, and lets it go on resume or on its abort", async (t) => {
  const dir = await scratch(t);
  await writeFile(join(dir, RUN_PAUSED), "");
  let ran = 0;
  const call = gated(dir, async () => ++ran);
  const held = call({});
  await sleep(600);
  assert.equal(ran, 0);
  execFileSync("rm", [join(dir, RUN_PAUSED)]);
  assert.equal(await held, 1);
  await writeFile(join(dir, RUN_PAUSED), "");
  const controller = new AbortController();
  const aborted = call({ signal: controller.signal });
  controller.abort();
  assert.equal(await aborted, 2);
});

/** A workflow over the documents: map(pdf_pages) -> code tally -> llm. No decision provider is needed. */
const docsFlow = () => ({
  v: 2, name: "docs",
  schemas: {
    In: { type: "object", required: ["documents"], properties: { documents: { type: "array", items: { type: "string" } } } },
    Pages: { type: "object", required: ["pages", "text"], properties: { pages: { type: "array" }, text: { type: "string" } } },
    Llm: { type: "object", required: ["text"], properties: { text: { type: "string" } } },
    Out: { type: "object", required: ["count", "summary"], properties: { count: { type: "integer" }, summary: { type: "string" } } },
  },
  input: { schemaId: "In" },
  output: { schemaId: "Out", path: "result" },
  root: {
    node: "chain",
    steps: [
      { node: "map", label: "each", itemsPath: "documents", as: "drawn", resultPath: "pages", maxConcurrency: 1, body: { node: "call", label: "pages", via: "tool", tool: "pdf_pages", args: { path: "{item}", maxPages: 1, dpi: 40 }, out: "Pages", as: "pages", deadline_s: 120 } },
      { node: "code", label: "tally", code: "(s) => ({ tally: { count: s.drawn.length, prompt: 'Summarize ' + s.drawn.length + ' documents' } })" },
      { node: "call", label: "summary", via: "tool", tool: "llm", args: { prompt: "{tally.prompt}" }, out: "Llm", as: "summary", deadline_s: 120 },
      { node: "code", label: "result", code: "(s) => ({ result: { count: s.tally.count, summary: s.summary.text } })" },
    ],
  },
});

test("a workflow with code, pdf_pages and llm calls runs on serve; its graph shows the items, the calls and the totals; pause holds it", async (t) => {
  const dir = await scratch(t);
  const docs = join(dir, "docs");
  await mkdir(docs);
  for (const name of ["a", "b", "c"]) pdf(join(docs, `${name}.pdf`), `Document ${name}`);
  const { api } = await serve(t, { documents: docs, allowCodeNodes: true });
  const made = await api("POST", "/agents", flowAgent("docs", docsFlow(), { tools: ["pdf_pages", "llm"] }));
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const caps = (await api("GET", "/capabilities")).body;
  assert.deepEqual(caps.tools.filter((tool) => tool.call_only).map((tool) => tool.name), ["pdf_pages", "llm"]);
  // Paused before it starts: its process comes up, and no node starts until the resume.
  const started = await api("POST", "/agents/docs/runs", { input: { documents: ["a.pdf", "b.pdf", "c.pdf"] } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const id = started.body.run_id;
  const paused = await api("POST", `/runs/${id}/pause`);
  assert.deepEqual([paused.status, paused.body], [200, { run_id: id, paused: true, status: "paused" }]);
  assert.equal((await api("GET", `/runs/${id}`)).body.status, "paused");
  const listed = (await api("GET", "/runs?status=paused")).body.runs.map((r) => r.run_id);
  assert.deepEqual(listed, [id]);
  await sleep(3000);
  let graph = (await api("GET", `/runs/${id}/graph`)).body;
  assert.deepEqual([graph.run.status, graph.run.paused, graph.totals.effects], ["paused", true, 0]);
  assert.deepEqual(graph.nodes["/root/steps/0"].items.map((i) => [i.index, i.status, i.label]), [[0, "pending", "a.pdf"], [1, "pending", "b.pdf"], [2, "pending", "c.pdf"]]);
  assert.equal((await api("POST", `/runs/${id}/resume`)).body.paused, false);
  await follow(api, id, ["completed"], { deadlineMs: 240_000 });
  const run = (await api("GET", `/runs/${id}`)).body;
  assert.deepEqual(run.result.output.count, 3);
  graph = (await api("GET", `/runs/${id}/graph`)).body;
  assert.deepEqual(Object.keys(graph).sort(), ["decisions", "effects", "graph", "nodes", "read_at", "run", "stale", "totals", "workflow"]);
  assert.equal(graph.stale, false);
  assert.deepEqual(Object.keys(graph.run).sort(), ["agent", "endedAt", "id", "paused", "revision", "startedAt", "status"]);
  assert.equal(graph.run.status, "completed");
  assert.deepEqual(graph.nodes["/root/steps/0"].items.map((i) => i.status), ["done", "done", "done"]);
  assert.ok(Object.values(graph.nodes).every((n) => n.status === "done"), JSON.stringify(graph.nodes));
  assert.ok(graph.nodes["/root/steps/1"].startedAt && graph.nodes["/root/steps/1"].endedAt);
  assert.deepEqual(graph.effects.map((e) => [e.node, e.item, e.tool, e.status]), [
    ["/root/steps/0/body", 0, "pdf_pages", "done"], ["/root/steps/0/body", 1, "pdf_pages", "done"], ["/root/steps/0/body", 2, "pdf_pages", "done"], ["/root/steps/2", null, "llm", "done"],
  ]);
  assert.deepEqual(graph.effects[0].input, { path: "a.pdf", maxPages: 1, dpi: 40 });
  assert.equal(graph.effects[0].output.pages[0].image, "pages/a/40/1.png");
  assert.equal(typeof graph.effects[3].output.text, "string");
  assert.deepEqual([graph.totals.decisions, graph.totals.effects], [0, 4]);
  const image = await api("GET", `/runs/${id}/files/pages/a/40/1.png`);
  assert.equal(image.status, 200);
  // An ended run is not paused again.
  assert.equal((await api("POST", `/runs/${id}/pause`)).status, 409);
  assert.ok(!existsSync(join(dir, "never")));
});

/** The smoke's faux decision providers: each call waits AGENTRUN_SMOKE_DECISION_MS and is filed in AGENTRUN_SMOKE_DECISION_CALLS. */
const FAUX_DECISIONS = new URL("../scripts/dwf-smoke/faux-decisions.mjs", import.meta.url).pathname;

test("a run's graph reads while it goes and while it is paused mid-map at maxConcurrency 4, within a second, never busy", async (t) => {
  const dir = await scratch(t);
  const docs = join(dir, "docs");
  await mkdir(docs);
  const names = ["a", "b", "c", "d", "e", "f"];
  for (const name of names) pdf(join(docs, `${name}.pdf`), `Document ${name}`);
  withEnv(t, { TYPESAFE_API_KEY: STAND_IN, AGENTRUN_SMOKE_DECISION_MS: "1500", AGENTRUN_SMOKE_DECISION_CALLS: join(dir, "calls.jsonl") }, ["PARALLEL_API_KEY", "OPENROUTER_API_KEY"]);
  const { api } = await serve(t, { documents: docs, allowCodeNodes: true, fauxJev: FAUX_DECISIONS });
  const flow = {
    v: 2, name: "judged",
    schemas: {
      In: { type: "object", required: ["documents"], properties: { documents: { type: "array", items: { type: "string" } } } },
      Pages: { type: "object", required: ["pages", "text"], properties: { pages: { type: "array" }, text: { type: "string" } } },
      Verdict: { type: "object", additionalProperties: false, required: ["valid"], properties: { valid: { type: "boolean", description: "Does `text` read as a whole document, judging by page_1?" } } },
      Out: { type: "object", required: ["count"], properties: { count: { type: "integer" } } },
    },
    input: { schemaId: "In" },
    output: { schemaId: "Out", path: "result" },
    root: {
      node: "chain",
      steps: [
        {
          node: "map", label: "each", itemsPath: "documents", as: "verdicts", resultPath: "verdict", maxConcurrency: 4,
          body: { node: "chain", steps: [
            { node: "call", label: "pages", via: "tool", tool: "pdf_pages", args: { path: "{item}", maxPages: 1, dpi: 40 }, out: "Pages", as: "pages", deadline_s: 120 },
            { node: "judge", label: "check", state: { text: "{pages.text}", page: "page_1" }, images: { page_1: "{pages.pages.0.image}" }, out: "Verdict", as: "verdict" },
          ] },
        },
        { node: "code", label: "result", code: "(s) => ({ result: { count: s.verdicts.length } })" },
      ],
    },
  };
  assert.equal((await api("POST", "/agents", flowAgent("judged", flow, { tools: ["pdf_pages"] }))).status, 201);
  const id = (await api("POST", "/agents/judged/runs", { input: { documents: names.map((n) => `${n}.pdf`) } })).body.run_id;
  /** One read of the graph, timed; never asked again. */
  const read = async () => {
    const started = Date.now();
    const answer = await api("GET", `/runs/${id}/graph`);
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    assert.equal(answer.body.stale, false, "read live, not from a cache");
    assert.ok(Date.now() - started < 1000, `the graph answered in ${Date.now() - started} ms`);
    return answer.body;
  };
  // While it goes: the map's items are working once the calls are in flight.
  let graph;
  for (const end = Date.now() + 60_000; ; ) {
    graph = await read();
    if (graph.nodes["/root/steps/0"].items.some((i) => i.status === "working") && graph.totals.effects >= 1) break;
    assert.ok(Date.now() < end, "the map starts within a minute");
    await sleep(100);
  }
  assert.deepEqual(graph.nodes["/root/steps/0"].items.map((i) => i.label), names.map((n) => `${n}.pdf`));
  assert.equal((await api("POST", `/runs/${id}/pause`)).body.paused, true);
  graph = await read();
  assert.equal(graph.run.status, "paused");
  // The judges in flight finish; nothing new starts; every read answers within a second.
  await sleep(3500);
  const settled = await read();
  await sleep(1000);
  const later = await read();
  assert.equal(later.totals.decisions, settled.totals.decisions, "no decision lands while paused");
  assert.equal(later.totals.effects, settled.totals.effects, "no call starts while paused");
  assert.ok(later.nodes["/root/steps/0"].items.some((i) => i.status === "pending"), "the map is paused mid-way");
  assert.equal((await api("POST", `/runs/${id}/resume`)).body.paused, false);
  await follow(api, id, ["completed"], { deadlineMs: 120_000 });
  graph = await read();
  assert.deepEqual(graph.nodes["/root/steps/0"].items.map((i) => i.status), names.map(() => "done"));
  assert.equal(graph.decisions.length, names.length);
  assert.ok(graph.decisions.every((d) => typeof d.id === "string" && d.id.length > 0 && d.images.length === 1 && d.state !== null), JSON.stringify(graph.decisions[0]));
});

test("a tool that fails in a map item fails that item only when the map collects: the others run, the run completes", async (t) => {
  const dir = await scratch(t);
  const docs = join(dir, "docs");
  await mkdir(docs);
  pdf(join(docs, "a.pdf"), "Document a");
  pdf(join(docs, "c.pdf"), "Document c");
  await writeFile(join(docs, "broken.pdf"), "not a PDF at all\n");
  const { api } = await serve(t, { documents: docs, allowCodeNodes: true });
  const flow = docsFlow();
  Object.assign(flow.root.steps[0], { onItemFailure: "collect", failedAs: "unreadable", maxConcurrency: 3 });
  flow.root.steps[1].code = "(s) => ({ tally: { count: s.drawn.filter(Boolean).length, prompt: 'Summarize ' + s.unreadable.length + ' unreadable' } })";
  assert.equal((await api("POST", "/agents", flowAgent("docs", flow, { tools: ["pdf_pages", "llm"] }))).status, 201);
  const started = await api("POST", "/agents/docs/runs", { input: { documents: ["a.pdf", "broken.pdf", "c.pdf"] } });
  assert.equal(started.body.title, "docs: 3 documents");
  const { workflowTitle } = await import("../dist/server.js");
  assert.equal(workflowTitle("Is this certificate valid?", { documents: ["coi-acme.pdf"] }), "Is this certificate valid? coi-acme.pdf");
  assert.equal(workflowTitle("Batch review", { documents: ["a", "b"], as_of: "2026-10-30" }), "Batch review: 2 documents, 2026-10-30");
  const id = started.body.run_id;
  await follow(api, id, ["completed", "failed"], { deadlineMs: 120_000 });
  const run = (await api("GET", `/runs/${id}`)).body;
  assert.equal(run.status, "completed", JSON.stringify(run));
  assert.equal(run.result.output.count, 2);
  const graph = (await api("GET", `/runs/${id}/graph`)).body;
  assert.deepEqual(graph.nodes["/root/steps/0"].items.map((i) => [i.label, i.status]), [["a.pdf", "done"], ["broken.pdf", "failed"], ["c.pdf", "done"]]);
  const failed = graph.effects.find((e) => e.item === 1);
  assert.equal(failed.status, "failed");
  assert.match(failed.error, /pdf/i);
});

test("POST /workflows/validate answers every issue by path, writes nothing; a save of an invalid workflow is 422 with each issue as a field", async (t) => {
  const { api } = await serve(t);
  const good = await api("POST", "/workflows/validate", { workflow: docsFlow(), tools: ["pdf_pages", "llm"] });
  assert.deepEqual([good.status, good.body.ok, good.body.issues], [200, true, []]);
  const unlisted = await api("POST", "/workflows/validate", { workflow: docsFlow(), tools: ["pdf_pages"] });
  assert.equal(unlisted.body.ok, false);
  assert.deepEqual(unlisted.body.issues.map((i) => [i.path, i.code]), [["/root/steps/2", "TOOL_NOT_LISTED"]]);
  const bad = docsFlow();
  bad.root.steps[0].itemsPath = "";
  const wrong = await api("POST", "/workflows/validate", { workflow: bad });
  assert.equal(wrong.body.ok, false, JSON.stringify(wrong.body));
  assert.ok(wrong.body.issues.some((i) => i.path === "/root/steps/0" && i.code === "NODE_FIELD_INVALID" && /itemsPath/.test(i.message)), JSON.stringify(wrong.body.issues));
  assert.equal((await api("POST", "/workflows/validate", { definition: {} })).status, 422);
  assert.deepEqual((await api("GET", "/agents")).body.agents, [], "validating writes no agent");
  const saved = await api("POST", "/agents", flowAgent("bad", bad, { tools: ["pdf_pages", "llm"] }));
  assert.equal(saved.status, 422);
  const field = saved.body.error.fields.find((f) => f.field === "definition.workflow/root/steps/0");
  assert.ok(field, JSON.stringify(saved.body.error.fields));
  assert.equal(field.code, "NODE_FIELD_INVALID");
  assert.match(field.message, /itemsPath/);
});

test("a map's items name the branch each route in its body took for them", async (t) => {
  const { api } = await serve(t, { allowCodeNodes: true });
  const flow = {
    v: 2, name: "sorted",
    schemas: { In: { type: "object", required: ["kinds"], properties: { kinds: { type: "array", items: { type: "string" } } } }, Out: { type: "object", required: ["n"], properties: { n: { type: "integer" } } } },
    input: { schemaId: "In" },
    output: { schemaId: "Out", path: "result" },
    root: { node: "chain", steps: [
      { node: "map", label: "each", itemsPath: "kinds", as: "sorted", resultPath: "verdict", body: { node: "chain", steps: [
        { node: "code", label: "read", code: "(s) => ({ kind: s.item })" },
        { node: "route", label: "sort", valuePath: "kind", branches: {
          keep: { body: { node: "code", label: "keep it", code: "(s) => ({ verdict: 'kept' })" } },
          drop: { body: { node: "code", label: "drop it", code: "(s) => ({ verdict: 'dropped' })" } },
        } },
      ] } },
      { node: "code", label: "result", code: "(s) => ({ result: { n: s.sorted.length } })" },
    ] },
  };
  assert.equal((await api("POST", "/agents", flowAgent("sorted", flow))).status, 201);
  const id = (await api("POST", "/agents/sorted/runs", { input: { kinds: ["keep", "drop", "keep"] } })).body.run_id;
  await follow(api, id, ["completed"], { deadlineMs: 60_000 });
  const graph = (await api("GET", `/runs/${id}/graph`)).body;
  assert.deepEqual(graph.nodes["/root/steps/0"].items.map((i) => i.branches), [{ "/root/steps/0/body/steps/1": "keep" }, { "/root/steps/0/body/steps/1": "drop" }, { "/root/steps/0/body/steps/1": "keep" }]);
  assert.equal(typeof graph.read_at, "string");
});

test("an agentic run has no graph and does not pause", async (t) => {
  const { api } = await serve(t);
  assert.equal((await api("POST", "/agents", { definition: { id: "chat", name: "chat", instructions: "Answer.", skills: [], tools: [] } })).status, 201);
  const run = (await api("POST", "/agents/chat/runs", { input: { content: "hello" } })).body;
  assert.equal((await api("GET", `/runs/${run.run_id}/graph`)).status, 404);
  assert.equal((await api("POST", `/runs/${run.run_id}/pause`)).status, 501);
  const refused = await api("POST", "/agents", { definition: { id: "chat2", name: "chat2", instructions: "Answer.", skills: [], tools: ["pdf_pages"] } });
  assert.equal(refused.status, 422);
});

test("code nodes are off by default: a workflow with one saves with a warning and its run is 409; a shell call is refused either way", async (t) => {
  const { api } = await serve(t);
  const saved = await api("POST", "/agents", flowAgent("docs", docsFlow(), { tools: ["pdf_pages", "llm"] }));
  assert.equal(saved.status, 201, JSON.stringify(saved.body));
  const warning = saved.body.warnings.find((w) => /code nodes/.test(w.message));
  assert.deepEqual([warning?.field, warning?.reason], ["definition.workflow", "not_set_up_here"], JSON.stringify(saved.body.warnings));
  assert.match(warning.message, /--allow-code-nodes/);
  const refused = await api("POST", "/agents/docs/runs", { input: { documents: ["a.pdf"] } });
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.equal(refused.body.error.code, "agent_not_runnable");
  assert.equal(refused.body.error.details.code, true);
  const shell = docsFlow();
  shell.root.steps[1] = { node: "call", label: "tally", via: "shell", command: "true", as: "tally", deadline_s: 10 };
  for (const allowCodeNodes of [false, true]) {
    const on = allowCodeNodes ? (await serve(t, { allowCodeNodes })).api : api;
    const made = await on("POST", "/agents", flowAgent(`shell-${allowCodeNodes}`, shell, { tools: ["pdf_pages", "llm"] }));
    assert.equal(made.status, 422, `${allowCodeNodes}: ${JSON.stringify(made.body)}`);
    assert.ok(made.body.error.fields.some((f) => /calls a shell or the executor/.test(f.message)), JSON.stringify(made.body.error.fields));
  }
});

test("AGENTRUN_SERVE_CODE_NODES=1 allows code nodes as --allow-code-nodes does", async (t) => {
  withEnv(t, { AGENTRUN_SERVE_CODE_NODES: "1" }, ["AGENTRUN_SERVE_CODE_NODES"]);
  const { api } = await serve(t);
  const saved = await api("POST", "/agents", flowAgent("docs", docsFlow(), { tools: ["pdf_pages", "llm"] }));
  assert.equal(saved.status, 201, JSON.stringify(saved.body));
  assert.deepEqual(saved.body.warnings, []);
});

test("OpenRouter's decision models run on the OpenRouter key Jev's route reads, handed on either Jev route; capabilities say which", async () => {
  const { decisionKeysOf, decisionsOf, providerMissing } = await import("../dist/decisions.js");
  /** Stand-ins, held in names: no key literal sits beside a key variable. */
  const [typesafe, router, gateway] = ["typesafe-stand-in", "router-stand-in", "gateway-stand-in"];
  assert.deepEqual(decisionKeysOf({ TYPESAFE_API_KEY: typesafe, OPENROUTER_API_KEY: router }), { TYPESAFE_API_KEY: typesafe, OPENROUTER_API_KEY: router }, "Jev on TypeSafe, OpenRouter's models on the router key");
  const onGateway = { AGENT_MODEL_BASE_URL: "https://openrouter.ai/api/v1", AGENT_MODEL_API_KEY: gateway };
  assert.deepEqual(decisionKeysOf(onGateway), { OPENROUTER_API_KEY: gateway });
  const offer = decisionsOf(onGateway).find((p) => p.id === "openrouter");
  assert.equal(offer.available, true);
  assert.match(offer.note, /AGENT_MODEL_API_KEY/);
  assert.equal(providerMissing(onGateway, "openrouter"), undefined);
  assert.deepEqual(decisionKeysOf({ AGENT_MODEL_BASE_URL: "https://example.com/v1", AGENT_MODEL_API_KEY: gateway }), {}, "another host's key never goes to openrouter.ai");
  const none = decisionsOf({}).find((p) => p.id === "openrouter");
  assert.deepEqual([none.available, providerMissing({}, "openrouter").needs], [false, ["OPENROUTER_API_KEY"]]);
});

test("a judge naming provider openrouter is answered by the OpenRouter model it names on the handed key", async (t) => {
  const placeholder = "faux-test-placeholder";
  withEnv(t, { OPENROUTER_API_KEY: placeholder }, ["TYPESAFE_API_KEY", "PARALLEL_API_KEY", "AGENT_MODEL_API_KEY", "AGENT_MODEL_BASE_URL", "AGENTRUN_FAUX_SYSTEM_ONE_DELAY_MS"]);
  process.env.AGENTRUN_FAUX_SYSTEM_ONE_DELAY_MS = "0";
  const fauxOpenrouter = new URL("../../decisions/dist/testing/faux-system-one.js", import.meta.url).pathname;
  const { api } = await serve(t, { fauxOpenrouter });
  const flow = {
    v: 2, name: "asked",
    schemas: {
      In: { type: "object", required: ["doc"], properties: { doc: { type: "string" } } },
      Verdict: { type: "object", additionalProperties: false, required: ["is_coi"], properties: { is_coi: { type: "boolean", description: "Is `doc` a certificate of incorporation?" } } },
    },
    input: { schemaId: "In" },
    output: { schemaId: "Verdict", path: "verdict" },
    root: { node: "judge", label: "ask", provider: "openrouter", model: "liquid/d1", state: { doc: "{doc}" }, out: "Verdict", as: "verdict" },
  };
  const made = await api("POST", "/agents", flowAgent("asked", flow));
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.deepEqual(made.body.warnings, []);
  const id = (await api("POST", "/agents/asked/runs", { input: { doc: "Certificate of incorporation of Acme Widgets" } })).body.run_id;
  await follow(api, id, ["completed", "failed"], { deadlineMs: 60_000 });
  const run = (await api("GET", `/runs/${id}`)).body;
  assert.equal(run.status, "completed", JSON.stringify(run.error));
  assert.equal(typeof run.result.output.is_coi, "boolean");
});
