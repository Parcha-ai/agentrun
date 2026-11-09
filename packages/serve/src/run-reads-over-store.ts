// The run READ routes over the one store (design 2.1): the functions the v2 read routes call to answer a run's files, its
// browser state, its graph and its timeline, over the store instead of a live per-run process. Each answers exactly what the
// route answers today — the same status codes, words and shapes. A run's files are read through the run's Workspace
// (workspace/, not a run directory the server owns); its browser state and its timeline read the run's launch, revision and
// journal. The live halves (a run's open browser viewer, the timeline's live stream) read the runner's live state through
// the store (live/stream.ts watchRun) and the viewer handover, which the runner publishes.
import type { Context } from "@earendil-works/chord";
import type { TimelineEvent } from "@parcha/pi-durable-agent/timeline";
import type { IncomingMessage, ServerResponse } from "node:http";
import { ApiError } from "./errors.js";
import { GRAPH_CACHE_BYTES, PartCache, servedGraphView } from "./graph-served.js";
import { runGraph } from "./graph-view.js";
import { checkedPath, decodedPath } from "./home-path.js";
import { costOf, WITHHELD_SIGN_IN } from "./run-view.js";
import { ChangeClock, type Page, RowLog } from "./rows.js";
import { listFiles, sendFile, type FileView } from "./run-files.js";
import { readLaunchBody } from "./run-launch.js";
import { runTimeline } from "./store-reads/journal.js";
import { StoreLaunchMissing, type Store } from "./store/index.js";
import { isUnavailable, type Plane, recheckPlane, whyUnavailable } from "./tool-plane.js";
import type { Workspace } from "./workspace/index.js";

/** The most files a list answers with (server.ts FILE_LIST_CAP). */
export const FILE_LIST_CAP = 2_000;

/** The store slice these reads need. */
export type RunReadsStore = Pick<Store, "runs" | "agents">;

/** What the run read routes need beyond the store: the run's Workspace for a server-side read (Mode 1 local, Mode 2 Archil
 *  read, or null when the run has no folder), the environment the plane re-check reads, and the run's open browser viewer
 *  when its runner serves one. The switch wires the server's own. */
export interface RunReadsDeps {
  /** The run's Workspace for a server-side read (not the runner's claim-time openRunWorkspace): null when it has no folder
   *  (an imported run never has one). */
  runWorkspace(store: RunReadsStore, runId: string): Promise<Workspace | null>;
  /** The environment the plane re-check reads (tool-plane.ts recheckPlane): the server's keys as it holds them. */
  readonly env: NodeJS.ProcessEnv;
  /** The run's open live browser viewer, when its runner serves one (its link), or undefined. The runner publishes the
   *  viewer handover to the store; until that lands, the switch leaves this unset and the live branch is never taken. */
  liveViewer?(runId: string): Promise<{ viewer: string } | undefined>;
  /** The run's v2 view as the store serves it (viewOverStore): its status, kind, revision and times, for the graph. */
  runView(store: RunReadsStore, runId: string): Promise<Record<string, unknown> | undefined>;
  /** Whether the run's served output is withheld: its browser sign-in can't be read, so nothing it said is shown
   *  (store-view's `unshown`). The graph refuses when it is, as the route did. */
  withheld(store: RunReadsStore, runId: string): Promise<boolean>;
  /** The run's one cut (run-cut.ts runCutValues): the values everything served of it is cut of, its graph's parts among
   *  them, or `unreadable` when it is withheld. */
  cutValues(store: RunReadsStore, runId: string): Promise<{ values: string[] } | "unreadable">;
  /** A context for the journal reads (graph, timeline). */
  readonly context: Context;
}

/** A run's files, through its Workspace (listRunFiles): every file, path-sorted, cut at the cap. A run with no folder lists
 *  none; a run whose output is withheld refuses (403), as its graph does. The same shape the route answered. */
export async function listRunFiles(store: RunReadsStore, runId: string, deps: RunReadsDeps): Promise<{ run_id: string; files: FileView[]; complete: true; truncated: boolean }> {
  // Withheld (its browser sign-in this server can't read) refuses its files too, before any is read: a page it saved signed
  // in is what it saw (store-view's `unshown`), as the graph refuses and the base's filesShown did.
  if (await deps.withheld(store, runId)) throw new ApiError("forbidden", WITHHELD_SIGN_IN);
  const workspace = await deps.runWorkspace(store, runId);
  const { files, deep } = workspace ? await listFiles(workspace, FILE_LIST_CAP) : { files: [] as FileView[], deep: false };
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { run_id: runId, files: files.slice(0, FILE_LIST_CAP), complete: true, truncated: deep || files.length > FILE_LIST_CAP };
}

/** One of a run's files, through its Workspace (readRunFile): streamed to `res` as the route streams it, with the route's
 *  path check and its 404 words; a withheld run refuses (403) before anything is streamed. */
export async function readRunFile(store: RunReadsStore, runId: string, rawPath: string, req: IncomingMessage, res: ServerResponse, url: URL, deps: RunReadsDeps): Promise<void> {
  if (await deps.withheld(store, runId)) throw new ApiError("forbidden", WITHHELD_SIGN_IN);
  const rel = checkedPath(decodedPath(rawPath), "the run's own, not a file it wrote");
  const workspace = await deps.runWorkspace(store, runId);
  if (!workspace) throw new ApiError("not_found", "no such file");
  return sendFile(req, res, url, workspace, rel, "a tool in the run's box");
}

/** Whether the run's revision grants the browser tool: an agentic revision whose tools name it. */
async function grantsBrowser(store: RunReadsStore, revisionId: string): Promise<boolean> {
  const revision = await store.agents.revision(revisionId);
  const body = revision?.body as { tools?: unknown } | undefined;
  return revision?.kind === "agentic" && Array.isArray(body?.tools) && body.tools.includes("browser");
}

/** A run's browser state (getRunBrowser): `live` with its viewer's link when its runner serves one; else `off` with why
 *  when the run has no browser or its browser is unavailable here now (the kept plane re-checked, as a launch would); else
 *  `none`. The same words and shapes the route answered. */
export async function runBrowserState(store: RunReadsStore, runId: string, deps: RunReadsDeps): Promise<{ state: "live"; viewer: string } | { state: "off"; reason: string } | { state: "none" }> {
  // The run's open viewer first, when its runner serves one (the viewer handover the runner publishes to the store).
  const live = await deps.liveViewer?.(runId);
  if (live) return { state: "live", viewer: live.viewer };
  const run = await store.runs.get(runId);
  if (!run) throw new ApiError("not_found", `There is no run ${runId}.`);
  const launch = await store.runs.launch(runId).then((row) => readLaunchBody(row.body), (error) => (error instanceof StoreLaunchMissing ? undefined : Promise.reject(error)));
  const plane = launch?.plane as Plane | undefined;
  // The run's kept browser plane, or Browserbase where its revision grants the tool and the launch named no plane (a run
  // from before the plane). None means the run has no browser.
  const kept = plane?.browser ?? ((await grantsBrowser(store, run.revisionId)) ? "browserbase" : undefined);
  const browser = kept === undefined ? undefined : recheckPlane({ browser: kept }, deps.env).browser;
  if (browser === undefined || isUnavailable(browser)) return { state: "off", reason: browser === undefined ? "this run's agent has no browser tool" : whyUnavailable(browser) };
  return { state: "none" };
}

/** Every store-path run's graph as served, part by part: one LRU by bytes across runs, as the file path's (runs.ts). */
const graphParts = new PartCache(GRAPH_CACHE_BYTES);

/** A workflow run's graph (getRunGraph): its nodes, decisions and calls, from its journal over the store (graph-view's
 *  runGraph, the store path). An agentic run has none (404, the route's words); a run whose output is withheld is refused
 *  (403 WITHHELD_SIGN_IN), as the route refused it, before anything of it is served. */
export async function runGraphView(store: Store, runId: string, deps: RunReadsDeps): Promise<Record<string, unknown>> {
  const view = await deps.runView(store, runId);
  if (!view) throw new ApiError("not_found", `There is no run ${runId}.`);
  if (view.kind !== "workflow") throw new ApiError("not_found", `the run ${runId} is an agentic run; only a workflow run has a graph`);
  if (await deps.withheld(store, runId)) throw new ApiError("forbidden", WITHHELD_SIGN_IN);
  const revision = await store.agents.revision(String(view.revision));
  const workflow = (revision?.body as { workflow?: unknown } | undefined)?.workflow;
  const status = String(view.status);
  const ended = view.ended_at !== null;
  const launch = await store.runs.launch(runId).then((row) => readLaunchBody(row.body), (error) => (error instanceof StoreLaunchMissing ? undefined : Promise.reject(error)));
  // The run's model-node cost from its rows once it ended (0 before), as the old graph read it from run.rows.
  const rows = ended ? await runTimeline(store, runId, deps.context) : [];
  // Every field it serves is cut by the run's one cut (graph-served.ts servedGraphView): its nodes, decisions and calls by
  // servedPart, and every other field (its workflow, its structure, any added later) whole.
  const cut = await deps.cutValues(store, runId);
  if (cut === "unreadable") throw new ApiError("forbidden", WITHHELD_SIGN_IN);
  return servedGraphView(await runGraph({
    run: { id: runId, agent: String(view.agent_id), revision: String(view.revision), status, paused: status === "paused", startedAt: String(view.created_at), endedAt: view.ended_at as string | null },
    ended,
    workflow,
    // No per-run store file and no run directory now: the store and a context carry the journal the graph reads.
    storeFile: "",
    root: "",
    input: launch?.input ?? {},
    modelCost: ended ? costOf(rows) : 0,
    llmRead: 0,
    store,
    context: deps.context,
  }), cut.values, graphParts);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { const t = setTimeout(resolve, Math.max(0, ms)); t.unref?.(); });

/** A run's served timeline page, byte-identical to the old route's: the change page (reset/rows/drop/next_after/unchanged/
 *  has_more) with the run's status, state, cost and whether it is final. */
export interface TimelinePage {
  readonly run_id: string;
  readonly status: string;
  readonly state: string;
  readonly reset: boolean;
  readonly rows: Page["rows"];
  readonly drop: readonly string[];
  readonly next_after: number;
  readonly unchanged: boolean;
  readonly has_more: boolean;
  readonly final: boolean;
  readonly cost: number | null;
}

/** What the timeline reader needs beyond the store: a context, the run's timeline rows and its view (status/state/cost). */
export interface TimelineDeps {
  readonly context: Context;
  /** The run's timeline rows over the store (store-reads/journal.ts runTimeline). */
  timelineRows(store: Store, runId: string, context: Context): Promise<TimelineEvent[]>;
  /** The run's view (viewOverStore), for its status, state, cost and whether it is final. */
  runView(store: Store, runId: string): Promise<Record<string, unknown> | undefined>;
  /** How often the store is re-read while a page waits (default 1000 ms, the old poll). */
  readonly pollMs?: number;
}

/** The run timeline reader over the store (getTimeline): one RowLog per run, its change numbers stable across this server's
 *  polls (as the old live run's log was across a process's life), synced from the run's journal on each read. `page` is the
 *  old route's page, byte-identical, with the long-poll wait: it returns at once when the page changed, the run is final, or
 *  `waitMs` passed; else it re-reads the journal every `pollMs` until one of those. The route frames the SSE stream around it,
 *  and the live wake can come from watchRun in place of the poll; the page itself is the same either way.
 *
 *  Not folded in here: the learning row's freshness (the old rowsNow re-read of a learning row approved or retired since) —
 *  the switch/store-view applies it to the rows, as it owns the learning view. */
export function runTimelines(deps: TimelineDeps): { page(store: Store, runId: string, after: number, waitMs: number, limit: number): Promise<TimelinePage> } {
  const clock = new ChangeClock();
  const logs = new Map<string, RowLog>();
  const logOf = (runId: string): RowLog => {
    let log = logs.get(runId);
    if (!log) logs.set(runId, (log = new RowLog(clock)));
    return log;
  };
  const pollMs = deps.pollMs ?? 1_000;

  async function once(store: Store, runId: string, after: number, limit: number): Promise<TimelinePage> {
    const [rows, view] = await Promise.all([deps.timelineRows(store, runId, deps.context), deps.runView(store, runId)]);
    if (!view) throw new ApiError("not_found", `There is no run ${runId}.`);
    const status = String(view.status);
    const state = String(view.state);
    const log = logOf(runId);
    // The run's rows as they stand now, then its status: a change to either is one more change the page carries.
    log.sync(rows);
    log.setState(`${status}:${state}`);
    const page = log.page(after, limit);
    // Final when the run is terminal and settled (the view says so with poll_after_ms 0, as the old final did).
    const final = view.poll_after_ms === 0;
    const cost = (view.cost as { usd?: number | null } | undefined)?.usd ?? null;
    return { run_id: runId, status, state, reset: page.reset, rows: page.rows, drop: page.drop, next_after: page.next_after, unchanged: page.unchanged, has_more: page.has_more, final, cost };
  }

  return {
    async page(store, runId, after, waitMs, limit) {
      const deadline = Date.now() + waitMs;
      for (;;) {
        const page = await once(store, runId, after, limit);
        if (!page.unchanged || page.final || Date.now() >= deadline) return page;
        await sleep(Math.min(pollMs, deadline - Date.now()));
      }
    },
  };
}
