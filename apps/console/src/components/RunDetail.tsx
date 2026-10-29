import { useEffect, useRef, useState } from "react";
import { Composer } from "@/components/Composer";
import { NeedsYou } from "@/components/NeedsYou";
import { type RunActions, RunHeader } from "@/components/RunHeader";
import { RunError } from "@/components/RunError";
import { ArtifactViewer, RunFiles } from "@/components/RunFiles";
import { RunResult } from "@/components/RunResult";
import { Timeline, Working } from "@/components/Timeline";
import { type MessageFeatures, runState } from "@/lib/runState";
import { cn } from "@/lib/utils";
import { latest, pendingQuestion } from "@/lib/viewing";
import type { Run, RunFile, RunReview, TimelineRow } from "@/lib/v2";
import { when } from "@/lib/format";

export type RunDetailProps = {
  run: Run;
  agentName: string;
  /** The server's `features.messages` from GET /v2/capabilities: the composer offers only the modes it takes. */
  messages: MessageFeatures;
  /** Whether the run's harness steers mid-turn (`harnessSteers`): on one that does not, a working run takes a follow_up. */
  harnessSteers: boolean;
  rows: TimelineRow[];
  files: RunFile[];
  /** Reads a file's text (the authenticated bytes from /v2/runs/{id}/files/{path}). */
  readFile?: (file: RunFile) => Promise<string>;
  openFile?: RunFile | null;
  actions?: RunActions;
  /** Sends a message; resolves false when it failed, so the composer keeps the draft. */
  onMessage?: (text: string) => void | boolean | Promise<void | boolean>;
  tab?: Tab;
};
type Tab = "report" | "timeline" | "files";

/** The run page: Report / Timeline / Files tabs over AgentRun Server's run, timeline and files. */
export function RunDetail({ run, agentName, messages, harnessSteers, rows, files, readFile, openFile = null, actions, onMessage, tab: initial }: RunDetailProps) {
  const view = runState(run.status, run.state, run.kind, messages, harnessSteers);
  const [tab, setTab] = useState<Tab>(initial ?? (view.final && run.status === "completed" ? "report" : "timeline"));
  const [open, setOpen] = useState<{ file: RunFile; text: string | null } | null>(openFile ? { file: openFile, text: null } : null);
  const waiting = pendingQuestion(run.status, run.state, rows);
  // Only the newest read lands: closing the viewer or opening another file retires a read still in flight.
  const reads = useRef(latest()).current;
  const show = async (file: RunFile) => {
    const token = reads.begin();
    setOpen({ file, text: null });
    if (!readFile) return;
    const text = await readFile(file);
    if (reads.current(token)) setOpen({ file, text });
  };
  const close = () => { reads.cancel(); setOpen(null); };
  // A story or a deep link can open a file on first render.
  useEffect(() => { if (openFile && readFile) void show(openFile); }, [openFile]); // eslint-disable-line react-hooks/exhaustive-deps

  const tabs: [Tab, string][] = [["report", "Report"], ["timeline", "Timeline"], ["files", `Files ${files.length}`]];
  return (
    <div className="flex h-full min-h-0 flex-col">
      <RunHeader run={run} agentName={agentName} actions={actions} />
      <div className="flex border-b px-5 md:px-8" role="tablist">
        {tabs.map(([id, name]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}
            className={cn("caps -mb-px border-b-2 px-3 py-3 text-[12px]", tab === id ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground")}>
            {name}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto max-w-4xl space-y-6 px-5 py-8 md:px-8">
          {run.status === "failed" && run.error && <RunError error={run.error} />}
          {run.status === "completed" && run.review && <ReviewNotice review={run.review} />}
          {run.status === "cancelled" && (
            <section className="border border-border-strong/60 p-4"><p className="caps text-[11px] text-muted-foreground">Cancelled</p>
              <p className="mt-2 text-[14px] text-muted-foreground">This run was cancelled. It keeps what it did before; it takes no more messages.</p></section>
          )}
          {view.needsYou && <NeedsYou waiting={waiting} />}
          {tab === "report" && <RunResult run={run} rows={rows} />}
          {tab === "report" && !run.result && !view.final && <Working title="Writing the answer" note="The answer appears here when the run finishes. Follow it on the timeline." spin={view.live} />}
          {tab === "report" && view.final && !run.result?.final_answer && !run.result?.output && !rows.some((r) => r.kind === "final_answer") && run.status !== "failed" && run.status !== "cancelled" && (
            <p className="font-mono text-[13px] text-muted-foreground">This run gave no answer.</p>
          )}
          {tab === "timeline" && <Timeline rows={rows} live={view.live} />}
          {tab === "files" && <RunFiles files={files} onOpen={show} />}
        </div>
      </div>
      {view.canMessage && (
        <div className="border-t px-5 py-4 md:px-8"><div className="mx-auto max-w-4xl"><Composer mode={view.messageMode!} onSend={onMessage} /></div></div>
      )}
      {open && <ArtifactViewer file={open.file} text={open.text} onClose={close} />}
    </div>
  );
}

/** A decision workflow sent the run's case to a person: what review it needs, the node that sent it, and why. The run is
 *  completed and takes no message; the review happens outside it. */
export function ReviewNotice({ review }: { review: RunReview }) {
  return (
    <section className="border border-warning/60 p-4" role="status">
      <p className="caps text-[11px] text-warning-text">Needs review · {review.kind}</p>
      <p className="mt-2 text-[14px]">{review.reason}</p>
      <p className="mt-2 font-mono text-[11px] text-muted-foreground">Sent for review at {review.node}, {when(review.at)}.</p>
    </section>
  );
}
