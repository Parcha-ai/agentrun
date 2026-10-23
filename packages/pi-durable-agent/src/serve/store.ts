// `serveStore`: the serve page over an agent store, the folder of store.sqlite and runs/<run id>/. Each request opens the
// store's reader on store.sqlite in place, read-only, does its reads and closes it: nothing is copied, cached or written.
import { existsSync } from "node:fs";
import path from "node:path";
import { type AgentStoreReader, openStoreReader, type Revision, type RunRow, STORE_FILE } from "../agent-store.js";
import { ID_PATTERN } from "../home.js";
import { AgentHomeError } from "../store.js";
import { timelineOf } from "../timeline/index.js";
import { checkInside, readEntriesAt } from "./read.js";
import { checkPort, type ServeHandle, serveLocal, type ServeOptions } from "./server.js";

/** Reads a workflow run's record from its own store: ./workflow's, imported only when a workflow run is shown. */
export type ReadWorkflowRun = (run: { runId: string; storePath: string; revision: Revision }) => Promise<unknown>;
const readWorkflowRun: ReadWorkflowRun = async (run) => ((await import("../workflow.js")) as unknown as { readWorkflowRun: ReadWorkflowRun }).readWorkflowRun(run);

export type DiffLine = { op: "same" | "add" | "del"; text: string };

/** `after` against `before`, line by line, as their longest common subsequence keeps them: every line of both texts is in
 *  the answer once and in its order, so no word is lost. */
export function lineDiff(before: string, after: string): DiffLine[] {
  const [a, b] = [before.split("\n"), after.split("\n")];
  // common[i][j]: how many lines a[i..] and b[j..] have in common.
  const common = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) common[i]![j] = a[i] === b[j] ? common[i + 1]![j + 1]! + 1 : Math.max(common[i + 1]![j]!, common[i]![j + 1]!);
  }
  const lines: DiffLine[] = [];
  let [i, j] = [0, 0];
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      lines.push({ op: "same", text: a[i]! });
      [i, j] = [i + 1, j + 1];
    } else if (j === b.length || (i < a.length && common[i + 1]![j]! >= common[i]![j + 1]!)) lines.push({ op: "del", text: a[i++]! });
    else lines.push({ op: "add", text: b[j++]! });
  }
  return lines;
}

type AgenticFields = Record<string, unknown> & { instructions: string; tools: string[]; skills: Record<string, string> };

/** What changed from an agentic revision's agentic parent: the prompt line by line, the tools and skill paths added and
 *  removed, the skills whose sha256 changed, and the model and thinking when they changed. */
function agenticDiff(parent: Revision, revision: Revision) {
  const [was, now] = [parent.body as AgenticFields, revision.body as AgenticFields];
  const paths = [...new Set([...Object.keys(was.skills), ...Object.keys(now.skills)])].sort();
  const changed = (field: string) => (was[field] !== now[field] ? { [field]: { was: was[field] ?? null, now: now[field] ?? null } } : {});
  return {
    against: parent.id,
    prompt: lineDiff(was.instructions, now.instructions),
    tools: { added: now.tools.filter((tool) => !was.tools.includes(tool)), removed: was.tools.filter((tool) => !now.tools.includes(tool)) },
    skills: {
      added: paths.filter((file) => !(file in was.skills)),
      removed: paths.filter((file) => !(file in now.skills)),
      changed: paths.filter((file) => file in was.skills && file in now.skills && was.skills[file] !== now.skills[file]),
    },
    ...changed("model"),
    ...changed("thinking"),
  };
}

/** A revision for the agent page. An agentic one has its prompt diffed against an agentic parent. A workflow has its graph
 *  and, against a workflow parent, graphDiff's answer as the drawer's marks; its workflow's JSON is not sent. */
async function revisionView(reader: AgentStoreReader, revision: Revision, current: boolean) {
  const parent = revision.parent === null ? null : reader.readRevision(revision.parent);
  const head = { id: revision.id, kind: revision.kind, current, createdAt: revision.createdAt, note: revision.note, parent: revision.parent, parentKind: parent?.kind ?? null };
  if (revision.kind === "agentic") return { ...head, body: revision.body, diff: parent?.kind === "agentic" ? agenticDiff(parent, revision) : null };
  // The DSL is loaded here, for a workflow revision only: a store of agentic revisions never loads it.
  const { graphDiff, workflowGraph } = await import("@parcha/agentrun-dsl/graph");
  const graph = workflowGraph(revision.body.workflow);
  const body = { tools: revision.body.tools, skills: revision.body.skills };
  if (parent?.kind !== "workflow") return { ...head, body, graph, diff: null };
  const diff = graphDiff(workflowGraph(parent.body.workflow), graph);
  const edited = [...diff.changed, ...diff.rewritten].map((node) => node.next);
  return { ...head, body, graph, diff: { against: parent.id, added: diff.added.map((node) => node.path), edited, removed: diff.removed.map(({ label, kind }) => ({ label, kind })) } };
}

/** One run: its row, its agent's name and its revision's note, then what it did, read from its own store under runs/: an
 *  agentic run's timeline, or a workflow run's record. An AgentHomeError from the workflow's reader (a run this version
 *  does not read) is the one line the page shows in place of the graph. A run whose directory is gone says so. */
async function runView(dir: string, reader: AgentStoreReader, run: RunRow, readRun: ReadWorkflowRun) {
  const revision = reader.readRevision(run.revision);
  const value = { run, agent: reader.listAgents().find((agent) => agent.id === run.agent)?.name ?? run.agent, note: revision.note };
  const storePath = reader.runStorePath(run.id);
  if (!existsSync(storePath)) return { ...value, gone: true };
  checkInside(dir, storePath, "store");
  if (revision.kind === "agentic") return { ...value, rows: timelineOf(readEntriesAt(dir, storePath, "store"), { settled: run.state !== "running" }) };
  try {
    const record = (await readRun({ runId: run.id, storePath, revision })) as Record<string, unknown>;
    return { ...value, workflow: { graph: record.graph, status: record.status, outcome: record.outcome, escalatedAt: record.escalatedAt, output: record.output } };
  } catch (error) {
    if (error instanceof AgentHomeError) return { ...value, refused: error.message };
    throw error;
  }
}

const badId = { status: 400, value: { error: 'an id is not letters, digits, ".", "_" or "-"' } };
const notFound = (what: string) => ({ status: 404, value: { error: `no such ${what}` } });
const PAGES = {
  "/": { file: "store.html", type: "text/html; charset=utf-8" },
  "/page.css": { file: "page.css", type: "text/css; charset=utf-8" },
  "/page.js": { file: "page.js", type: "text/javascript; charset=utf-8" },
  "/graph.js": { file: "graph.js", type: "text/javascript; charset=utf-8" },
};

/**
 * Serve the agent store at `store.dir` on 127.0.0.1, as `serveHome` serves a home: `GET /` is the page, `GET /api/store`
 * the agents, `GET /api/agents/:id` one agent and its revisions, `GET /api/runs?agent=&revision=` the runs newest first,
 * and `GET /api/runs/:id` one run.
 */
export function serveStore(store: { readonly dir: string }, options: ServeOptions = {}): Promise<ServeHandle> {
  return serveStoreWith(store, options, readWorkflowRun);
}

/** @internal `serveStore` with the workflow run reader given, for tests. */
export async function serveStoreWith(store: { readonly dir: string }, options: ServeOptions, readRun: ReadWorkflowRun): Promise<ServeHandle> {
  const dir = path.resolve(store.dir);
  if (!existsSync(path.join(dir, STORE_FILE))) throw new AgentHomeError("missing", `${path.basename(dir)} is not an agent store (no ${STORE_FILE})`);
  checkPort(options.port ?? 0);
  return serveLocal(PAGES, async (pathname, query) => {
    const reader = openStoreReader(dir);
    try {
      if (pathname === "/api/store") return { status: 200, value: { agents: reader.listAgents() } };
      if (pathname === "/api/runs") {
        const [agent, revision] = [query.get("agent") ?? undefined, query.get("revision") ?? undefined];
        if ([agent, revision].some((id) => id !== undefined && !ID_PATTERN.test(id))) return badId;
        return { status: 200, value: reader.listRuns({ agent, revision }).map((run) => ({ ...run, gone: !existsSync(reader.runStorePath(run.id)) })) };
      }
      const [, route, id] = /^\/api\/(agents|runs)\/([^/]+)$/.exec(pathname) ?? [];
      if (id === undefined) return notFound("page");
      if (!ID_PATTERN.test(id)) return badId;
      if (route === "agents") {
        const agent = reader.listAgents().find((candidate) => candidate.id === id);
        if (!agent) return notFound("agent");
        const revisions = [];
        for (const row of reader.listRevisions(agent.id)) revisions.push(await revisionView(reader, reader.readRevision(row.id), row.current));
        return { status: 200, value: { agent, revisions } };
      }
      const run = reader.listRuns().find((candidate) => candidate.id === id);
      return run ? { status: 200, value: await runView(dir, reader, run, readRun) } : notFound("run");
    } finally {
      reader.close();
    }
  }, "agent store", options);
}
