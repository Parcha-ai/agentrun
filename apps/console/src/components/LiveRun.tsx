import { useEffect, useRef, useState } from "react";
import { RunDetail } from "@/components/RunDetail";
import { RunError } from "@/components/RunError";
import { type GraphActions, GraphUnavailable, isPermanent, RunGraphView, useRunGraph } from "@/components/RunGraphView";
import { type Capabilities, type Client, ClientError, follow, type TimelineCheckpoint } from "@/lib/client";
import { keeper, sendOnce } from "@/lib/idempotency";
import { type HarnessRead, messageOffer, readHarness } from "@/lib/liveRun";
import { costOf, type RunGraph, usd } from "@/lib/runGraph";
import { latest } from "@/lib/viewing";
import type { ApiError, Run, RunFile, TimelineRow } from "@/lib/v2";

// An ended workflow run's record carries its final cost (its graph's totals agree); while it goes, only the graph has it.
const FINAL_RUN = new Set(["completed", "failed", "cancelled"]);

const graphCostText = (g: RunGraph) => { const c = costOf(g); return `${usd(c.usd)}${c.unknown ? ` + ${c.unknown} unknown` : ""}`; };

const asApiError = (e: unknown): ApiError => (e instanceof ClientError ? e.toApiError() : { code: "network", message: e instanceof Error ? e.message : String(e), retryable: true });

/** A run from the live server: its record, its timeline followed from the cursor, its files, and stop, cancel and
 *  messages. A write's acceptance is not its effect: the page shows what the run and its timeline say afterwards. */
export function LiveRun({ v2, runId, caps, agentName }: { v2: Client; runId: string; caps: Capabilities | null; agentName: (id: string) => string }) {
  const [run, setRun] = useState<Run | null>(null);
  const [rows, setRows] = useState<TimelineRow[]>([]);
  const [timelineRead, setTimelineRead] = useState(false);
  const [files, setFiles] = useState<RunFile[]>([]);
  const [fileState, setFileState] = useState({ complete: false, truncated: false, loading: true });
  const [disconnected, setDisconnected] = useState<ApiError | null>(null);
  const [pendingCommand, setPendingCommand] = useState<"stop" | "cancel" | null>(null);
  const checkpoint = useRef<TimelineCheckpoint>({ rows: [] }).current;
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState<"stop" | "cancel" | "archive" | null>(null);
  const [follows, setFollows] = useState(0);

  const status = useRef<string>("");
  // Only the newest read of the run and of its files lands: an older one finishing last never puts back an old state.
  const runReads = useRef(latest()).current;
  const fileReads = useRef(latest()).current;
  const messageKeys = useRef(keeper()).current;
  const toolResults = useRef(0);
  // The harness of the revision the run started from decides whether a message to a working run is a steer: until it
  // is known, no message is offered.
  const [harness, setHarness] = useState<HarnessRead>({ state: "loading" });
  useEffect(() => {
    if (run && harness.state === "loading") void readHarness(v2, run).then(setHarness);
  }, [run?.revision]); // eslint-disable-line react-hooks/exhaustive-deps
  const offer = messageOffer(harness, caps);
  const filesSupported = caps?.features.files?.read !== false;

  const refresh = async () => {
    const n = runReads.begin();
    const k = fileReads.begin();
    await Promise.all([
      v2.getRun(runId).then((r) => { if (runReads.current(n)) setRun(r); }).catch((e) => { if (runReads.current(n)) setError(asApiError(e)); }),
      filesSupported ? v2.listFiles(runId).then((f) => { if (fileReads.current(k)) { setFiles(f.files); setFileState({ complete: f.complete, truncated: f.truncated, loading: false }); } })
        .catch((e) => { if (fileReads.current(k)) { setFileState({ complete: false, truncated: false, loading: false }); setError(asApiError(e)); } })
      : Promise.resolve(),
    ]);
  };
  const reconnect = () => { setError(null); setDisconnected(null); void refresh(); setFollows((n) => n + 1); };
  useEffect(() => { if (!filesSupported) setFiles([]); void refresh(); }, [runId, filesSupported]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const ctl = new AbortController();
    follow(v2, runId, {
      signal: ctl.signal, checkpoint, waitMs: caps?.features.timeline?.long_poll === false ? 0 : 25000,
      // A tool round can write files while the run stays working: re-read them when a new tool result lands.
      onRows: (r) => { setRows(r); const n = r.filter((x) => x.kind === "tool_result").length; if (n > toolResults.current && filesSupported) { toolResults.current = n; const k = fileReads.begin(); void v2.listFiles(runId).then((f) => { if (fileReads.current(k)) { setFiles(f.files); setFileState({ complete: f.complete, truncated: f.truncated, loading: false }); } }).catch((e) => { if (fileReads.current(k)) { setFileState({ complete: false, truncated: false, loading: false }); setError(asApiError(e)); } }); } },
      // A page names the run's status and state: when they move, the run record (result, error, cost) and files move too.
      onPage: (p) => { setDisconnected(null); if (!p.has_more) setTimelineRead(true); if (p.final || (p.status === "input_required" && p.state === "idle")) setPendingCommand(null); const s = `${p.status}/${p.state}`; if (s !== status.current) { status.current = s; void refresh(); } },
    }).catch((e) => { if (!ctl.signal.aborted) setDisconnected(asApiError(e)); });
    return () => ctl.abort();
  }, [runId, follows, filesSupported, caps?.features.timeline?.long_poll]); // eslint-disable-line react-hooks/exhaustive-deps

  const act = async (what: "stop" | "cancel") => {
    setBusy(what);
    try { await v2[what](runId); setError(null); setPendingCommand(what); } catch (e) { setError(asApiError(e)); setPendingCommand(null); }
    setBusy(null); await refresh(); setFollows((n) => n + 1);
  };
  // Only the archive's own effect is taken from its answer, at once: the run may have moved on since it was read (a final
  // timeline page's read can land first). The run and its files are read again after it, and that read is the newest.
  const archive = async () => {
    if (!run) return;
    setBusy("archive");
    try {
      const r = await (run.archived_at ? v2.unarchiveRun(runId) : v2.archiveRun(runId));
      setRun((cur) => (cur ? { ...cur, archived_at: r.archived_at } : r)); setError(null);
    } catch (e) { setError(asApiError(e)); }
    setBusy(null); void refresh();
  };
  const message = async (text: string) => {
    let ok = true;
    // The same text sent again after a lost or refused answer goes under the same key: the server never takes it twice.
    try { await sendOnce(messageKeys, runId, text, v2.sendMessage); setError(null); } catch (e) { setError(asApiError(e)); ok = false; }
    await refresh(); setFollows((n) => n + 1);
    return ok;
  };

  // A workflow run's graph is read here, outside the tabs, so the header's cost (its totals) stays current whichever tab is
  // open. A server without the route gives the run's other views only.
  const graphSupported = caps?.features.runs?.graph !== false;
  const graph = useRunGraph((signal) => v2.getRunGraph(runId, signal), { key: runId, enabled: run?.kind === "workflow" && graphSupported });
  const noGraph = !graphSupported || !graph.data && isPermanent(graph.error);
  if (!run) return error || disconnected ? <div className="p-8"><RunError title="The run could not be read" error={(error ?? disconnected)!} /><button type="button" className="mt-3 border px-3 py-2" onClick={reconnect}>Reconnect</button></div> : <p className="p-8 text-center font-mono text-[13px] text-muted-foreground">Loading the run...</p>;
  return (
    <div className="flex h-full min-h-0 flex-col">
      {error && <div className="border-b p-3"><RunError title="The server refused the request" error={error} /><button type="button" className="mt-2 border px-3 py-2" onClick={reconnect}>Try again</button></div>}
      {disconnected && <div className="border-b p-3" role="alert"><p className="text-[13px] text-warning-text">Disconnected: {disconnected.message}. Showing the last received state.</p><button type="button" className="mt-2 border px-3 py-2" onClick={reconnect}>Reconnect</button></div>}
      {pendingCommand && <p className="border-b px-5 py-3 text-[13px] text-muted-foreground" role="status">{pendingCommand === "cancel" ? "Cancellation accepted. Waiting for the process to exit." : "Stop accepted. Waiting for the current turn to end."}</p>}
      <RunDetail key={run.run_id} run={run} agentName={agentName(run.agent_id)} messages={offer.messages} harnessSteers={offer.steers}
        graphView={run.kind === "workflow" && !noGraph ? <LiveGraph v2={v2} runId={runId} graph={graph} canPause={caps?.features.runs?.pause_workflow_runs !== false} onMoved={() => { void refresh(); }} /> : undefined}
        costText={run.kind === "workflow" && !FINAL_RUN.has(run.status) && graph.data ? graphCostText(graph.data) : undefined}
        rows={rows} timelineLoading={!timelineRead && !disconnected} timelineUnavailable={!timelineRead && !!disconnected} files={files} filesSupported={filesSupported} filesComplete={fileState.complete} filesTruncated={fileState.truncated} filesLoading={fileState.loading} readFileBlob={(f) => v2.readFileBlob(runId, f.path)} onMessage={message}
        actions={{ onStop: () => void act("stop"), onCancel: () => void act("cancel"), onArchive: caps?.features.archive?.runs === false ? undefined : () => void archive(), supported: { stop: caps?.features.runs?.stop, cancel: caps?.features.runs?.cancel }, busy }} />
    </div>
  );
}

/** A workflow run's graph from the live server, read every second while the run goes, with pause and resume. A pause
 *  or a resume shows as the server answered it until a fresh read of the graph (one made after it) says otherwise: a
 *  paused run's graph can be slow to read, and the answer's `paused` is exact. */
function LiveGraph({ v2, runId, graph, canPause, onMoved }: { v2: Client; runId: string; graph: ReturnType<typeof useRunGraph>; canPause: boolean; onMoved: () => void }) {
  const { data: read, error, readAt, reload } = graph;
  const [busy, setBusy] = useState<GraphActions["busy"]>(null);
  const [actError, setActError] = useState<ApiError | null>(null);
  const [said, setSaid] = useState<{ paused: boolean; status?: string; at: number } | null>(null);
  const act = async (what: "pause" | "resume") => {
    setBusy(what);
    try {
      const r = (await (what === "pause" ? v2.pauseRun(runId) : v2.resumeRun(runId))) as { paused: boolean; status?: string };
      setSaid({ paused: r.paused, status: r.status, at: Date.now() });
      setActError(null);
    } catch (e) { setActError(asApiError(e)); }
    setBusy(null); reload(); onMoved();
  };
  const data = read && said && readAt < said.at ? { ...read, run: { ...read.run, paused: said.paused, ...(said.status ? { status: said.status } : {}) } } : read;
  if (!data) return <GraphUnavailable error={error} />;
  return (
    <div className="flex h-full min-h-0 flex-col">
      {actError && <div className="border-b p-3"><RunError title="The server refused the request" error={actError} /></div>}
      <div className="min-h-0 flex-1"><RunGraphView data={data} lastRead={readAt} fileUrl={(ref) => v2.fileUrl(runId, ref)} actions={{ onPause: () => void act("pause"), onResume: () => void act("resume"), supported: canPause, busy }} /></div>
    </div>
  );
}
