// `serveStore`: the serve page over an agent store, a directory of many agents, each with immutable revisions and runs.
// Everything is read through the store's reader, opened on a copy of the store's index (SQLite's backup, from a
// read-only handle, as `serveHome` copies a home), and through read-only handles on the run stores; nothing is written.
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { ID_PATTERN } from "../home.js";
import { AgentHomeError } from "../store.js";
import { signature } from "./read.js";
import { checkPort, type ServeHandle, serveLocal, type ServeOptions } from "./server.js";

/** The store's index, beside its agents' homes. */
export const STORE_FILE = "store.sqlite";

export type RevisionKind = "agentic" | "workflow";
export type AgentRow = { id: string; name: string; description?: string; createdAt: string; current: string | null; currentKind: RevisionKind | null; runs: number; missing?: true };
export type RevisionRow = { id: string; agent: string; parent: string | null; createdAt: string; note?: string; kind: RevisionKind; current: boolean };
export type Revision = Omit<RevisionRow, "current"> & { body: Record<string, unknown> };
export type RunState = "running" | "completed" | "failed" | "stopped" | "escalated" | "missing";
export type RunRow = { id: string; agent: string; revision: string; kind: RevisionKind; state: RunState; startedAt: string; endedAt?: string; costUsd?: number; summary?: string };

/** What serve reads of a store: the reader `openStoreReader` gives. */
export type StoreReader = {
  readonly dir: string;
  listAgents(): Promise<AgentRow[]>;
  listRevisions(agent: string): Promise<RevisionRow[]>;
  readRevision(agent: string, revision: string): Promise<Revision>;
  listRuns(filter?: { agent?: string; revision?: string }): Promise<RunRow[]>;
  /** Where a run's store is, inside the reader's directory. */
  runStorePath(agent: string, runId: string): string;
  close?(): void | Promise<void>;
};

/** What serve draws a workflow with: @parcha/pi-durable-agent/workflow's functions, which reach the optional DSL peer. */
export type WorkflowViews = {
  readWorkflowGraph(workflow: unknown): unknown;
  diffWorkflowGraphs(before: unknown, after: unknown): unknown;
  readWorkflowRun(input: { runId: string; storePath: string; revision: { body: { workflow: unknown } } }): Promise<unknown>;
};

export type StoreServeOptions = ServeOptions & {
  /** Opens the store's reader on a directory holding a copy of its index; by default the package's `openStoreReader`. */
  openReader?: (dir: string) => Promise<StoreReader>;
  /** The workflow views; by default the package's workflow subpath, imported when a workflow is first drawn. */
  workflow?: WorkflowViews;
};

// The store's reader and the workflow views are imported here and nowhere else, only once a store is served.
const READER_MODULE = "../agent-store.js";
const WORKFLOW_MODULE = "../workflow.js";
const defaultReader = async (dir: string): Promise<StoreReader> => ((await import(READER_MODULE)) as { openStoreReader(dir: string): Promise<StoreReader> }).openStoreReader(dir);
const defaultWorkflow = async (): Promise<WorkflowViews> => {
  try {
    return (await import(WORKFLOW_MODULE)) as WorkflowViews;
  } catch (error) {
    throw new AgentHomeError("missing", "this build of @parcha/pi-durable-agent has no workflow views", { cause: error });
  }
};

/** One read of the whole index: every agent, its revisions and their bodies (or why one could not be read), and every
 *  run. */
export type StoreView = {
  agents: AgentRow[];
  revisions: Map<string, RevisionRow[]>;
  bodies: Map<string, Revision | AgentHomeError>;
  runs: RunRow[];
};
const bodyKey = (agent: string, revision: string) => `${agent}/${revision}`;

/** The store's index read from a copy: SQLite's backup copies it from a read-only connection into a private temporary
 *  directory, the reader reads the copy, and the directory is removed. */
async function snapshot(dir: string, openReader: (dir: string) => Promise<StoreReader>): Promise<StoreView> {
  const scratch = await mkdtemp(path.join(tmpdir(), "pi-durable-agent-serve-"));
  try {
    const source = new DatabaseSync(path.join(dir, STORE_FILE), { readOnly: true, timeout: 5_000 });
    try {
      await backup(source, path.join(scratch, STORE_FILE));
    } finally {
      source.close();
    }
    const reader = await openReader(scratch);
    try {
      const agents = await reader.listAgents();
      const revisions = new Map<string, RevisionRow[]>();
      const bodies = new Map<string, Revision | AgentHomeError>();
      for (const agent of agents) {
        const rows = await reader.listRevisions(agent.id);
        revisions.set(agent.id, rows);
        for (const row of rows) {
          // One revision that does not verify is that revision's error, not the store's.
          const body = await reader.readRevision(agent.id, row.id).catch((error: unknown) => {
            if (error instanceof AgentHomeError) return new AgentHomeError(error.code, error.message.split(scratch).join(path.basename(dir)));
            throw error;
          });
          bodies.set(bodyKey(agent.id, row.id), body);
        }
      }
      return { agents, revisions, bodies, runs: await reader.listRuns() };
    } finally {
      await reader.close?.();
    }
  } catch (error) {
    // The copy's place is no one's business: an error names the store by its directory's name.
    if (error instanceof AgentHomeError) throw new AgentHomeError(error.code, error.message.split(scratch).join(path.basename(dir)));
    throw error;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** A reader of the store at `dir`: the view as of the index's last change, re-read only when its files change. */
function storeReader(dir: string, openReader: (dir: string) => Promise<StoreReader>): () => Promise<StoreView> {
  const file = path.join(dir, STORE_FILE);
  let current: { signature: string; view: Promise<StoreView> } | undefined;
  return () => {
    const seen = signature(file);
    if (current?.signature !== seen) {
      const view = snapshot(dir, openReader);
      current = { signature: seen, view };
      view.catch(() => {
        if (current?.view === view) current = undefined;
      });
    }
    return current.view;
  };
}

export type DiffLine = { op: "same" | "add" | "del"; text: string };
/** The most cells the line diff's table may have (rows times columns); past it the two texts are one removal and one
 *  addition, still every line of each. */
const MAX_CELLS = 4_000_000;
const same = (text: string): DiffLine => ({ op: "same", text });
const del = (text: string): DiffLine => ({ op: "del", text });
const add = (text: string): DiffLine => ({ op: "add", text });

/** `after` against `before`, line by line, as their longest common subsequence keeps them: each line of either text is in
 *  the answer once and in its order, so no word is lost; a line both keep is `same`. */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let [endA, endB] = [a.length, b.length];
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) [endA, endB] = [endA - 1, endB - 1];
  const [x, y] = [a.slice(start, endA), b.slice(start, endB)];
  const middle: DiffLine[] = [];
  if (x.length * y.length > MAX_CELLS) middle.push(...x.map(del), ...y.map(add));
  else {
    const width = y.length + 1;
    const common = new Uint32Array((x.length + 1) * width);
    for (let i = x.length - 1; i >= 0; i -= 1) {
      for (let j = y.length - 1; j >= 0; j -= 1) common[i * width + j] = x[i] === y[j] ? common[(i + 1) * width + j + 1]! + 1 : Math.max(common[(i + 1) * width + j]!, common[i * width + j + 1]!);
    }
    let [i, j] = [0, 0];
    while (i < x.length && j < y.length) {
      if (x[i] === y[j]) {
        middle.push(same(x[i]!));
        [i, j] = [i + 1, j + 1];
      } else if (common[(i + 1) * width + j]! >= common[i * width + j + 1]!) middle.push(del(x[i++]!));
      else middle.push(add(y[j++]!));
    }
    middle.push(...x.slice(i).map(del), ...y.slice(j).map(add));
  }
  return [...a.slice(0, start).map(same), ...middle, ...a.slice(endA).map(same)];
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const names = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
const shas = (value: unknown): Record<string, string> => (isRecord(value) ? Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string")) : {});
const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

/** What the page shows of a revision's body: its prompt, skills (path to sha256), tools, model and thinking, or, for a
 *  workflow, its skills and tools (its graph is drawn from the workflow). Nothing else of the body is sent. */
function shown(revision: Revision): Record<string, unknown> {
  const body = revision.body;
  const common = { skills: shas(body.skills), tools: names(body.tools) };
  if (revision.kind !== "agentic") return common;
  const [model, thinking] = [text(body.model), text(body.thinking)];
  return { instructions: text(body.instructions) ?? "", ...common, ...(model !== undefined ? { model } : {}), ...(thinking !== undefined ? { thinking } : {}) };
}

/** What changed from one agentic body to the next: the prompt as a line diff, tools and skills added and removed, a
 *  skill whose sha256 changed, and the model and thinking when they did. */
function agenticDiff(against: string, before: Record<string, unknown>, after: Record<string, unknown>) {
  const [toolsBefore, toolsAfter] = [names(before.tools), names(after.tools)];
  const [skillsBefore, skillsAfter] = [shas(before.skills), shas(after.skills)];
  const paths = [...new Set([...Object.keys(skillsBefore), ...Object.keys(skillsAfter)])].sort();
  const change = (field: string) => (before[field] !== after[field] ? { [field]: { was: text(before[field]) ?? null, now: text(after[field]) ?? null } } : {});
  return {
    against,
    prompt: lineDiff(text(before.instructions) ?? "", text(after.instructions) ?? ""),
    tools: { added: toolsAfter.filter((tool) => !toolsBefore.includes(tool)), removed: toolsBefore.filter((tool) => !toolsAfter.includes(tool)) },
    skills: {
      added: paths.filter((file) => !(file in skillsBefore)).map((file) => ({ path: file, sha256: skillsAfter[file]! })),
      removed: paths.filter((file) => !(file in skillsAfter)).map((file) => ({ path: file, sha256: skillsBefore[file]! })),
      changed: paths.filter((file) => file in skillsBefore && file in skillsAfter && skillsBefore[file] !== skillsAfter[file]).map((file) => ({ path: file, was: skillsBefore[file]!, now: skillsAfter[file]! })),
    },
    ...change("model"),
    ...change("thinking"),
  };
}

/** A graph as the page draws it: each node's path, kind, label, transport and change check, and each edge's ends and
 *  kind, as strings; nothing else of what the workflow views give. */
function graphShown(graph: unknown): { nodes: Record<string, string>[]; edges: Record<string, string>[] } {
  const g = isRecord(graph) ? graph : {};
  const strings = (item: Record<string, unknown>, keys: string[]) => Object.fromEntries(keys.filter((key) => typeof item[key] === "string").map((key) => [key, item[key] as string]));
  const items = (value: unknown, required: string[], keys: string[]) => (Array.isArray(value) ? value : []).filter(isRecord).filter((item) => required.every((key) => typeof item[key] === "string")).map((item) => strings(item, keys));
  return { nodes: items(g.nodes, ["path", "kind", "label"], ["path", "kind", "label", "via", "changeCheck"]), edges: items(g.edges, ["from", "to", "kind"], ["from", "to", "kind"]) };
}

/** graphDiff's answer as the drawer's marks: `added` the added nodes' paths, `edited` the changed and rewritten ones' (in
 *  the newer graph), `removed` the removed nodes by label and kind; and the paths of the nodes that moved. */
function marksOf(diff: unknown) {
  const d = isRecord(diff) ? diff : {};
  const list = (key: string) => (Array.isArray(d[key]) ? d[key] : []).filter(isRecord);
  const paths = (key: string, field: string) => list(key).map((item) => item[field]).filter((value): value is string => typeof value === "string");
  return {
    marks: {
      added: paths("added", "path"),
      edited: [...new Set([...paths("changed", "next"), ...paths("rewritten", "next")])],
      removed: list("removed").filter((item) => typeof item.label === "string" && typeof item.kind === "string").map((item) => ({ label: item.label as string, kind: item.kind as string })),
    },
    moved: paths("moved", "next"),
  };
}

/** A workflow view, or the words for why it cannot be drawn here (the DSL peer is not installed, say), never a failure
 *  of the page. */
async function drawable<T>(work: () => Promise<T>): Promise<{ value: T } | { unavailable: string }> {
  try {
    return { value: await work() };
  } catch (error) {
    if (error instanceof AgentHomeError) return { unavailable: error.message };
    throw error;
  }
}

const byNewest = (a: RunRow, b: RunRow) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
/** A run as the API gives it: the index's row, field by field. */
const runShown = (run: RunRow): RunRow => ({
  id: run.id, agent: run.agent, revision: run.revision, kind: run.kind, state: run.state, startedAt: run.startedAt,
  ...(run.endedAt !== undefined ? { endedAt: run.endedAt } : {}),
  ...(typeof run.costUsd === "number" ? { costUsd: run.costUsd } : {}),
  ...(run.summary !== undefined ? { summary: run.summary } : {}),
});

const badId = (what: string) => ({ status: 400, value: { error: `the ${what} id is not letters, digits, ".", "_" or "-"` } });
const notFound = (what: string) => ({ status: 404, value: { error: `no such ${what}` } });

/** One revision with what the page shows of its body, its parent's row, and what changed from its parent when both are
 *  of one kind: for a workflow, its graph and graphDiff's marks against its parent's. */
async function revisionView(view: StoreView, agent: string, id: string, workflow: () => Promise<WorkflowViews>) {
  const rows = view.revisions.get(agent) ?? [];
  const row = rows.find((candidate) => candidate.id === id);
  if (!row) return notFound("revision");
  const revision = view.bodies.get(bodyKey(agent, id));
  if (revision instanceof AgentHomeError || revision === undefined) throw revision ?? new AgentHomeError("missing", "the revision has no body");
  const parent = rows.find((candidate) => candidate.id === row.parent) ?? null;
  const before = parent ? view.bodies.get(bodyKey(agent, parent.id)) : undefined;
  const parentBody = before instanceof AgentHomeError ? undefined : before;
  const value = { revision: { ...row, body: shown(revision) }, parent };
  if (row.kind !== "workflow") return { status: 200, value: { ...value, diff: parentBody?.kind === "agentic" ? agenticDiff(parentBody.id, shown(parentBody), shown(revision)) : null } };
  const graph = await drawable(async () => (await workflow()).readWorkflowGraph(revision.body.workflow));
  if ("unavailable" in graph) return { status: 200, value: { ...value, graph: null, diff: null, unavailable: graph.unavailable } };
  const diff = parentBody?.kind === "workflow"
    ? await drawable(async () => {
      const views = await workflow();
      return { against: parentBody.id, ...marksOf(await views.diffWorkflowGraphs(await views.readWorkflowGraph(parentBody.body.workflow), graph.value)) };
    })
    : undefined;
  return { status: 200, value: { ...value, graph: graphShown(graph.value), diff: diff && "value" in diff ? diff.value : null } };
}

const PAGE_FILES: Record<string, { file: string; type: string }> = {
  "/": { file: "store.html", type: "text/html; charset=utf-8" },
  "/page.css": { file: "page.css", type: "text/css; charset=utf-8" },
  "/page.js": { file: "page.js", type: "text/javascript; charset=utf-8" },
  "/graph.js": { file: "graph.js", type: "text/javascript; charset=utf-8" },
};

/**
 * Serve the agent store at `store.dir` on 127.0.0.1, as `serveHome` serves a home: `GET /` is the page, `GET /api/store`
 * its agents, `GET /api/agents/:id` one agent and its revisions, `GET /api/agents/:id/revisions/:revision` one revision
 * against its parent, and `GET /api/runs?agent=&revision=` the runs, newest first.
 */
export async function serveStore(store: { readonly dir: string }, options: StoreServeOptions = {}): Promise<ServeHandle> {
  const dir = path.resolve(store.dir);
  if (!existsSync(path.join(dir, STORE_FILE))) throw new AgentHomeError("missing", `${path.basename(dir)} is not an agent store (no ${STORE_FILE})`);
  checkPort(options.port ?? 0);
  const read = storeReader(dir, options.openReader ?? defaultReader);
  let views: Promise<WorkflowViews> | undefined;
  const workflow = () => (views ??= options.workflow ? Promise.resolve(options.workflow) : defaultWorkflow());
  return serveLocal(PAGE_FILES, async (pathname, query) => {
    if (pathname === "/api/runs") {
      const filter: { agent?: string; revision?: string } = {};
      for (const key of ["agent", "revision"] as const) {
        const value = query.get(key);
        if (value === null) continue;
        if (!ID_PATTERN.test(value)) return badId(key);
        filter[key] = value;
      }
      const runs = (await read()).runs.filter((run) => (filter.agent === undefined || run.agent === filter.agent) && (filter.revision === undefined || run.revision === filter.revision));
      return { status: 200, value: [...runs].sort(byNewest).map(runShown) };
    }
    if (pathname === "/api/store") {
      const view = await read();
      return { status: 200, value: { agents: view.agents.map((agent) => ({ ...agent, revisions: view.revisions.get(agent.id)?.length ?? 0 })) } };
    }
    const match = /^\/api\/agents\/([^/]+)(?:\/revisions\/([^/]+))?$/.exec(pathname);
    if (match) {
      const [, agentId, revisionId] = match as unknown as [string, string, string | undefined];
      if (!ID_PATTERN.test(agentId)) return badId("agent");
      if (revisionId !== undefined && !ID_PATTERN.test(revisionId)) return badId("revision");
      const view = await read();
      const agent = view.agents.find((candidate) => candidate.id === agentId);
      if (!agent) return notFound("agent");
      if (revisionId !== undefined) return revisionView(view, agentId, revisionId, workflow);
      const revisions = (view.revisions.get(agentId) ?? []).map((row) => ({ ...row, runs: view.runs.filter((run) => run.agent === agentId && run.revision === row.id).length }));
      return { status: 200, value: { agent: { ...agent, revisions: revisions.length }, revisions } };
    }
    return { status: 404, value: { error: "not found" } };
  }, "agent store", options);
}
