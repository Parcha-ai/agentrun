// The run READ routes over the one store (design 2.1): the functions the v2 read routes call to answer a run's files, its
// browser state, its graph and its timeline, over the store instead of a live per-run process. Each answers exactly what the
// route answers today — the same status codes, words and shapes. A run's files are read through the run's Workspace
// (workspace/, not a run directory the server owns); its browser state and its timeline read the run's launch, revision and
// journal. The live halves (a run's open browser viewer, the timeline's live stream) read the runner's live state through
// the store (live/stream.ts watchRun) and the viewer handover, which the runner publishes.
import { type InFlight, inFlightOf, toolsInFlight } from "./in-flight.js";
import type { Context } from "@earendil-works/chord/context";
import type { TimelineEvent } from "./timeline/index.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import { ApiError } from "./errors.js";
import { GRAPH_CACHE_BYTES, PartCache, servedGraphView } from "./graph-served.js";
import { runGraph } from "./graph-view.js";
import { checkedPath, decodedPath } from "./home-path.js";
import { redactSecrets } from "./learn/secrets.js";
import { censusCut, censusDigest } from "./run-census.js";
import { type RunCut, underCut } from "./run-cut.js";
import { usageWordsOf, WITHHELD_SIGN_IN } from "./run-view.js";
import { ChangeClock, type Page, RowLog } from "./rows.js";
import { cutsAsText, entryAt, listFiles, RUN_FILE_CUT_MAX, sendFile, type FileView } from "./run-files.js";
import { typeOf } from "./file-types.js";
import { readLaunchBody } from "./run-launch.js";
import { costIsBooked } from "./runner/metrics.js";
import { runEntries, runTimeline } from "./store-reads/journal.js";
import type { RunStated } from "./store-view.js";
import { StoreLaunchMissing, type Store } from "./store/index.js";
import { isUnavailable, type Plane, recheckPlane, whyUnavailable } from "./tool-plane.js";
import { isWorkspaceError, type Workspace } from "./workspace/index.js";
import { RECORDINGS } from "./workspace/paths.js";

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
  /** The run's recordings folder on this machine, read-only (run-recordings.ts recordingsWorkspace): null when it recorded
   *  nothing. */
  recordings(store: RunReadsStore, runId: string): Promise<Workspace | null>;
  /** The environment the plane re-check reads (tool-plane.ts recheckPlane): the server's keys as it holds them. */
  readonly env: NodeJS.ProcessEnv;
  /** The run's open live browser viewer, when its runner serves one (its link), or undefined. The runner publishes the
   *  viewer handover to the store; until that lands, the switch leaves this unset and the live branch is never taken. */
  liveViewer?(runId: string): Promise<{ viewer: string } | undefined>;
  /** The run's facts (store-view.ts factsOverStore): its status, kind, revision, times and whether it is withheld, for the
   *  graph, with no word of the run served, so a graph read redacts nothing outside its own cached parts. */
  runFacts(store: RunReadsStore, runId: string): Promise<RunStated | undefined>;
  /** Whether the run's served output is withheld: its browser sign-in can't be read, so nothing it said is shown
   *  (store-view's `unshown`). The graph refuses when it is, as the route did. */
  withheld(store: RunReadsStore, runId: string): Promise<boolean>;
  /** The run's one cut (run-cut.ts runCutValues): the values everything served of it is cut of, its graph's parts among
   *  them, or `unreadable` when it is withheld. */
  cutValues(store: RunReadsStore, runId: string): Promise<RunCut>;
  /** A context for the journal reads (graph, timeline). */
  readonly context: Context;
  /** The server's seal key: a run's census names each file by a MAC under it (run-census.ts fileMac). */
  readonly sealKey: Buffer | undefined;
}

/** A run's files, through its Workspace (listRunFiles): every file, path-sorted, cut at the cap. A run with no folder lists
 *  none; a run whose output is withheld refuses (403), as its graph does. The same shape the route answered. With `cut`
 *  `run`, each file also has its `name`: its path under the run's own cut, as a cut read cuts a file's text (redactSecrets
 *  of deps.cutValues' values, read again after the names are cut: underCut), so a run that named a file by a held value
 *  (a cache keyed by a key) can be listed to a model by its names alone. Every file is named, whatever its type: a file a
 *  cut read doesn't answer (audio, an image) is one a grader is told of by its name. A run whose cut is its census's (its
 *  end erased what its caller handed it) names none. */
export async function listRunFiles(store: RunReadsStore, runId: string, deps: RunReadsDeps, cut: string | null = null): Promise<{ run_id: string; files: (FileView & { name?: string })[]; complete: true; truncated: boolean }> {
  if (cut !== null && cut !== "run") throw new ApiError("bad_request", `cut must be "run", not ${JSON.stringify(cut)}`);
  // Withheld (its browser sign-in this server can't read) refuses its files too, before any is read: a page it saved signed
  // in is what it saw (store-view's `unshown`), as the graph refuses and the base's filesShown did.
  if (await deps.withheld(store, runId)) throw new ApiError("forbidden", WITHHELD_SIGN_IN);
  const workspace = await deps.runWorkspace(store, runId);
  // A folder the run made named recordings is not listed: the route's recordings/ is the run's recordings.
  const { files, deep } = workspace ? await listFiles(workspace, FILE_LIST_CAP, { owned: (name) => name === RECORDINGS }) : { files: [] as FileView[], deep: false };
  files.sort((a, b) => a.path.localeCompare(b.path));
  const listed = files.slice(0, FILE_LIST_CAP);
  const truncated = deep || files.length > FILE_LIST_CAP;
  if (cut === null) return { run_id: runId, files: listed, complete: true, truncated };
  // Once the run's end erased what its caller handed it (censusDigest), its cut no longer holds those values: its census
  // says where they sat in each file's text, never in a name, so no file is named (a grader counts them, as from a server
  // that doesn't know `cut`).
  const named = await underCut(() => deps.cutValues(store, runId), async (held) => (held === "unreadable" ? undefined : held.censusDigest !== undefined ? listed : listed.map((file) => ({ ...file, name: redactSecrets(file.path, held.values, Buffer.byteLength(file.path)) }))));
  if (named === undefined) throw new ApiError("forbidden", WITHHELD_SIGN_IN);
  return { run_id: runId, files: named, complete: true, truncated };
}


/** One of a run's files, through its Workspace (readRunFile): streamed to `res` as the route streams it, with the route's
 *  path check and its 404 words; a withheld run refuses (403) before anything is streamed. A path under recordings/ is
 *  one of the run's recordings (its recordings folder, beside its Workspace's), never a file the run made. With
 *  `?cut=run`, the file's text under the run's own cut instead (cutRunFile). */
export async function readRunFile(store: RunReadsStore, runId: string, rawPath: string, req: IncomingMessage, res: ServerResponse, url: URL, deps: RunReadsDeps): Promise<void> {
  const cut = url.searchParams.get("cut");
  if (cut !== null && cut !== "run") throw new ApiError("bad_request", `cut must be "run", not ${JSON.stringify(cut)}`);
  if (await deps.withheld(store, runId)) throw new ApiError("forbidden", WITHHELD_SIGN_IN);
  const rel = checkedPath(decodedPath(rawPath), "the run's own, not a file it wrote");
  const recording = rel.startsWith(`${RECORDINGS}/`) ? rel.slice(RECORDINGS.length + 1) : undefined;
  const workspace = await (recording === undefined ? deps.runWorkspace : deps.recordings)(store, runId);
  if (!workspace) throw new ApiError("not_found", "no such file");
  if (cut === "run") return cutRunFile(store, runId, workspace, recording ?? rel, req, res, deps);
  return sendFile(req, res, url, workspace, recording ?? rel, "a tool in the run's box");
}

/** Why a cut read of a file of an ended run is withheld (403) when its census can't say where the secrets the run was
 *  handed sat in it (run-census.ts censusCut). */
export const WITHHELD_UNCOUNTED = "This run was handed secrets of its own, and its end erased them; this file was not counted at that end as it is now (written or changed since, past the count's limits, or the run ended with no count), so it is not shown cut. Read it raw.";

/** File `rel` of the run's `workspace` as UTF-8 text cut of everything the run's own cut holds (deps.cutValues, the set its
 *  timeline's calls are cut of: the server's keys, the keys a person saved, its secret stores' values, the sign-in refs
 *  the run was handed, and while its launch holds them what its caller handed it: its own model key, tool keys and MCP
 *  credentials), through redactSecrets over the whole text, each value and secret shape replaced by "[redacted]" in
 *  place, and the text "[redacted]" whole when a value still shows in another form. A long run with no whitespace
 *  (compact JSON) is never blanked for its length. Once an end erased what its caller handed it, the run's census says
 *  where those sat (run-census.ts censusCut): a file still as counted is cut there too, and any other is withheld (403,
 *  WITHHELD_UNCOUNTED). The cut is read again after the text is cut (underCut), so a value saved meanwhile is cut too. An unreadable cut (the run withheld) is 403; a type that isn't text, or bytes that
 *  aren't UTF-8 or hold a NUL, 415; a file over RUN_FILE_CUT_MAX, 413. A Range header is not read: the answer is the
 *  whole file. */
async function cutRunFile(store: RunReadsStore, runId: string, workspace: Workspace, rel: string, req: IncomingMessage, res: ServerResponse, deps: RunReadsDeps): Promise<void> {
  const unreadable = () => new ApiError("system_file_forbidden", "This file was created private by a tool in the run's box: this server cannot read it.", { details: { reason: "unreadable" } });
  const entry = await entryAt(workspace, rel);
  if (entry?.kind !== "file") throw new ApiError("not_found", "no such file");
  if (entry.unreadable) throw unreadable();
  const type = typeOf(rel);
  if (!cutsAsText(type)) throw new ApiError("unsupported_media_type", `a cut read answers text, and this file is ${type}`);
  if (entry.size > RUN_FILE_CUT_MAX) throw new ApiError("payload_too_large", `a cut read answers a file of at most ${RUN_FILE_CUT_MAX} bytes, and this one is ${entry.size}`);
  const bytes = entry.size === 0 ? new Uint8Array(0) : await workspace.read(rel, { offset: 0, length: entry.size }).catch((error: unknown) => {
    if (isWorkspaceError(error, "REFUSED")) throw unreadable();
    if (isWorkspaceError(error) && (error.code === "NOT_FOUND" || error.code === "ESCAPE")) throw new ApiError("not_found", "no such file");
    throw error;
  });
  let text: string;
  try {
    // A byte order mark is kept as the character it is: the text is the file's bytes, as the census counted them.
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new ApiError("unsupported_media_type", "a cut read answers UTF-8 text, and this file's bytes are not");
  }
  if (text.includes("\u0000")) throw new ApiError("unsupported_media_type", "a cut read answers text, and this file holds a NUL byte");
  const shown = await underCut(() => deps.cutValues(store, runId), async (cut): Promise<{ withheld: string } | { text: string }> => {
    if (cut === "unreadable") return { withheld: WITHHELD_SIGN_IN };
    if (cut.censusDigest === undefined) return { text: redactSecrets(text, cut.values, Buffer.byteLength(text)) };
    // The run's end erased what its caller handed it: where those sat in this file is its census's to say. Read here, the
    // one read that cuts by it; the cut names it by digest, so a census written since withholds this answer and the cut
    // read again after it (underCut) builds it anew.
    const census = await store.runs.launch(runId).then((row) => row.census, () => null);
    if (census === null || censusDigest(census) !== cut.censusDigest) return { withheld: WITHHELD_UNCOUNTED };
    const held = censusCut(census, rel, bytes, text, deps.sealKey);
    if (held === "unreadable") return { withheld: WITHHELD_UNCOUNTED };
    return { text: held === "whole" ? "[redacted]" : redactSecrets(text, cut.values, Buffer.byteLength(text), held) };
  });
  if ("withheld" in shown) throw new ApiError("forbidden", shown.withheld);
  const body = Buffer.from(shown.text);
  res.writeHead(200, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": body.length,
    "x-content-type-options": "nosniff",
    "cache-control": "no-store",
    // The mark that this answer is the cut text: a server that doesn't know `cut` serves the raw bytes, without it.
    "x-agentrun-cut": "run",
  });
  res.end(req.method === "HEAD" ? undefined : body);
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
  // The run's facts, never its served view: the view serves the run's words (its output, its title), each a redaction
  // pass on every read, and the graph needs none of them. Its own parts are redacted once per held set (servedGraphView).
  const facts = await deps.runFacts(store, runId);
  if (!facts) throw new ApiError("not_found", `There is no run ${runId}.`);
  if (facts.kind !== "workflow") throw new ApiError("not_found", `the run ${runId} is an agentic run; only a workflow run has a graph`);
  if (facts.unshown) throw new ApiError("forbidden", WITHHELD_SIGN_IN);
  const revision = await store.agents.revision(facts.revision);
  const workflow = (revision?.body as { workflow?: unknown } | undefined)?.workflow;
  const status = facts.status;
  const ended = facts.endedAt !== null;
  const launch = await store.runs.launch(runId).then((row) => readLaunchBody(row.body), (error) => (error instanceof StoreLaunchMissing ? undefined : Promise.reject(error)));
  // The run's model-node cost from its rows once it ended (0 before), as the old graph read it from run.rows: a workflow's
  // usage row is its booking's (store-reads/journal.ts bookedUsage), its model nodes', its `llm` calls' and its paid
  // tools', never its decisions', which the graph sums from their receipts. Its `llm` calls' answers are then all in it
  // (llmRead), never counted again from the node log.
  const rows = ended ? await runTimeline(store, runId, deps.context) : [];
  const booked = ended && costIsBooked(await runEntries(store, runId, deps.context), false);
  // Every field it serves is cut by the run's one cut (graph-served.ts servedGraphView): its nodes, decisions and calls by
  // servedPart, and every other field (its workflow, its structure, any added later) whole.
  const cut = await deps.cutValues(store, runId);
  if (cut === "unreadable") throw new ApiError("forbidden", WITHHELD_SIGN_IN);
  return servedGraphView(await runGraph({
    run: { id: runId, agent: facts.agentId, revision: facts.revision, status, paused: status === "paused", startedAt: facts.createdAt, endedAt: facts.endedAt },
    ended,
    workflow,
    // No run directory now: the store and a context carry the journal the graph reads.
    root: "",
    input: launch?.input ?? {},
    // Its usage row's cost in its own words (a bound with its exact part), for the graph's join; none before it ended or
    // before any request (nothing spent), unknown for a row that says nothing.
    modelCost: ended ? usageWordsOf(rows) : undefined,
    llmRead: booked ? Number.MAX_SAFE_INTEGER : 0,
    store,
    context: deps.context,
  }), cut.values, graphParts);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { const t = setTimeout(resolve, Math.max(0, ms)); t.unref?.(); });

/** A run's served timeline page: the change page (reset/rows/drop/next_after/unchanged/has_more) with the run's status,
 *  state, whether it is final, and its cost as the run view serves it. `cost` is the run's whole Cost object (usd, basis,
 *  cap_usd and the rest, as GET /runs/{id} answers), not a bare number, so the timeline page and the run read agree. */
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
  readonly cost: Record<string, unknown> | null;
  /** What the run waits on now (in-flight.ts): each model request sent and not answered, each tool call not returned, from
   *  when it was sent; empty once the run is final. */
  readonly in_flight: readonly InFlight[];
}

/** What the timeline reader needs beyond the store: a context, the run's timeline rows and its view (status/state/cost). */
export interface TimelineDeps {
  readonly context: Context;
  /** The run's timeline rows over the store (store-reads/journal.ts runTimeline); `calls`, each call's whole (TimelineOptions.calls). */
  timelineRows(store: Store, runId: string, context: Context, calls: boolean): Promise<TimelineEvent[]>;
  /** The run's view (viewOverStore), for its status, state, cost and whether it is final. */
  runView(store: Store, runId: string): Promise<Record<string, unknown> | undefined>;
  /** How often the store is re-read while a page waits (default 1000 ms, the old poll). */
  readonly pollMs?: number;
  /** The model requests a live run has in flight (in-flight.ts modelsInFlight over its journal); read only while it is
   *  not final. None: a page names its tool calls in flight alone. */
  inFlight?(store: Store, runId: string, context: Context): Promise<InFlight[]>;
}

/** The run timeline reader over the store (getTimeline): one RowLog per run, its change numbers stable across this server's
 *  polls (as the old live run's log was across a process's life), synced from the run's journal on each read. `page` is the
 *  old route's page, byte-identical, with the long-poll wait: it returns at once when the page changed, the run is final, or
 *  `waitMs` passed; else it re-reads the journal every `pollMs` until one of those. The route frames the SSE stream around it,
 *  and the live wake can come from watchRun in place of the poll; the page itself is the same either way.
 *
 *  Not folded in here: the learning row's freshness (the old rowsNow re-read of a learning row approved or retired since) —
 *  the switch/store-view applies it to the rows, as it owns the learning view. */
export function runTimelines(deps: TimelineDeps): { page(store: Store, runId: string, after: number, waitMs: number, limit: number, calls?: boolean): Promise<TimelinePage> } {
  const clock = new ChangeClock();
  // A `calls` read's rows (each call's arguments and output's head too) are another log of the run's: a cursor is its own.
  const logs = new Map<string, RowLog>();
  const logOf = (key: string): RowLog => {
    let log = logs.get(key);
    if (!log) logs.set(key, (log = new RowLog(clock)));
    return log;
  };
  const pollMs = deps.pollMs ?? 1_000;

  async function once(store: Store, runId: string, after: number, limit: number, calls: boolean): Promise<TimelinePage> {
    // The view first, then the rows, never both at once: the journal only grows, so the rows read after the view hold
    // every entry its status was read from. Read together, a message committed between the two reads gave a page that
    // said working before the message row it works on (#2307), or a waiting status with its parked call's row still
    // missing. The rows may run ahead of the status, never behind it.
    const view = await deps.runView(store, runId);
    if (!view) throw new ApiError("not_found", `There is no run ${runId}.`);
    const rows = await deps.timelineRows(store, runId, deps.context, calls);
    const status = String(view.status);
    const state = String(view.state);
    const log = logOf(calls ? `${runId}\0calls` : runId);
    // Final when the run is terminal and settled (the view says so with poll_after_ms 0, as the old final did).
    const final = view.poll_after_ms === 0;
    // What it waits on now, while it is live: a request sent or answered is a change, as a row is (GRE-4835).
    const waiting = final ? inFlightOf([], []) : inFlightOf(deps.inFlight ? await deps.inFlight(store, runId, deps.context) : [], toolsInFlight(rows));
    // The run's rows as they stand now, then its status and what it waits on: a change to any is one more change the page carries.
    log.sync(rows);
    log.setState(`${status}:${state}${waiting.key ? `:${waiting.key}` : ""}`);
    const page = log.page(after, limit);
    // The run's whole Cost object, as GET /runs/{id} serves it (store-view costOfView): the page and the run read send the
    // same shape, so a reader need not read both to price the run.
    const cost = (view.cost as Record<string, unknown> | undefined) ?? null;
    return { run_id: runId, status, state, reset: page.reset, rows: page.rows, drop: page.drop, next_after: page.next_after, unchanged: page.unchanged, has_more: page.has_more, final, cost, in_flight: waiting.list };
  }

  return {
    async page(store, runId, after, waitMs, limit, calls = false) {
      const deadline = Date.now() + waitMs;
      for (;;) {
        const page = await once(store, runId, after, limit, calls);
        if (!page.unchanged || page.final || Date.now() >= deadline) return page;
        await sleep(Math.min(pollMs, deadline - Date.now()));
      }
    },
  };
}
