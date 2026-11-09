// The run READ routes over the one store (design 2.1): the functions the v2 read routes call to answer a run's files, its
// browser state, its graph and its timeline, over the store instead of a live per-run process. Each answers exactly what the
// route answers today — the same status codes, words and shapes. A run's files are read through the run's Workspace
// (workspace/, not a run directory the server owns); its browser state and its timeline read the run's launch, revision and
// journal. The live halves (a run's open browser viewer, the timeline's live stream) read the runner's live state through
// the store (live/stream.ts watchRun) and the viewer handover, which the runner publishes.
import type { Context } from "@earendil-works/chord";
import type { IncomingMessage, ServerResponse } from "node:http";
import { ApiError } from "./errors.js";
import { runGraph } from "./graph-view.js";
import { checkedPath, decodedPath } from "./home-path.js";
import { costOf, WITHHELD_SIGN_IN } from "./run-view.js";
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
  /** A context for the journal reads (graph, timeline). */
  readonly context: Context;
}

/** A run's files, through its Workspace (listRunFiles): every file, path-sorted, cut at the cap. A run with no folder lists
 *  none. The same shape the route answered. */
export async function listRunFiles(store: RunReadsStore, runId: string, deps: RunReadsDeps): Promise<{ run_id: string; files: FileView[]; complete: true; truncated: boolean }> {
  const workspace = await deps.runWorkspace(store, runId);
  const { files, deep } = workspace ? await listFiles(workspace, FILE_LIST_CAP) : { files: [] as FileView[], deep: false };
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { run_id: runId, files: files.slice(0, FILE_LIST_CAP), complete: true, truncated: deep || files.length > FILE_LIST_CAP };
}

/** One of a run's files, through its Workspace (readRunFile): streamed to `res` as the route streams it, with the route's
 *  path check and its 404 words. */
export async function readRunFile(store: RunReadsStore, runId: string, rawPath: string, req: IncomingMessage, res: ServerResponse, url: URL, deps: RunReadsDeps): Promise<void> {
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
  return runGraph({
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
  });
}
