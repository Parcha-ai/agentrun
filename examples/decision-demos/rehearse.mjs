// Rehearses a use case with no server and no key: the DSL interpreter runs the workflow, its decision nodes go to the
// real Jev and Parallel providers sending through the faux fetches (faux/), and its tools run here (pdf_pages with
// pdftoppm/pdftotext, fetch_page on the faux network, llm on the faux model). It prints each decision, the outcome and,
// for the document cases, the verdicts against documents/labels.json.
// Usage: node examples/decision-demos/rehearse.mjs <use-case> [input-name] [--fast]
//   --fast: DEMO_FAUX_SPEED=0, no simulated latency.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const here = new URL(".", import.meta.url).pathname;
const root = resolve(here, "../..");
const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (process.argv.includes("--fast")) process.env.DEMO_FAUX_SPEED = "0";
const cases = JSON.parse(readFileSync(`${here}use-cases.json`, "utf8"));
const [useCase, inputName = cases[args[0]]?.inputs[0]] = args;
if (!cases[useCase]) {
  console.error(`usage: node rehearse.mjs <${Object.keys(cases).join("|")}> [input] [--fast]`);
  process.exit(2);
}

const dsl = await import(`${root}/packages/dsl/dist/index.js`);
const { jevProvider } = await import(`${root}/packages/jev/dist/index.js`);
const { parallelProvider, openrouterProvider } = await import(`${root}/packages/decisions/dist/index.js`);
const fauxJev = (await import("./faux/jev.mjs")).default;
const fauxParallel = (await import("./faux/parallel.mjs")).default;
const fauxOpenRouter = (await import("./faux/openrouter.mjs")).default;
const web = (await import("./faux/web.mjs")).default();
const model = await import("./faux/model.mjs");

let workflow = JSON.parse(readFileSync(`${here}workflows/${cases[useCase].workflow}.json`, "utf8"));
const input = JSON.parse(readFileSync(`${here}inputs/${inputName}.json`, "utf8"));
const documents = `${here}documents`;
const work = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "decision-demo-"));

// A DSL without C1 does not know `images`: drop them, and the faux providers still find each document by its file name.
const stripImages = (node) => Array.isArray(node) ? node.map(stripImages) : node && typeof node === "object" ? Object.fromEntries(Object.entries(node).filter(([k]) => k !== "images").map(([k, v]) => [k, stripImages(v)])) : node;
const knowsImages = dsl.validateWorkflow(workflow).ok;
if (!knowsImages) {
  workflow = { ...workflow, root: stripImages(workflow.root) };
  console.log("(this DSL build does not take `images` yet: rehearsing without them)");
}

// ---- tools
function pdfPages({ path, maxPages = 3, dpi = 110 }) {
  const file = resolve(documents, path);
  if (!file.startsWith(`${documents}/`) || !existsSync(file)) throw new Error(`pdf_pages: no document ${path}`);
  const stem = basename(path).replace(/\.[^.]+$/, "");
  const out = join(work, "pages", stem);
  mkdirSync(out, { recursive: true });
  execFileSync("pdftoppm", ["-r", String(dpi), "-f", "1", "-l", String(maxPages), "-png", file, join(out, "p")]);
  const pngs = execFileSync("ls", [out]).toString().trim().split("\n").filter(Boolean).sort();
  const pageCount = Number(/Pages:\s+(\d+)/.exec(execFileSync("pdfinfo", [file]).toString())?.[1] ?? pngs.length);
  const text = execFileSync("pdftotext", ["-layout", file, "-"]).toString().slice(0, 20_000);
  return { name: basename(path), pageCount, pages: pngs.map((png, i) => ({ page: i + 1, image: `pages/${stem}/${png}` })), text };
}
async function fetchPage({ url }) {
  const u = new URL(url);
  try { await web.lookup(u.hostname); } catch (e) { return { ok: false, url, status: 0, title: "", text: "", links: [], error: e.message }; }
  const res = await web.fetchImpl(u);
  const html = await res.text();
  const title = /<title>(.*?)<\/title>/s.exec(html)?.[1] ?? "";
  const text = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return { ok: res.ok, url, status: res.status, title, text, links: [] };
}
async function llm({ prompt, system }) {
  const helpers = { message: (text) => ({ text }), text: (t) => t };
  const reply = await model.default({ messages: [...(system ? [{ role: "system", content: system }] : []), { role: "user", content: prompt }] }, helpers);
  const inTok = Math.ceil(((system ?? "") + prompt).length / 4); const outTok = Math.ceil(reply.text.length / 4);
  return { text: reply.text, model: "faux/demo-writer", usage: { input_tokens: inTok, output_tokens: outTok }, cost_usd: (inTok * model.cost.input + outTok * model.cost.output) / 1e6 };
}
const TOOLS = { pdf_pages: pdfPages, fetch_page: fetchPage, llm };

/** The fakes' key: a stand-in they never check, held in a name so no key literal sits beside a key field. */
const STAND_IN = "faux-not-a-key";

// ---- decision providers
const loadImage = async (ref) => ({ bytes: new Uint8Array(readFileSync(join(work, ref))), mime: "image/png" });
const openrouter = openrouterProvider({ apiKey: STAND_IN, fetch: fauxOpenRouter, takesImages: () => true });
const providers = {
  jev: jevProvider({ apiKey: STAND_IN, fetch: fauxJev }),
  parallel: parallelProvider({ apiKey: STAND_IN, fetch: fauxParallel, timeoutMs: 120_000 }),
  openrouter,
};
const runJudge = dsl.judgeFromProviders({ providers, default: "jev", loadImage });

// ---- run
const decisions = [];
const started = Date.now();
const result = await dsl.runWorkflow(workflow, input, {
  runJudge: async (params) => {
    const t0 = Date.now();
    const out = await runJudge(params);
    decisions.push({ label: params.label, item: params.item, provider: out.provider, model: out.model, cost: out.cost_usd, ms: Date.now() - t0, answers: out.answers, evidence: out.evidence?.length ?? 0 });
    return out;
  },
  runEffect: async ({ node, input: callInput }) => {
    const tool = TOOLS[node.tool];
    if (!tool) throw new Error(`no tool ${node.tool}`);
    return tool(callInput ?? {});
  },
});

const fmt = (a) => a.type === "noul" ? a.noul.toFixed(2) : a.type === "choice" ? `${a.choice}(${(a.confidence ?? 0).toFixed(2)})` : a.type;
for (const d of decisions) console.log(`${String(d.ms).padStart(5)} ms  ${d.provider.padEnd(10)} ${String(d.model).padEnd(28)} ${d.label}${d.item ? `[${d.item.index ?? JSON.stringify(d.item)}]` : ""}  ${Object.entries(d.answers).map(([k, a]) => `${k}=${fmt(a)}`).join(" ")}${d.evidence ? `  +${d.evidence} citations` : ""}`);
const cost = decisions.reduce((sum, d) => (sum === null || typeof d.cost !== "number" ? null : sum + d.cost), 0);
console.log(`\n${result.status} in ${((Date.now() - started) / 1000).toFixed(1)} s, ${decisions.length} decisions, decision cost ${cost === null ? "unknown" : `$${cost.toFixed(6)}`}`);
if (result.status === "escalated") console.log(`escalated: ${result.escalation.kind}: ${result.escalation.summary}`);

// ---- against the labels
const labels = JSON.parse(readFileSync(`${documents}/labels.json`, "utf8"));
const truth = Object.fromEntries(labels.documents.map((d) => [d.file, d]));
if (useCase === "batch-20" && result.status === "complete") {
  let right = 0;
  for (const r of result.output.reviews.filter(Boolean)) {
    const t = truth[r.document];
    // A valid document held for review is the unsure gate doing its job, not a wrong verdict.
    const ok = t.valid ? r.verdict !== "invalid" : r.verdict !== "valid";
    right += ok ? 1 : 0;
    console.log(`${!ok ? "MISS" : t.valid && r.verdict === "review" ? "held" : "ok  "} ${r.document.padEnd(42)} ${r.verdict.padEnd(8)} by ${r.decided_by.padEnd(12)} truth ${t.valid ? "valid" : t.defects.map((d) => d.kind).join("+")}`);
  }
  console.log(`${right}/${result.output.reviews.filter(Boolean).length} agree with the labels (no defective document accepted, no valid one rejected; held = a valid one sent to a person)`);
  if (process.argv.includes("--reports")) console.log(`\n${result.output.report_template}\n\n${result.output.report_llm}`);
} else if (result.status === "complete") {
  console.log(JSON.stringify(result.output, null, 2));
}
