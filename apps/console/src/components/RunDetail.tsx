import { useEffect, useRef, useState } from "react";
import { Composer } from "@/components/Composer";
import { NeedsYou } from "@/components/NeedsYou";
import { type RunActions, RunHeader } from "@/components/RunHeader";
import { RunError } from "@/components/RunError";
import { ArtifactViewer, RunFiles } from "@/components/RunFiles";
import { RunResult } from "@/components/RunResult";
import { Timeline, Working } from "@/components/Timeline";
import { isEscalated, type MessageFeatures, runState } from "@/lib/runState";
import { cn } from "@/lib/utils";
import { latest, pendingQuestion, viewKind } from "@/lib/viewing";
import type { Run, RunFile, TimelineRow } from "@/lib/v2";

export type RunDetailProps = {
  run: Run;
  agentName: string;
  /** The server's `features.messages` from GET /v2/capabilities: the composer offers only the modes it takes. */
  messages: MessageFeatures;
  /** Whether the run's harness steers mid-turn (`harnessSteers`): on one that does not, a working run takes a follow_up. */
  harnessSteers: boolean;
  rows: TimelineRow[];
  timelineLoading?: boolean;
  timelineUnavailable?: boolean;
  files: RunFile[];
  /** Reads a file's text (the authenticated bytes from /v2/runs/{id}/files/{path}). */
  readFile?: (file: RunFile) => Promise<string>;
  readFileBlob?: (file: RunFile) => Promise<Blob>;
  filesComplete?: boolean;
  filesTruncated?: boolean;
  filesLoading?: boolean;
  filesSupported?: boolean;
  openFile?: RunFile | null;
  actions?: RunActions;
  /** Sends a message; resolves false when it failed, so the composer keeps the draft. */
  onMessage?: (text: string) => void | boolean | Promise<void | boolean>;
  tab?: Tab;
  /** A workflow run's live graph (RunGraphView): the first tab when given. */
  graphView?: React.ReactNode;
  /** The header's cost when another source than the run record has it (a workflow run's graph totals). */
  costText?: string;
};
type Tab = "graph" | "report" | "timeline" | "files";

/** The run page: Report / Timeline / Files tabs over AgentRun Server's run, timeline and files. */
export function RunDetail({ run, agentName, messages, harnessSteers, rows, timelineLoading = false, timelineUnavailable = false, files, readFile, readFileBlob, filesComplete = true, filesTruncated = false, filesLoading = false, filesSupported = true, openFile = null, actions, onMessage, tab: initial, graphView, costText }: RunDetailProps) {
  const view = runState(run.status, run.state, run.kind, messages, harnessSteers, run.error, run.review, run);
  const [tab, setTab] = useState<Tab>(initial ?? (graphView ? "graph" : view.final && run.status === "completed" ? "report" : "timeline"));
  const [accepted, setAccepted] = useState<{ text: string; prior: Set<string> } | null>(null);
  const [open, setOpen] = useState<{ file: RunFile; text: string | null; blob?: Blob; error?: string } | null>(openFile ? { file: openFile, text: null } : null);
  const waiting = pendingQuestion(run.status, run.state, rows);
  const sent = accepted !== null && !rows.some((row) => {
    if (row.kind !== "user_message" || accepted.prior.has(row.id)) return false;
    const text = row.text ?? row.summary.replace(/^You(?: \(steer\))?:\s*/, "");
    return text === accepted.text || (text.length > 3 && text.length < accepted.text.length && text.endsWith("...") && accepted.text.startsWith(text.slice(0, -3)));
  });
  useEffect(() => { if (accepted && !sent) setAccepted(null); }, [accepted, sent]);
  const message = async (text: string) => {
    if (!onMessage) return false;
    const prior = new Set(rows.filter((row) => row.kind === "user_message").map((row) => row.id));
    const ok = await onMessage(text);
    if (ok !== false) { setAccepted({ text, prior }); setTab("timeline"); }
    return ok;
  };
  // Only the newest read lands: closing the viewer or opening another file retires a read still in flight.
  const reads = useRef(latest()).current;
  const show = async (file: RunFile) => {
    if (!filesSupported) return;
    const token = reads.begin();
    setOpen({ file, text: null });
    if (!readFile && !readFileBlob) return;
    try {
      const blob = readFileBlob ? await readFileBlob(file) : undefined;
      const kind = viewKind(file);
      const text = blob ? (["markdown", "text", "html"].includes(kind) ? await blob.text() : "") : await readFile!(file);
      if (reads.current(token)) setOpen({ file, text, blob });
    } catch (e) {
      if (reads.current(token)) setOpen({ file, text: null, error: e instanceof Error ? e.message : String(e) });
    }
  };
  const close = () => { reads.cancel(); setOpen(null); };
  // A story or a deep link can open a file on first render.
  useEffect(() => { if (filesSupported && openFile && (readFile || readFileBlob)) void show(openFile); }, [openFile, filesSupported]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!filesSupported) { close(); if (tab === "files") setTab("timeline"); } }, [filesSupported]); // eslint-disable-line react-hooks/exhaustive-deps

  const tabs: [Tab, string][] = [...(graphView ? [["graph", "Graph"] as [Tab, string]] : []), ["report", "Report"], ["timeline", "Timeline"], ...(filesSupported ? [["files", filesLoading ? "Files" : `Files ${files.length}`] as [Tab, string]] : [])];
  return (
    <div className="flex h-full min-h-0 flex-col">
      <RunHeader run={run} agentName={agentName} actions={actions} costText={costText} />
      <div className="flex border-b px-5 md:px-8" role="tablist">
        {tabs.map(([id, name]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}
            className={cn("caps -mb-px border-b-2 px-3 py-3 text-[12px]", tab === id ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground")}>
            {name}
          </button>
        ))}
      </div>
      {tab === "graph" ? <div className="min-h-0 flex-1">{graphView}</div> : <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto max-w-4xl space-y-6 px-5 py-8 md:px-8">
          {run.imported_from ? (
            <section className="border p-4" aria-label="Imported history"><p className="text-[14px] text-muted-foreground">This run was imported from {run.imported_from.source} and takes no more messages. Start a new run of the agent to continue this work.</p></section>
          ) : run.kind === "agentic" && run.archived_at && run.status === "completed" ? (
            <section className="border p-4" aria-label="Archived history"><p className="text-[14px] text-muted-foreground">Unarchive this run to send a follow-up. Its agent must also be active.</p></section>
          ) : null}
          {run.status === "failed" && run.error && <RunError error={run.error} title={isEscalated(run.status, run.error) ? "The run escalated" : undefined} />}
          {run.status === "cancelled" && (
            <section className="border border-border-strong/60 p-4"><p className="caps text-[11px] text-muted-foreground">Cancelled</p>
              <p className="mt-2 text-[14px] text-muted-foreground">This run was cancelled. It keeps what it did before; it takes no more messages.</p></section>
          )}
          {run.status === "completed" && run.review && (
            <section className="border border-warning/50 bg-warning/10 p-4" aria-label="Needs review"><p className="caps text-[11px] text-warning-text">Needs review</p>
              <p className="mt-2 text-[14px]">{run.review.reason}</p>
              <p className="mt-1 font-mono text-[12px] text-muted-foreground">{[run.review.node && `Stopped at ${run.review.node}`, run.review.kind].filter(Boolean).join(" · ")}. A person takes it from here.</p></section>
          )}
          {view.needsYou && <NeedsYou waiting={waiting} />}
          {tab === "report" && <RunResult run={run} rows={rows} />}
          {tab === "report" && !run.result && !view.final && <Working title="Writing the answer" note="The answer appears here when the run finishes. Follow it on the timeline." spin={view.live} />}
          {tab === "report" && view.final && !run.result?.final_answer && run.result?.output == null && !rows.some((r) => r.kind === "final_answer") && run.status !== "failed" && run.status !== "cancelled" && !run.review && (
            <p className="font-mono text-[13px] text-muted-foreground">This run gave no answer.</p>
          )}
          {tab === "timeline" && <Timeline rows={rows} live={view.live} loading={timelineLoading} unavailable={timelineUnavailable} />}
          {tab === "files" && <RunFiles files={files} complete={filesComplete} truncated={filesTruncated} loading={filesLoading} onOpen={show} />}
        </div>
      </div>}
      {view.canMessage && (
        <div className="border-t px-5 py-4 md:px-8"><div className="mx-auto max-w-4xl"><Composer mode={view.messageMode!} onSend={onMessage ? message : undefined} sent={sent} /></div></div>
      )}
      {open && <ArtifactViewer file={open.file} text={open.text} blob={open.blob} error={open.error} onRetry={() => void show(open.file)} onClose={close} />}
    </div>
  );
}
