// A small agent store for looking at `pi-durable-agent serve` on a store: three agents, the first with three revisions
// (A agentic with prompt A, B agentic with prompt B and parent A, C a workflow with parent B), runs in every state, one
// with no cost. The index is a stand-in for the store's reader and the workflow views a stand-in for
// @parcha/pi-durable-agent/workflow (both injected); each agent's directory is a real agent home whose runs are real run
// stores, laid out as `<store>/<agent>/runs/<run>/store/run.sqlite`. Every graph and the diff are what the DSL's
// workflowGraph and graphDiff give for the workflows below.
// `node test/fixtures/store-sample.mjs <dir>` builds it in <dir>/store and serves it, printing the address.
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { AgentHomeError, createAgentHome, startRun } from "../../dist/index.js";
import { append, assistant, call, research, result, user } from "./serve-sample.mjs";

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const iso = (day, hour, minute = 0) => new Date(Date.UTC(2026, 9, day, hour, minute)).toISOString();
const sha = (text) => createHash("sha256").update(text, "utf8").digest("hex");

export const PROMPT_A = [
  "You research one company and write a short brief about it.",
  "Start with a web search for the company's name.",
  "Read its own site and one news page.",
  "Write brief.md: what it does, its size, its latest news.",
].join("\n");
export const PROMPT_B = [
  "You research one company and write a short, cited brief about it.",
  "Start with a web search for the company's name.",
  "Read its own site, its investor or filings page, and one news page.",
  "Write brief.md: what it does, its size, its latest news.",
  "Cite every fact to a page you fetched; say so when a fact has no page.",
].join("\n");

export const BRIEF_WORKFLOW = { v: 2, name: "company-brief", root: { node: "chain", steps: [
  { node: "call", label: "Read the site", via: "tool", tool: "web_fetch", args: { url: "site" }, as: "page" },
  { node: "route", label: "Jev: public or private", valuePath: "kind", branches: {
    public: { body: { node: "call", label: "Check the filing", via: "tool", tool: "web_fetch", args: { url: "filing" }, as: "filing" } },
    private: { body: { node: "escalate", label: "No public record", when: { path: "page.public", equals: false }, kind: "review", stage: "check", summary: "Nothing public to cite for {{name}}" } },
  } },
  { node: "code", label: "Answer", code: "s => ({ final: { brief: s.filing } })" },
] } };
export const MCC_WORKFLOW_1 = { v: 2, name: "mcc", root: { node: "chain", steps: [
  { node: "call", label: "Read the site", via: "tool", tool: "web_fetch", args: { url: "site" }, as: "page" },
  { node: "pick", label: "Pick the MCC", options: "mcc", instructions: "Pick the code that fits what the site sells.", as: "mcc" },
  { node: "code", label: "Format the answer", code: "s => ({ final: s.mcc })" },
] } };
export const MCC_WORKFLOW_2 = { v: 2, name: "mcc", root: { node: "chain", steps: [
  { node: "call", label: "Read the site", via: "tool", tool: "web_fetch", args: { url: "site" }, as: "page" },
  { node: "decide", label: "Jev: a marketplace?", question: "Does the site sell other merchants' goods?", as: "market" },
  { node: "pick", label: "Pick the MCC", options: "mcc", instructions: "Pick the code that fits what the site sells; a marketplace is 5399.", as: "mcc" },
  { node: "report", label: "Answer", as: "final" },
] } };

const node = (p, kind, label, changeCheck, via) => ({ path: p, kind, label, ...(via ? { via } : {}), changeCheck });
const next = (from, to, kind = "next") => ({ from, to, kind });
const PUBLIC = "/root/steps/1/branches/public/body";
const PRIVATE = "/root/steps/1/branches/private/body";
export const BRIEF_GRAPH = {
  nodes: [node("/root", "chain", "chain", "b465cda2"), node("/root/steps/0", "call", "Read the site", "7d6025a8", "tool"), node("/root/steps/1", "route", "Jev: public or private", "9273ad6a"), node(PUBLIC, "call", "Check the filing", "7bd1ca76", "tool"), node(PRIVATE, "escalate", "No public record", "0efb2a15"), node("/root/steps/2", "code", "Answer", "d68969ce")],
  edges: [next("/root", "/root/steps/0"), next("/root/steps/0", "/root/steps/1"), next("/root/steps/1", PUBLIC, "route"), next("/root/steps/1", PRIVATE, "route"), next("/root/steps/1", "/root/steps/2")],
};
export const MCC_GRAPH_1 = {
  nodes: [node("/root", "chain", "chain", "b465cda2"), node("/root/steps/0", "call", "Read the site", "7d6025a8", "tool"), node("/root/steps/1", "pick", "Pick the MCC", "0f7e84c5"), node("/root/steps/2", "code", "Format the answer", "67280740")],
  edges: [next("/root", "/root/steps/0"), next("/root/steps/0", "/root/steps/1"), next("/root/steps/1", "/root/steps/2")],
};
export const MCC_GRAPH_2 = {
  nodes: [node("/root", "chain", "chain", "b465cda2"), node("/root/steps/0", "call", "Read the site", "7d6025a8", "tool"), node("/root/steps/1", "decide", "Jev: a marketplace?", "f2115639"), node("/root/steps/2", "pick", "Pick the MCC", "3dcd1738"), node("/root/steps/3", "report", "Answer", "fc47da69")],
  edges: [next("/root", "/root/steps/0"), next("/root/steps/0", "/root/steps/1"), next("/root/steps/1", "/root/steps/2"), next("/root/steps/2", "/root/steps/3")],
};
/** graphDiff(MCC_GRAPH_1, MCC_GRAPH_2). */
export const MCC_DIFF = {
  added: [{ path: "/root/steps/1", kind: "decide", label: "Jev: a marketplace?" }, { path: "/root/steps/3", kind: "report", label: "Answer" }],
  removed: [{ path: "/root/steps/2", kind: "code", label: "Format the answer" }],
  changed: [],
  moved: [{ prev: "/root/steps/1", next: "/root/steps/2" }],
  rewritten: [{ prev: "/root/steps/1", next: "/root/steps/2", kind: "pick", label: "Pick the MCC" }],
  edges: { added: [next("/root/steps/0", "/root/steps/1"), next("/root/steps/1", "/root/steps/2"), next("/root/steps/2", "/root/steps/3")], removed: [next("/root/steps/0", "/root/steps/1"), next("/root/steps/1", "/root/steps/2")] },
};

const SKILL_V1 = sha("# Research brief\n\nWrite what it does.\n");
const SKILL_V2 = sha("# Research brief\n\nWrite what it does, cited.\n");
const CITE = sha("# Cite\n\nEvery fact has a page.\n");

/** One revision, its id the hash of what it is, as the store names it. */
function revision(agent, parent, kind, body, createdAt, note) {
  const id = sha(JSON.stringify({ agent, parent: parent?.id ?? null, kind, body }));
  return { id, agent, parent: parent?.id ?? null, createdAt, ...(note ? { note } : {}), kind, body };
}

const A = revision("company-researcher", null, "agentic", { instructions: PROMPT_A, skills: { "research-brief/SKILL.md": SKILL_V1 }, tools: ["web_search", "web_fetch", "write"], model: "luna", thinking: "low" }, iso(21, 9), "Prompt A: the first brief");
const B = revision("company-researcher", A, "agentic", { instructions: PROMPT_B, skills: { "research-brief/SKILL.md": SKILL_V2, "cite/SKILL.md": CITE }, tools: ["web_search", "web_fetch", "write", "read"], model: "luna", thinking: "medium" }, iso(22, 10), "Prompt B: every fact cited");
const C = revision("company-researcher", B, "workflow", { workflow: BRIEF_WORKFLOW, skills: { "cite/SKILL.md": CITE }, tools: ["web_fetch"] }, iso(23, 4), "The cheap one: a workflow");
const M1 = revision("mcc-classifier", null, "workflow", { workflow: MCC_WORKFLOW_1, skills: {}, tools: ["web_fetch"] }, iso(20, 8), "First cut");
const M2 = revision("mcc-classifier", M1, "workflow", { workflow: MCC_WORKFLOW_2, skills: {}, tools: ["web_fetch"] }, iso(22, 15), "Marketplaces are 5399");
const T1 = revision("inbox-triage", null, "agentic", { instructions: "Read the inbox and sort each message into reply, file or ignore.", skills: {}, tools: ["read"] }, iso(22, 7));
export const REVISIONS = { A, B, C, M1, M2, T1 };

export const AGENTS = [
  { id: "company-researcher", name: "Company researcher", description: "Researches one company and writes a short, cited brief.", createdAt: iso(21, 9), current: C.id },
  { id: "inbox-triage", name: "Inbox triage", description: "Sorts an inbox into reply, file or ignore.", createdAt: iso(22, 7), current: T1.id },
  { id: "mcc-classifier", name: "MCC classifier", description: "Names the merchant category code a site's business falls under.", createdAt: iso(20, 8), current: M2.id },
];

const run = (id, rev, state, startedAt, more = {}) => ({ id, agent: rev.agent, revision: rev.id, kind: rev.kind, state, startedAt, ...more });
/** Newest first, as the index lists them. */
export const RUNS = [
  run("0199f3a0-c2e1-7000-8000-00000000c002", C, "escalated", iso(23, 5, 10), { endedAt: iso(23, 5, 11), costUsd: 0.018, summary: "escalated at No public record" }),
  run("0199f3a0-c2e1-7000-8000-00000000c001", C, "completed", iso(23, 4, 40), { endedAt: iso(23, 4, 41), costUsd: 0.041, summary: "Read the site → Jev: public or private → Check the filing → Answer" }),
  run("0199f1d0-0000-7000-8000-00000000d001", T1, "running", iso(23, 3, 30)),
  run("0199f0b0-b2e1-7000-8000-00000000b002", B, "completed", iso(22, 12), { endedAt: iso(22, 12, 4), summary: "Habitat for Humanity builds homes; brief.md cites its Form 990." }),
  run("0199f0b0-b2e1-7000-8000-00000000b001", B, "completed", iso(22, 11), { endedAt: iso(22, 11, 6), costUsd: 0.312, summary: "Caterpillar Inc. builds heavy machinery; brief.md cites 6 pages." }),
  run("0199f0e0-0000-7000-8000-00000000e004", M2, "stopped", iso(22, 16, 30), { endedAt: iso(22, 16, 31), summary: "Read the site" }),
  run("0199f0e0-0000-7000-8000-00000000e003", M2, "completed", iso(22, 16), { endedAt: iso(22, 16, 1), costUsd: 0.022, summary: "Read the site → Jev: a marketplace? → Pick the MCC → Answer" }),
  run("0199efa0-a2e1-7000-8000-00000000a002", A, "failed", iso(21, 11), { endedAt: iso(21, 11, 3), costUsd: 0.221, summary: "web_fetch: 403 Forbidden on the investor page" }),
  run("0199efa0-a2e1-7000-8000-00000000a001", A, "completed", iso(21, 10), { endedAt: iso(21, 10, 7), costUsd: 0.409, summary: "Caterpillar Inc. builds heavy machinery." }),
  run("0199eed0-0000-7000-8000-00000000e002", M1, "missing", iso(20, 10), { endedAt: iso(20, 10, 1), costUsd: 0.03 }),
  run("0199eed0-0000-7000-8000-00000000e001", M1, "completed", iso(20, 9), { endedAt: iso(20, 9, 1), costUsd: 0.027, summary: "Read the site → Pick the MCC → Format the answer" }),
];
export const RUN = Object.fromEntries(RUNS.map((r) => [r.id.slice(-4), r]));

const done = (paths) => Object.fromEntries(paths.map((p) => [p, "done"]));
/** What readWorkflowRun gives for each workflow run. */
export const WORKFLOW_RUNS = {
  [RUN.c001.id]: { graph: BRIEF_GRAPH, status: { ...done(["/root", "/root/steps/0", "/root/steps/1", PUBLIC, "/root/steps/2"]), [PRIVATE]: "not-run" }, outcome: "completed" },
  [RUN.c002.id]: { graph: BRIEF_GRAPH, status: { "/root": "escalated", "/root/steps/0": "done", "/root/steps/1": "escalated", [PUBLIC]: "not-run", [PRIVATE]: "escalated", "/root/steps/2": "not-run" }, outcome: "escalated", escalatedAt: { path: PRIVATE, label: "No public record" } },
  [RUN.e003.id]: { graph: MCC_GRAPH_2, status: done(["/root", "/root/steps/0", "/root/steps/1", "/root/steps/2", "/root/steps/3"]), outcome: "completed" },
  [RUN.e004.id]: { graph: MCC_GRAPH_2, status: { "/root": "working", "/root/steps/0": "done", "/root/steps/1": "working", "/root/steps/2": "not-run", "/root/steps/3": "not-run" }, outcome: "stopped" },
  [RUN.e001.id]: { graph: MCC_GRAPH_1, status: done(["/root", "/root/steps/0", "/root/steps/1", "/root/steps/2"]), outcome: "completed" },
};

const ENTRIES = {
  [RUN.a001.id]: research("Caterpillar Inc.", "10-K", 0),
  [RUN.a002.id]: research("Caterpillar Inc.", "investors", 10).slice(0, 6).concat([result("a9", "web_fetch", "Error: 403 Forbidden", Date.UTC(2026, 9, 21, 11, 2), true)]),
  [RUN.b001.id]: research("Caterpillar Inc.", "10-K", 20),
  [RUN.b002.id]: research("Habitat for Humanity", "Form 990", 30),
  [RUN.d001.id]: [user("Sort today's inbox.", Date.UTC(2026, 9, 23, 3, 30)), assistant([{ type: "thinking", thinking: "Forty messages; I will read them in date order." }, call("t1", "read", { path: "inbox/0001.eml" })], Date.UTC(2026, 9, 23, 3, 30, 4))],
};

const invalid = (what, id) => new AgentHomeError("invalid", `the ${what} id ${JSON.stringify(id)} is not letters, digits, ".", "_" or "-" (at most 128)`);
const checkId = (id, what) => {
  if (typeof id !== "string" || !ID.test(id)) throw invalid(what, id);
};

/** A stand-in for the store's reader over `dir`: the index above, the run stores in `dir`. Each open is counted. */
export function fakeReader(index = { agents: AGENTS, revisions: Object.values(REVISIONS), runs: RUNS }) {
  const opened = [];
  const open = async (dir) => {
    opened.push(dir);
    const runsOf = (agent) => index.runs.filter((r) => r.agent === agent).length;
    return {
      dir,
      async listAgents() {
        return index.agents.map((agent) => ({ ...agent, currentKind: index.revisions.find((r) => r.id === agent.current)?.kind ?? null, runs: runsOf(agent.id) }));
      },
      async listRevisions(agent) {
        checkId(agent, "agent");
        const current = index.agents.find((a) => a.id === agent)?.current;
        return index.revisions.filter((r) => r.agent === agent).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).map(({ body, ...row }) => ({ ...row, current: row.id === current }));
      },
      async readRevision(agent, id) {
        checkId(agent, "agent");
        checkId(id, "revision");
        const found = index.revisions.find((r) => r.agent === agent && r.id === id);
        if (!found) throw new AgentHomeError("missing", `the agent ${agent} has no revision ${id}`);
        return structuredClone(found);
      },
      async listRuns(filter = {}) {
        return index.runs.filter((r) => (!filter.agent || r.agent === filter.agent) && (!filter.revision || r.revision === filter.revision));
      },
      runStorePath(agent, runId) {
        checkId(agent, "agent");
        checkId(runId, "run");
        return path.join(path.resolve(dir), agent, "runs", runId, "store", "run.sqlite");
      },
    };
  };
  return { open, opened };
}

/** A stand-in for @parcha/pi-durable-agent/workflow, from the graphs and runs above, with every call it was given. */
export function fakeWorkflow({ missing } = {}) {
  const calls = [];
  const peer = () => new AgentHomeError("missing", `install ${missing} to see this workflow's graph`);
  const graphOf = (workflow) => {
    const found = [[BRIEF_WORKFLOW, BRIEF_GRAPH], [MCC_WORKFLOW_1, MCC_GRAPH_1], [MCC_WORKFLOW_2, MCC_GRAPH_2]].find(([w]) => JSON.stringify(w) === JSON.stringify(workflow));
    if (!found) throw new AgentHomeError("invalid", "the fixture knows no such workflow");
    return structuredClone(found[1]);
  };
  return {
    calls,
    views: {
      async readWorkflowGraph(workflow) {
        calls.push(["readWorkflowGraph", workflow]);
        if (missing) throw peer();
        return graphOf(workflow);
      },
      async diffWorkflowGraphs(before, after) {
        calls.push(["diffWorkflowGraphs", before, after]);
        if (missing) throw peer();
        if (JSON.stringify(before) === JSON.stringify(MCC_GRAPH_1) && JSON.stringify(after) === JSON.stringify(MCC_GRAPH_2)) return structuredClone(MCC_DIFF);
        return { added: [], removed: [], changed: [], moved: [], rewritten: [], edges: { added: [], removed: [] } };
      },
      async readWorkflowRun(input) {
        calls.push(["readWorkflowRun", input]);
        if (missing) throw peer();
        const view = WORKFLOW_RUNS[input.runId];
        if (!view) throw new AgentHomeError("missing", `the run ${input.runId} has no workflow record`);
        if (JSON.stringify(graphOf(input.revision.body.workflow)) !== JSON.stringify(view.graph)) throw new Error("the run's revision is not the fixture's");
        return structuredClone(view);
      },
    },
  };
}

/** The sample store in `dir/store`: an index file, and each agent's home with its runs' stores (none for the run whose
 *  directory is gone). Resolves to its path. */
export async function buildSampleStore(dir) {
  const root = path.join(dir, "store");
  mkdirSync(root, { recursive: true });
  const index = new DatabaseSync(path.join(root, "store.sqlite"));
  index.exec("CREATE TABLE IF NOT EXISTS sample (note TEXT)");
  index.close();
  for (const agent of AGENTS) {
    const home = await createAgentHome(path.join(root, agent.id), { definition: { version: 1, name: agent.name, instructions: "Stand-in.", skills: [], tools: [] } });
    for (const r of RUNS.filter((candidate) => candidate.agent === agent.id && candidate.state !== "missing")) {
      const started = await startRun(home, { runId: r.id, host: "sample", now: Date.parse(r.startedAt) });
      if (ENTRIES[r.id]) append(started.storePath, ENTRIES[r.id]);
    }
  }
  return root;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  if (!process.argv[2]) throw new Error("usage: node test/fixtures/store-sample.mjs <dir> [--port n]");
  const dir = path.resolve(process.argv[2]);
  mkdirSync(dir, { recursive: true });
  const root = await buildSampleStore(dir);
  const { serveStore } = await import("../../dist/serve/index.js");
  const port = process.argv[3] === "--port" ? Number(process.argv[4]) : 0;
  const served = await serveStore({ dir: root }, { port, openReader: fakeReader().open, workflow: fakeWorkflow().views });
  console.log(served.url);
}
