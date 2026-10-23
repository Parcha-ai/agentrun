// `serveStore`: the serve page over an agent store, a directory of many agents, each with immutable revisions and runs.
// Everything is read through the store's reader, opened on a copy of the store's index (SQLite's backup, from a
// read-only handle, as `serveHome` copies a home), and through read-only handles on the run stores; nothing is written.
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
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
const defaultWorkflow = async (): Promise<WorkflowViews> => (await import(WORKFLOW_MODULE)) as WorkflowViews;

/** One read of the whole index: every agent, its revisions, and every run. */
export type StoreView = {
  agents: AgentRow[];
  revisions: Map<string, RevisionRow[]>;
  runs: RunRow[];
};

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
      for (const agent of agents) revisions.set(agent.id, await reader.listRevisions(agent.id));
      return { agents, revisions, runs: await reader.listRuns() };
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

const PAGE_FILES: Record<string, { file: string; type: string }> = {
  "/": { file: "store.html", type: "text/html; charset=utf-8" },
  "/page.css": { file: "page.css", type: "text/css; charset=utf-8" },
  "/page.js": { file: "page.js", type: "text/javascript; charset=utf-8" },
  "/graph.js": { file: "graph.js", type: "text/javascript; charset=utf-8" },
};

/**
 * Serve the agent store at `store.dir` on 127.0.0.1, as `serveHome` serves a home: `GET /` is the page, and
 * `GET /api/store` its agents.
 */
export async function serveStore(store: { readonly dir: string }, options: StoreServeOptions = {}): Promise<ServeHandle> {
  const dir = path.resolve(store.dir);
  if (!existsSync(path.join(dir, STORE_FILE))) throw new AgentHomeError("missing", `${path.basename(dir)} is not an agent store (no ${STORE_FILE})`);
  checkPort(options.port ?? 0);
  const read = storeReader(dir, options.openReader ?? defaultReader);
  return serveLocal(PAGE_FILES, async (pathname) => {
    if (pathname === "/api/store") {
      const view = await read();
      return { status: 200, value: { agents: view.agents.map((agent) => ({ ...agent, revisions: view.revisions.get(agent.id)?.length ?? 0 })) } };
    }
    return { status: 404, value: { error: "not found" } };
  }, "agent store", options);
}
