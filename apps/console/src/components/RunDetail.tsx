import { useEffect, useRef, useState } from "react";
import { ApprovalCard } from "@/components/ApprovalCard";
import { Composer } from "@/components/Composer";
import { BudgetPaused, NeedsYou } from "@/components/NeedsYou";
import { type RunActions, RunHeader } from "@/components/RunHeader";
import { RunError } from "@/components/RunError";
import { ArtifactViewer, RunFiles } from "@/components/RunFiles";
import { RunResult } from "@/components/RunResult";
import { RunChanges, useRunChanges } from "@/components/RunChanges";
import { Timeline, Working } from "@/components/Timeline";
import { APPROVAL_ROW, approvalOf } from "@/lib/approval";
import { type LearningDiff, learningSteps } from "@/lib/learning";
import { isEscalated, type MessageFeatures, type RunView, runState } from "@/lib/runState";
import { cn } from "@/lib/utils";
import { latest, pendingQuestion } from "@/lib/viewing";
import type { Run, RunFile, TimelineRow } from "@/lib/v2";

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
  /** Answers the tool call the run waits on the owner's approval of (`pending.id`): resolves with the refusal to show,
   *  in words, or null once the server took it. */
  onApprove?: (approvalId: string, decision: "allow" | "deny", note?: string) => Promise<string | null>;
  tab?: Tab;
  /** A workflow run's live graph (RunGraphView): the first tab when given. */
  graphView?: React.ReactNode;
  /** The header's cost when another source than the run record has it (a workflow run's graph totals). */
  costText?: string;
  /** Reads what the run's learning changed (GET /v2/runs/{id}/learning/diff): "What it changed", read only for a run
   *  that kept a note. */
  readLearningDiff?: () => Promise<LearningDiff>;
};
type Tab = "graph" | "report" | "timeline" | "files";

/** The message box's words while a tool call waits on an approval: a message declines the call, and the agent reads it. */
const DECLINES = { label: "Decline and say what to do instead", placeholder: "Tell the agent what to do instead...", does: "Sending it declines the waiting call; the agent reads your message." };

/** What the Report tab says while a run has no answer and has not ended: only a queued or working run is writing it. One
 *  that waits on a kind of thing this console doesn't know (its `pending.kind`, a newer server's; nothing else of it is
 *  read) waits for the person, whatever its state; one that asked a question (named so, or from a server that sends no
 *  `pending`) waits for the answer, in the box below where the server takes one from here; a stopped one (input
 *  required, idle) stopped before it wrote one, and a message continues it; a paused workflow run starts no step until
 *  it is resumed. */
function beforeAnswer(run: Pick<Run, "status" | "state" | "pending">, view: RunView): { title: string; note: string; spin: boolean } {
  const kind = (run.pending as { kind?: unknown } | null | undefined)?.kind;
  // A tool call waiting on the owner's approval: the card above answers it, and a message below declines it.
  if (run.status === "input_required" && kind === "approval") return { title: "Waiting for your approval", note: `The run continues once you answer the approval above${view.canMessage ? ", or send a message below to decline it" : ""}.`, spin: false };
  if (run.status === "input_required" && kind !== undefined && kind !== "question") return { title: "Waiting for you", note: "The run continues once you give it what it waits on.", spin: false };
  if (run.status === "input_required" && run.state === "waiting") return { title: "Waiting for your answer", note: view.messageMode === "answer" ? "The run continues when you reply below." : "The run continues once the question is answered.", spin: false };
  if (run.status === "input_required") return { title: "Stopped", note: `Stopped before it wrote an answer.${view.canMessage ? " Send a message below to continue it." : ""}`, spin: false };
  if (run.status === "paused") return { title: "Paused", note: "No new step starts until it's resumed. The answer appears here when it finishes.", spin: false };
  return { title: "Writing the answer", note: "The answer appears here when the run finishes. Follow it on the timeline.", spin: view.live };
}

/** The run page: Report / Timeline / Files tabs over AgentRun Server's run, timeline and files. */
export function RunDetail({ run, agentName, messages, harnessSteers, rows, files, readFile, openFile = null, actions, onMessage, onApprove, tab: initial, graphView, costText, readLearningDiff }: RunDetailProps) {
  // A run paused at its spend cap takes no message until its cap is raised (409 budget_reached): no composer for it.
  const budget = run.pending?.kind === "budget" ? run.pending : null;
  const state = runState(run.status, run.state, run.kind, messages, harnessSteers, run.error, run.review);
  const view = budget ? { ...state, canMessage: false, messageMode: null } : state;
  const [tab, setTab] = useState<Tab>(initial ?? (graphView ? "graph" : view.final && run.status === "completed" ? "report" : "timeline"));
  const [open, setOpen] = useState<{ file: RunFile; text: string | null } | null>(openFile ? { file: openFile, text: null } : null);
  // A tool call waiting on the owner's approval takes the question's place: an earlier question, answered, may still be
  // the newest waiting row, and is no question now.
  const approval = approvalOf(run);
  const waiting = approval ? null : pendingQuestion(run.status, run.state, rows);
  // The approval's timeline row, which follows the call's result: its step points to the card above.
  const approvalRow = approval ? rows.findLast((r) => r.kind === APPROVAL_ROW && r.tool_use_id === approval.call_id) : undefined;
  // A refused answer, in words. The run is read again after it, and when another answer, a stop or a cancel came first
  // the call no longer waits, so its card goes: the words stay here.
  const [refused, setRefused] = useState<string | null>(null);
  const approve = async (id: string, decision: "allow" | "deny", note?: string) => {
    const said = onApprove ? await onApprove(id, decision, note) : "This page can't answer an approval.";
    setRefused(said);
    return said;
  };
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
  // What the run's learning changed: read once, shown under the report and under the timeline's look-back.
  const changes = useRunChanges(run, readLearningDiff);
  // A story or a deep link can open a file on first render.
  useEffect(() => { if (openFile && readFile) void show(openFile); }, [openFile]); // eslint-disable-line react-hooks/exhaustive-deps

  const tabs: [Tab, string][] = [...(graphView ? [["graph", "Graph"] as [Tab, string]] : []), ["report", "Report"], ["timeline", "Timeline"], ["files", `Files ${files.length}`]];
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
          {!approval && refused && <p className="border border-destructive/50 px-4 py-2.5 font-mono text-[12px] text-destructive-text" role="alert">Your answer wasn't taken: {refused}</p>}
          {approval ? <ApprovalCard key={approval.id} pending={approval} onAnswer={(decision, note) => approve(approval.id, decision, note)} />
            : view.needsYou && (budget ? <BudgetPaused pending={budget} /> : <NeedsYou waiting={waiting} />)}
          {tab === "report" && <RunResult run={run} rows={rows} files={files} onOpen={show} />}
          {tab === "report" && !run.result && !view.final && <Working {...beforeAnswer(run, view)} />}
          {tab === "report" && view.final && !run.result?.final_answer && !run.result?.output && !rows.some((r) => r.kind === "final_answer") && run.status !== "failed" && run.status !== "cancelled" && !run.review && (
            <p className="font-mono text-[13px] text-muted-foreground">This run gave no answer.</p>
          )}
          {tab === "timeline" && <Timeline rows={learningSteps(rows, run.learning)} live={view.live} asking={approvalRow?.id ?? (view.needsYou && !budget ? waiting?.id : undefined)} />}
          {(tab === "report" || tab === "timeline") && changes && <RunChanges got={changes.got} retry={changes.retry} />}
          {tab === "files" && <RunFiles files={files} onOpen={show} />}
        </div>
      </div>}
      {/* While a call waits on an approval, a message declines it, as its reason: the box says so. */}
      {view.canMessage && (
        <div className="border-t px-5 py-4 md:px-8"><div className="mx-auto max-w-4xl"><Composer mode={view.messageMode!} onSend={onMessage} purpose={approval ? DECLINES : undefined} /></div></div>
      )}
      {open && <ArtifactViewer file={open.file} text={open.text} onClose={close} files={files} onOpen={show} />}
    </div>
  );
}
