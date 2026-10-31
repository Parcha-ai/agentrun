// The serve pieces decision workflows call: the call tools pdf_pages and llm, code nodes behind --allow-code-nodes, the
// documents directory, and a tool failure that fails one map item. Faux model, no key, no network.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { completer } from "../dist/llm.js";
import { documentPath, MAX_PAGE_PX, pdfPages } from "../dist/pdf-pages.js";
import { flowAgent, follow, scratch, serve, withEnv } from "./support.mjs";

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

test("a workflow with code, pdf_pages and llm calls runs on a server started with code nodes allowed", async (t) => {
  const dir = await scratch(t);
  const docs = join(dir, "docs");
  await mkdir(docs);
  for (const name of ["a", "b", "c"]) pdf(join(docs, `${name}.pdf`), `Document ${name}`);
  const { api } = await serve(t, { documents: docs, allowCodeNodes: true });
  const made = await api("POST", "/agents", flowAgent("docs", docsFlow(), { tools: ["pdf_pages", "llm"] }));
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.deepEqual(made.body.warnings, []);
  const caps = (await api("GET", "/capabilities")).body;
  assert.deepEqual(caps.tools.filter((tool) => tool.call_only).map((tool) => tool.name), ["pdf_pages", "llm"]);
  const started = await api("POST", "/agents/docs/runs", { input: { documents: ["a.pdf", "b.pdf", "c.pdf"] } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  await follow(api, started.body.run_id, ["completed", "failed"], { deadlineMs: 240_000 });
  const run = (await api("GET", `/runs/${started.body.run_id}`)).body;
  assert.equal(run.status, "completed", JSON.stringify(run));
  assert.equal(run.result.output.count, 3);
  assert.equal((await api("GET", `/runs/${started.body.run_id}/files/pages/a/40/1.png`)).status, 200);
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
  const id = started.body.run_id;
  await follow(api, id, ["completed", "failed"], { deadlineMs: 120_000 });
  const run = (await api("GET", `/runs/${id}`)).body;
  assert.equal(run.status, "completed", JSON.stringify(run));
  assert.equal(run.result.output.count, 2);
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
