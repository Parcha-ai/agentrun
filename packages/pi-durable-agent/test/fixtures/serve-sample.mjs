// A small agent home for looking at `pi-durable-agent serve`: a research agent with prompt variants, and four runs (one
// finished with a prompt chosen at 0.97, one failed, one still running with a call open, one with no entries yet), each
// with the rows a page draws. `node test/fixtures/serve-sample.mjs <dir>` builds it in <dir>/home and prints the path.
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { carryBack, createAgentHome, setPrompts, startRun } from "../../dist/index.js";

const at = (minute, second = 0) => Date.UTC(2026, 9, 22, 14, minute, second);
const user = (text, t) => ({ kind: "pi.user", model: [{ role: "user", content: text, timestamp: t }] });
const assistant = (blocks, t, stopReason = "toolUse", cost = 0.012) => ({ kind: "pi.assistant", model: [{ role: "assistant", content: blocks, stopReason, usage: { cost: { total: cost } }, timestamp: t }] });
const call = (id, name, args) => ({ type: "toolCall", id, name, arguments: args });
const result = (id, name, text, t, isError = false) => ({ kind: "pi.tool-result", model: [{ role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text }], isError, timestamp: t }] });

function append(storePath, entries) {
  const db = new DatabaseSync(storePath, { timeout: 10_000 });
  try {
    const insert = db.prepare("INSERT INTO entries (id, conversation_id, head, commit_seq, record) VALUES (?, 1, NULL, ?, ?)");
    entries.forEach((entry, index) => insert.run(index + 1, index + 1, JSON.stringify({ ...entry, id: index + 1, conversationId: 1 })));
  } finally {
    db.close();
  }
}

const research = (company, kind, minute) => [
  user(`Research ${company}.`, at(minute)),
  assistant([{ type: "thinking", thinking: `The task names ${company}. Its filings are the primary record. I will start there.` }, call("a1", "web_search", { query: `${company} ${kind}` })], at(minute, 4)),
  result("a1", "web_search", `Found 6 results for ${company}.`, at(minute, 6)),
  assistant([call("a2", "web_fetch", { url: "https://example.org/about?utm=1" }), call("a3", "web_fetch", { url: "https://example.org/investors" })], at(minute, 9)),
  result("a2", "web_fetch", "The company's own page: what it does and where it is based.", at(minute, 10)),
  result("a3", "web_fetch", "Its investor relations page: results and filings.", at(minute, 11)),
  assistant([call("a4", "write", { path: "brief.md" })], at(minute, 20)),
  result("a4", "write", "Wrote brief.md", at(minute, 21)),
  assistant([{ type: "text", text: `${company} is covered in brief.md: what it does, its size and its latest news, each cited to a page.` }], at(minute, 25), "stop"),
];

/** The sample home in `dir/home`; resolves to its path. */
export async function buildSampleHome(dir) {
  const home = await createAgentHome(path.join(dir, "home"), {
    definition: { version: 1, name: "Desk", description: "Researches one company and writes a short, cited brief.", instructions: "Research the company named in the task. Cite every fact to a page you fetched.", skills: ["research-brief"], tools: ["web_search", "web_fetch", "write", "read"], max_cost_usd: 1 },
    skills: { "research-brief/SKILL.md": "# Research brief\n\nCite every fact.\n" },
    sha: "0123456789abcdef0123456789abcdef01234567",
  });
  await setPrompts(home, [
    { id: "kind", role: "question", label: "Company kind", text: "What kind of organisation is the one named in the input?", criteria: { public: "Its shares trade on a public exchange.", nonprofit: "A charity or foundation that files an annual return.", other: "Anything else." } },
    { id: "base", role: "base", label: "Base", text: "You research one company and write a short, cited brief about it." },
    { id: "public", role: "overlay", label: "Public company", text: "Its filings are the primary record: start with EDGAR.", when: { question: "kind", option: "public", threshold: 0.8 } },
    { id: "nonprofit", role: "overlay", label: "Non-profit", text: "Its tax filings are the primary record: start with its Form 990.", when: { question: "kind", option: "nonprofit", threshold: 0.8 } },
    { id: "generic", role: "generic", label: "Generic", text: "You do not yet know what kind of organisation this is: assume nothing." },
  ]);
  const runs = [
    { id: "caterpillar", prompt: { id: "public", reason: "Jev: public at 97%, at or over 80%", confidence: 0.97 }, minute: 0, entries: research("Caterpillar Inc.", "10-K", 0), end: { outcome: "completed", cost: 0.4399 } },
    { id: "habitat", prompt: { id: "generic", reason: "Jev: nonprofit at 60%, under 80%; after the lookup, Jev: nonprofit at 53%, under 80%; so the generic prompt", confidence: 0.53 }, minute: 10, entries: research("Habitat", "organisation", 10).slice(0, 6).concat([result("a9", "web_fetch", "Error: 403 Forbidden", at(10, 40), true)]), end: { outcome: "failed", cost: 0.2473 } },
    { id: "powells", prompt: { id: "generic", reason: "Jev: small_retail at 74%, under 80%; so the generic prompt", confidence: 0.74 }, minute: 20, entries: [user("Research Powell's Books.", at(20)), assistant([{ type: "thinking", thinking: "Several shops share this name; I will say which one I chose." }, call("p1", "web_fetch", { url: "https://www.powells.com/" })], at(20, 5))] },
    { id: "cargill", prompt: { id: "generic", reason: "no overlay was sure", confidence: 0.4 }, minute: 30, entries: [] },
  ];
  for (const { id, prompt, entries, end } of runs) {
    const started = await startRun(home, { runId: id, host: "sample", prompt, now: Date.UTC(2026, 9, 22, 14, runs.find((run) => run.id === id).minute) });
    if (entries.length) append(started.storePath, entries);
    if (end) await carryBack(home, started, { ...end, now: Date.UTC(2026, 9, 22, 14, runs.find((run) => run.id === id).minute + 9) });
  }
  return home;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const dir = path.resolve(process.argv[2] ?? "");
  if (!process.argv[2]) throw new Error("usage: node test/fixtures/serve-sample.mjs <dir>");
  mkdirSync(dir, { recursive: true });
  console.log((await buildSampleHome(dir)).dir);
}
