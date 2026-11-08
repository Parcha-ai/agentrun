import { useEffect, useRef, useState } from "react";
import { useResumed } from "@/components/Connection";
import { NotHere, ProblemCard } from "@/components/Problem";
import { RunDetail } from "@/components/RunDetail";
import { RunError } from "@/components/RunError";
import { type GraphActions, GraphUnavailable, isPermanent, RunGraphView, useRunGraph } from "@/components/RunGraphView";
import { RunSkeleton } from "@/components/Skeleton";
import { type Capabilities, type Client, ClientError, follow } from "@/lib/client";
import { APPROVAL_ROW, approvalRefusal } from "@/lib/approval";
import { keeper, sendOnce } from "@/lib/idempotency";
import { problem, refusalTitle } from "@/lib/problem";
import { type HarnessRead, messageOffer, readHarness } from "@/lib/liveRun";
import { costOf, type RunGraph, usd } from "@/lib/runGraph";
import { latest } from "@/lib/viewing";
import { useLearningSettle } from "@/lib/useLearningSettle";
import type { ApiError, Run, RunFile, TimelineRow } from "@/lib/v2";

// An ended workflow run's record carries its final cost (its graph's totals agree); while it goes, only the graph has it.
const FINAL_RUN = new Set(["completed", "failed", "cancelled"]);

const graphCostText = (g: RunGraph) => { const c = costOf(g); return `${usd(c.usd)}${c.unknown ? ` + ${c.unknown} unknown` : ""}`; };

const asApiError = (e: unknown): ApiError => (e instanceof ClientError ? e.toApiError() : { code: "network", message: e instanceof Error ? e.message : String(e), retryable: true });

/** A request that failed, kept as the page shows it: the server's error, and a title in words ("refused" only for a
 *  refusal; a server away or in trouble says that instead). */
type Failure = { api: ApiError; title: string; cause: unknown };
const failure = (e: unknown): Failure => ({ api: asApiError(e), title: refusalTitle(e), cause: e });

/** A run from the live server: its record, its timeline followed from the cursor, its files, and stop, cancel and
 *  messages. A write's acceptance is not its effect: the page shows what the run and its timeline say afterwards. */
export function LiveRun({ v2, runId, caps, agentName }: { v2: Client; runId: string; caps: Capabilities | null; agentName: (id: string) => string }) {
  const [run, setRun] = useState<Run | null>(null);
  const [rows, setRows] = useState<TimelineRow[]>([]);
  const [files, setFiles] = useState<RunFile[]>([]);
  const [error, setError] = useState<Failure | null>(null);
  const [busy, setBusy] = useState<"stop" | "cancel" | "archive" | null>(null);
  const [follows, setFollows] = useState(0);

  const status = useRef<string>("");
  // Only the newest read of the run and of its files lands: an older one finishing last never puts back an old state.
  const runReads = useRef(latest()).current;
  const fileReads = useRef(latest()).current;
  const messageKeys = useRef(keeper()).current;
  const toolResults = useRef(0);
  // The approval rows as last seen (their ids and summaries): a run can wait on one call, then on the next, with its
  // status and state the same, so a change here reads the run again (its `pending` names the call that waits now).
  const approvals = useRef("");
  // The harness of the revision the run started from decides whether a message to a working run is a steer: until it
  // is known, no message is offered.
  const [harness, setHarness] = useState<HarnessRead>({ state: "loading" });
  useEffect(() => {
    if (run && harness.state === "loading") void readHarness(v2, run).then(setHarness);
  }, [run?.revision]); // eslint-disable-line react-hooks/exhaustive-deps
  const offer = messageOffer(harness, caps);
  useLearningSettle(run, () => refresh(), () => setFollows((n) => n + 1));

  const refresh = async () => {
    const n = runReads.begin();
    try {
      const [r, f] = await Promise.all([v2.getRun(runId), v2.listFiles(runId)]);
      if (runReads.current(n)) { setRun(r); setFiles(f.files); }
    } catch (e) { if (runReads.current(n)) setError(failure(e)); }
  };
  useEffect(() => { void refresh(); }, [runId]); // eslint-disable-line react-hooks/exhaustive-deps
  // Back after the server was away (a restart): the run and its files are read again, as the run may have moved on
  // meanwhile; the timeline's own read, which waited, carries on from its cursor.
  useResumed(() => { void refresh(); });
  useEffect(() => {
    const ctl = new AbortController();
    follow(v2, runId, {
      signal: ctl.signal,
      // A tool round can write files while the run stays working: re-read them when a call ends (its result row; with one
      // row per action, its own row stopping running).
      onRows: (r) => { setRows(r); const seen = r.filter((x) => x.kind === APPROVAL_ROW).map((x) => `${x.id}\u0000${x.summary}`).join("\u0001"); if (seen !== approvals.current) { approvals.current = seen; void refresh(); } const n = r.filter((x) => x.kind === "tool_result").length; if (n > toolResults.current) { toolResults.current = n; const k = fileReads.begin(); void v2.listFiles(runId).then((f) => { if (fileReads.current(k)) setFiles(f.files); }).catch(() => {}); } },
      // A page names the run's status and state: when they move, the run record (result, error, cost) and files move too.
      onPage: (p) => { const s = `${p.status}/${p.state}`; if (s !== status.current) { status.current = s; void refresh(); } },
    }).catch((e) => { if (!ctl.signal.aborted) setError(failure(e)); });
    return () => ctl.abort();
  }, [runId, follows]); // eslint-disable-line react-hooks/exhaustive-deps

  const act = async (what: "stop" | "cancel") => {
    setBusy(what);
    try { await v2[what](runId); setError(null); } catch (e) { setError(failure(e)); }
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
    } catch (e) { setError(failure(e)); }
    setBusy(null); void refresh();
  };
  // A raise is taken from its answer only by reading the run again (the pause gives way), and the timeline is followed
  // anew; a refusal goes back to the raise control, which says it there.
  const raiseCap = async (usd: number) => {
    const answer = await v2.raiseCap(runId, usd);
    await refresh(); setFollows((n) => n + 1);
    return answer;
  };
  const message = async (text: string) => {
    let ok = true;
    // The same text sent again after a lost or refused answer goes under the same key: the server never takes it twice.
    try { await sendOnce(messageKeys, runId, text, v2.sendMessage); setError(null); } catch (e) { setError(failure(e)); ok = false; }
    await refresh(); setFollows((n) => n + 1);
    return ok;
  };

  // An answer to the call the run waits on the owner's approval of: what the run does next is the server's to say, so the
  // run and its timeline are read again after it, a refused one too (a stop, a cancel or another tab answered first).
  const approve = async (approvalId: string, decision: "allow" | "deny", note?: string) => {
    let refused: string | null = null;
    try { await v2.answerApproval(runId, approvalId, decision, note); } catch (e) { refused = approvalRefusal(e); }
    await refresh(); setFollows((n) => n + 1);
    return refused;
  };

  // A workflow run's graph is read here, outside the tabs, so the header's cost (its totals) stays current whichever tab is
  // open. A server without the route gives the run's other views only.
  const graph = useRunGraph((signal) => v2.getRunGraph(runId, signal), { key: runId, enabled: run?.kind === "workflow" });
  const noGraph = !graph.data && isPermanent(graph.error);
  if (!run) {
    if (!error) return <RunSkeleton />;
    // A run this server has no record of: said so, with the runs list to find it in.
    if (error.cause instanceof ClientError && error.cause.status === 404) return <NotHere what="run" id={runId} list={{ href: "#/runs", label: "Open the runs list" }} />;
    // Try again reads the run and its files, and follows its timeline again (a failed first read ended that).
    return <ProblemCard problem={problem(error.cause, "the run")} onRetry={() => { setError(null); void refresh(); setFollows((n) => n + 1); }} />;
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      {error && <div className="border-b p-3"><RunError title={error.title} error={error.api} /></div>}
      <RunDetail key={run.run_id} run={run} agentName={agentName(run.agent_id)} messages={offer.messages} harnessSteers={offer.steers}
        graphView={run.kind === "workflow" && !noGraph ? <LiveGraph v2={v2} runId={runId} graph={graph} onMoved={() => { void refresh(); }} /> : undefined}
        costText={run.kind === "workflow" && !FINAL_RUN.has(run.status) && graph.data ? graphCostText(graph.data) : undefined}
        rows={rows} files={files} readFile={(f) => v2.readFile(runId, f.path)} readLearningDiff={() => v2.runLearningDiff(runId)} readBrowser={() => v2.runBrowser(runId)} onMessage={message} onApprove={approve}
        actions={{ onStop: () => void act("stop"), onCancel: () => void act("cancel"), onArchive: () => void archive(), onRaiseCap: raiseCap, busy }} />
    </div>
  );
}

/** A workflow run's graph from the live server, read every second while the run goes, with pause and resume. A pause
 *  or a resume shows as the server answered it until a fresh read of the graph (one made after it) says otherwise: a
 *  paused run's graph can be slow to read, and the answer's `paused` is exact. */
function LiveGraph({ v2, runId, graph, onMoved }: { v2: Client; runId: string; graph: ReturnType<typeof useRunGraph>; onMoved: () => void }) {
  const { data: read, error, readAt, reload } = graph;
  const [busy, setBusy] = useState<GraphActions["busy"]>(null);
  const [actError, setActError] = useState<Failure | null>(null);
  const [said, setSaid] = useState<{ paused: boolean; status?: string; at: number } | null>(null);
  const act = async (what: "pause" | "resume") => {
    setBusy(what);
    try {
      const r = (await (what === "pause" ? v2.pauseRun(runId) : v2.resumeRun(runId))) as { paused: boolean; status?: string };
      setSaid({ paused: r.paused, status: r.status, at: Date.now() });
      setActError(null);
    } catch (e) { setActError(failure(e)); }
    setBusy(null); reload(); onMoved();
  };
  const data = read && said && readAt < said.at ? { ...read, run: { ...read.run, paused: said.paused, ...(said.status ? { status: said.status } : {}) } } : read;
  if (!data) return <GraphUnavailable error={error} />;
  return (
    <div className="flex h-full min-h-0 flex-col">
      {actError && <div className="border-b p-3"><RunError title={actError.title} error={actError.api} /></div>}
      <div className="min-h-0 flex-1"><RunGraphView data={data} lastRead={readAt} fileUrl={(ref) => v2.fileUrl(runId, ref)} actions={{ onPause: () => void act("pause"), onResume: () => void act("resume"), busy }} /></div>
    </div>
  );
}
