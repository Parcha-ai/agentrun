// `serveStore`: the serve page over an agent store, the folder of store.sqlite and runs/<run id>/. Each request opens the
// store's reader on store.sqlite in place, read-only, does its reads and closes it: nothing is copied, cached or written.
import { existsSync } from "node:fs";
import path from "node:path";
import { type AgentStoreReader, openStoreReader, type Revision, STORE_FILE } from "../agent-store.js";
import { ID_PATTERN } from "../home.js";
import { AgentHomeError } from "../store.js";
import { timelineOf } from "../timeline/index.js";
import { checkInside, readEntriesAt } from "./read.js";
import { type ServeHandle, serveLocal, type ServeOptions } from "./server.js";

export type DiffLine = { op: "same" | "add" | "del"; text: string };

/** The most line pairs the diff compares (the table's cells) once the lines both texts share at their start and end are
 *  set aside; past it the texts are not diffed. */
const MAX_CELLS = 1_000_000;

/** `after` against `before`, line by line, as their longest common subsequence keeps them: every line of both texts is in
 *  the answer once and in its order, so no word is lost. `null` when too many lines differ to compare. */
export function lineDiff(before: string, after: string): DiffLine[] | null {
  const [a, b] = [before.split("\n"), after.split("\n")];
  let [start, end] = [0, 0];
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end += 1;
  const [x, y] = [a.slice(start, a.length - end), b.slice(start, b.length - end)];
  if (x.length * y.length > MAX_CELLS) return null;
  // common[i][j]: how many lines x[i..] and y[j..] have in common.
  const common = Array.from({ length: x.length + 1 }, () => new Array<number>(y.length + 1).fill(0));
  for (let i = x.length - 1; i >= 0; i -= 1) {
    for (let j = y.length - 1; j >= 0; j -= 1) common[i]![j] = x[i] === y[j] ? common[i + 1]![j + 1]! + 1 : Math.max(common[i + 1]![j]!, common[i]![j + 1]!);
  }
  const lines: DiffLine[] = a.slice(0, start).map((text) => ({ op: "same", text }));
  let [i, j] = [0, 0];
  while (i < x.length || j < y.length) {
    if (i < x.length && j < y.length && x[i] === y[j]) {
      lines.push({ op: "same", text: x[i]! });
      [i, j] = [i + 1, j + 1];
    } else if (j === y.length || (i < x.length && common[i + 1]![j]! >= common[i]![j + 1]!)) lines.push({ op: "del", text: x[i++]! });
    else lines.push({ op: "add", text: y[j++]! });
  }
  return [...lines, ...a.slice(a.length - end).map((text): DiffLine => ({ op: "same", text }))];
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

/** A revision for the agent page, given its parent. An agentic one has its prompt diffed against an agentic parent. A
 *  workflow has its graph and, against a workflow parent, the graph's diff as the drawer's marks, both from ./workflow's
 *  revisionGraph; its workflow's JSON is not sent. */
async function revisionView(revision: Revision & { current: boolean }, parent: Revision | undefined) {
  const head = { id: revision.id, kind: revision.kind, current: revision.current, createdAt: revision.createdAt, note: revision.note, parent: revision.parent, parentKind: parent?.kind ?? null };
  if (revision.kind === "agentic") return { ...head, body: revision.body, diff: parent?.kind === "agentic" ? agenticDiff(parent, revision) : null };
  // ./workflow is loaded here, for a workflow revision only: a store of agentic revisions never loads it or the DSL.
  const { revisionGraph } = await import("../workflow.js");
  const { graph, diff } = await revisionGraph(revision, parent);
  const body = { tools: revision.body.tools, skills: revision.body.skills };
  if (!diff) return { ...head, body, graph, diff: null };
  const edited = [...diff.changed, ...diff.rewritten].map((node) => node.next);
  return { ...head, body, graph, diff: { against: revision.parent, added: diff.added.map((node) => node.path), edited, removed: diff.removed.map(({ label, kind }) => ({ label, kind })) } };
}

/** One run: its row, its agent's name and its revision's note, then what it did, read from its own store under runs/: an
 *  agentic run's timeline, or a workflow run's record. An ended run's store is read as an immutable file, so the read
 *  makes no file beside it; a running one's is read through its log. An AgentHomeError from the workflow's reader (a run
 *  this version does not read) is the one line the page shows in place of the graph. A run whose directory is gone says
 *  so. */
async function runView(dir: string, reader: AgentStoreReader, { agentName, note, ...run }: NonNullable<ReturnType<AgentStoreReader["readRun"]>>) {
  const revision = reader.readRevision(run.revision);
  const value = { run, agent: agentName, note };
  const storePath = reader.runStorePath(run.id);
  if (!existsSync(storePath)) return { ...value, gone: true };
  checkInside(dir, storePath, "store");
  if (revision.kind === "agentic") return { ...value, rows: timelineOf(readEntriesAt(dir, storePath, "store", { ended: run.endedAt !== undefined }), { settled: run.state !== "running" }) };
  try {
    // ./workflow is imported here, for a workflow run only: a store of agentic runs never loads it.
    const { readWorkflowRun } = await import("../workflow.js");
    return { ...value, workflow: await readWorkflowRun({ runId: run.id, storePath, revision, state: run.state }) };
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
export async function serveStore(store: { readonly dir: string }, options: ServeOptions = {}): Promise<ServeHandle> {
  const dir = path.resolve(store.dir);
  if (!existsSync(path.join(dir, STORE_FILE))) throw new AgentHomeError("missing", `there is no ${STORE_FILE} in that folder`);
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
        const found = reader.readAgent(id);
        if (!found) return notFound("agent");
        // A revision's parent is its own agent's, so it is in the same list.
        const byId = new Map(found.revisions.map((revision) => [revision.id, revision]));
        const revisions = [];
        for (const revision of found.revisions) revisions.push(await revisionView(revision, revision.parent === null ? undefined : byId.get(revision.parent)));
        return { status: 200, value: { agent: found.agent, revisions } };
      }
      const run = reader.readRun(id);
      return run ? { status: 200, value: await runView(dir, reader, run) } : notFound("run");
    } finally {
      reader.close();
    }
  }, "agent store", options);
}
