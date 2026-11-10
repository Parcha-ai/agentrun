import { useEffect, useRef, useState } from "react";
import { ApprovalCard } from "@/components/ApprovalCard";
import { Composer } from "@/components/Composer";
import { BudgetPaused, capWords, leastCap, NeedsYou, RaiseCap, suggestedCap } from "@/components/NeedsYou";
import { type RunActions, RunHeader } from "@/components/RunHeader";
import { RunError } from "@/components/RunError";
import { ArtifactViewer, RunFiles } from "@/components/RunFiles";
import { RunResult } from "@/components/RunResult";
import { ScreenPanel, useRunScreen } from "@/components/RunScreen";
import { ComputerAskCard } from "@/components/ComputerAskCard";
import { Button } from "@/components/ui/button";
import { RunChanges, useRunChanges } from "@/components/RunChanges";
import { Timeline, Working } from "@/components/Timeline";
import { APPROVAL_ROW, approvalOf } from "@/lib/approval";
import { askedAt, askOf, computerRefusal } from "@/lib/computerAsk";
import { BY_THE_MINUTE } from "@/lib/computers";
import { type LearningDiff, learningSteps } from "@/lib/learning";
import { isEscalated, type MessageFeatures, type RunView, runState } from "@/lib/runState";
import { cn } from "@/lib/utils";
import { latest, pendingQuestion } from "@/lib/viewing";
import type { ComputerHoldAnswer, Computers, HandBackOutcome, Run, RunComputer, RunFile, TimelineRow } from "@/lib/v2";

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
  /** Reads the run's screen (GET /v2/runs/{id}/computer): a Screen tab while it has one, its live view when one is up. */
  readComputer?: () => Promise<RunComputer>;
  /** How often the screen is read again while the run is live, in ms (tests read it faster). */
  computerEvery?: number;
  /** Takes the run's desktop or phone (POST /v2/runs/{id}/computer/take-over). */
  onTakeOver?: () => Promise<ComputerHoldAnswer>;
  /** Hands the run's computer back, answering the agent's ask with `outcome` when it asks (POST …/computer/hand-back). */
  onHandBack?: (outcome?: HandBackOutcome) => Promise<ComputerHoldAnswer>;
  /** Reads the computer kinds and providers (GET /v2/computers): whether the run's provider is metered. */
  readComputers?: () => Promise<Computers>;
};
type Tab = "graph" | "report" | "timeline" | "files" | "screen";

/** The message box's words while a tool call waits on an approval: a message declines the call, and the agent reads it. */
const DECLINES = { label: "Decline and say what to do instead", placeholder: "Tell the agent what to do instead...", does: "Sending it declines the waiting call; the agent reads your message." };
/** The message box's words while the agent waits on the person at its computer: the server takes a message as one to a
 *  working run (steered into the turn, or after it where the harness doesn't steer), never as the ask's answer, which
 *  Done or Cancel is. */
const NOT_THE_ASK = {
  steer: { label: "Steer the run", placeholder: "Steer the run...", does: "A message steers the run; it doesn't answer the ask. Do it on the screen, then Done or Cancel above." },
  follow_up: { label: "Message the run", placeholder: "Message the run...", does: "A message goes to the run after its turn; it doesn't answer the ask. Do it on the screen, then Done or Cancel above." },
};

/** What the Report tab says while a run has no answer and has not ended: only a queued or working run is writing it. One
 *  that waits on a kind of thing this console doesn't know (its `pending.kind`, a newer server's; nothing else of it is
 *  read) waits for the person, whatever its state; one that asked a question (named so, or from a server that sends no
 *  `pending`) waits for the answer, in the box below where the server takes one from here; a stopped one (input
 *  required, idle) stopped before it wrote one, and a message continues it; a paused workflow run starts no step until
 *  it is resumed. */
function beforeAnswer(run: Pick<Run, "status" | "state" | "pending">, view: RunView): { title: string; note: string; spin: boolean } {
  const kind = (run.pending as { kind?: unknown } | null | undefined)?.kind;
  // Paused at its spend cap: what it spent of its cap, from the served figures (without them, said without them).
  if (run.status === "input_required" && run.pending?.kind === "budget") {
    // Each figure only as served: a pause sent with its kind alone says so without an amount, as its banner does.
    const { cap_usd: cap, spent_usd: spent } = run.pending;
    const capped = typeof cap === "number" && Number.isFinite(cap);
    const words = capped && typeof spent === "number" ? `It has spent ${capWords(spent)} of its ${capWords(cap)} cap.` : capped ? `Its ${capWords(cap)} cap is reached.` : "Its spend cap is reached.";
    return { title: "Paused at its spend cap", note: `${words} Raise the cap above to continue.`, spin: false };
  }
  // A tool call waiting on the owner's approval: the card above answers it, and a message below declines it.
  if (run.status === "input_required" && kind === "approval") return { title: "Waiting for your approval", note: `The run continues once you answer the approval above${view.canMessage ? ", or send a message below to decline it" : ""}.`, spin: false };
  // The agent's ask at its computer: the card above says what, and Done answers it.
  const ask = askOf(run);
  if (ask) return { title: `Waiting for you at the ${askedAt(ask)}`, note: "The run continues once you answer the ask above, or hand the computer back on the Screen tab.", spin: false };
  if (run.status === "input_required" && kind !== undefined && kind !== "question") return { title: "Waiting for you", note: "The run continues once you give it what it waits on.", spin: false };
  if (run.status === "input_required" && run.state === "waiting") return { title: "Waiting for your answer", note: view.messageMode === "answer" ? "The run continues when you reply below." : "The run continues once the question is answered.", spin: false };
  if (run.status === "input_required") return { title: "Stopped", note: `Stopped before it wrote an answer.${view.canMessage ? " Send a message below to continue it." : ""}`, spin: false };
  if (run.status === "paused") return { title: "Paused", note: "No new step starts until it's resumed. The answer appears here when it finishes.", spin: false };
  return { title: "Writing the answer", note: "The answer appears here when the run finishes. Follow it on the timeline.", spin: view.live };
}

/** The run page: Report / Timeline / Files tabs over AgentRun Server's run, timeline and files. */
export function RunDetail({ run, agentName, messages, harnessSteers, rows, files, readFile, openFile = null, actions, onMessage, onApprove, tab: initial, graphView, costText, readLearningDiff, readComputer, computerEvery, onTakeOver, onHandBack, readComputers }: RunDetailProps) {
  // A run paused at its spend cap takes no message until its cap is raised (409 budget_reached): no composer for it.
  const budget = run.pending?.kind === "budget" ? run.pending : null;
  // The agent's ask at its computer: a message is no answer to it, but one to a working run.
  const ask = askOf(run);
  const askMode = ask ? (harnessSteers && messages.steer ? "steer" as const : messages.follow_up ? "follow_up" as const : null) : null;
  const state = runState(run.status, run.state, run.kind, messages, harnessSteers, run.error, run.review);
  const view = budget ? { ...state, canMessage: false, messageMode: null } : ask ? { ...state, canMessage: askMode !== null, messageMode: askMode } : state;
  const defaultTab: Tab = graphView ? "graph" : view.final && run.status === "completed" ? "report" : "timeline";
  const [tab, setTab] = useState<Tab>(initial ?? defaultTab);
  const [open, setOpen] = useState<{ file: RunFile; text: string | null } | null>(openFile ? { file: openFile, text: null } : null);
  // A tool call waiting on the owner's approval takes the question's place: an earlier question, answered, may still be
  // the newest waiting row, and is no question now.
  const approval = approvalOf(run);
  const waiting = approval || ask ? null : pendingQuestion(run.status, run.state, rows);
  // The approval's timeline row, which follows the call's result: its step points to the card above.
  const approvalRow = approval ? rows.findLast((r) => r.kind === APPROVAL_ROW && r.tool_use_id === approval.call_id) : undefined;
  // A refused answer, in words. The run is read again after it, and when another answer, a stop or a cancel came first
  // the call no longer waits, so its card goes: the words stay here.
  // It is said apart from the card unless that same approval's card still shows (the card says it then): the run may
  // already wait on the next call, whose card is another.
  const [refused, setRefused] = useState<{ id: string; text: string } | null>(null);
  const approve = async (id: string, decision: "allow" | "deny", note?: string) => {
    const said = onApprove ? await onApprove(id, decision, note) : "This page can't answer an approval.";
    setRefused(said ? { id, text: said } : null);
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
  // The run's screen, one tab for every kind of computer: while GET /computer has one (not `off`), or the run read names
  // the run's computer (a sandbox's too, or one the live view has no answer for yet).
  // The run can still open its computer while it is queued or working, waits on its question with its process held, or is
  // a paused workflow (a pause blocks new work; its session can stay open). It is read until the run is over (completed,
  // failed, cancelled): an ended run has nothing to watch.
  const screenOpens = view.live || (run.status === "input_required" && run.state === "waiting") || run.status === "paused";
  const { view: screen, held } = useRunScreen(readComputer, !view.final, computerEvery);
  const machine = run.computer;
  // An ask names its computer, so the tab is there for it before the first read answers.
  const hasScreen = !!screen || !!machine || !!ask;
  // The Screen tab, selected, goes away (a read says off, or the route refuses): the run's default tab is selected, not
  // none. A tab opened on Screen before the first read is left until there is one to go away.
  const hadScreen = useRef(false);
  useEffect(() => {
    if (hasScreen) { hadScreen.current = true; return; }
    if (hadScreen.current && tab === "screen") setTab(defaultTab);
    hadScreen.current = false;
  }, [hasScreen, tab, defaultTab]);
  // A metered provider bills its own minutes (never a browser's): read once, for the run's computer of such a kind.
  const [metered, setMetered] = useState(false);
  useEffect(() => {
    if (!machine || !BY_THE_MINUTE.has(machine.kind) || !readComputers) return;
    let alive = true;
    readComputers().then((c) => { if (alive) setMetered(!!c.kinds.find((k) => k.kind === machine.kind)?.providers.find((p) => p.id === machine.provider)?.metered); }).catch(() => {});
    return () => { alive = false; };
  }, [machine?.kind, machine?.provider]); // eslint-disable-line react-hooks/exhaustive-deps
  // The agent's ask at its computer: its card above the tabs' content, and the page moves to the Screen tab once per ask.
  const askKey = ask ? `${ask.kind}:${ask.asked_at}` : null;
  const askShown = useRef<string | null>(null);
  useEffect(() => {
    if (!askKey || askShown.current === askKey || !hasScreen) return;
    askShown.current = askKey;
    setTab("screen");
  }, [askKey, hasScreen]);
  // Take over, Hand back and the ask's answer: who drives is the answer's until the next read; a refusal is said in words.
  const take = async () => {
    if (!onTakeOver) return "This page can't take the computer over.";
    try { held((await onTakeOver()).hold); return null; } catch (e) { return computerRefusal(e, "take"); }
  };
  const hand = async (outcome?: HandBackOutcome) => {
    if (!onHandBack) return "This page can't hand the computer back.";
    try { held((await onHandBack(outcome)).hold); return null; } catch (e) { return computerRefusal(e, "hand"); }
  };
  // An answer to the ask, refused: by the ask it answered (its asked_at). The run is read again after it, and an ask
  // answered first elsewhere or expired is gone with its card, so the words stay here (the card says them while it shows).
  const [askRefused, setAskRefused] = useState<{ at: string; text: string } | null>(null);
  const answerAsk = async (outcome: HandBackOutcome) => {
    const at = ask?.asked_at ?? "";
    const said = await hand(outcome);
    setAskRefused(said ? { at, text: said } : null);
    return said;
  };
  // A story or a deep link can open a file on first render.
  useEffect(() => { if (openFile && readFile) void show(openFile); }, [openFile]); // eslint-disable-line react-hooks/exhaustive-deps

  const tabs: [Tab, string][] = [...(graphView ? [["graph", "Graph"] as [Tab, string]] : []), ["report", "Report"], ["timeline", "Timeline"], ["files", `Files ${files.length}`], ...(hasScreen ? [["screen", "Screen"] as [Tab, string]] : [])];
  return (
    <div className="flex h-full min-h-0 flex-col">
      <RunHeader run={run} agentName={agentName} actions={actions} costText={costText} />
      <div className="flex border-b px-5 md:px-8" role="tablist">
        {tabs.map(([id, name]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}
            className={cn("caps -mb-px whitespace-nowrap border-b-2 px-3 py-3 text-[12px] max-sm:px-2.5 max-sm:py-2", tab === id ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground")}>
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
          {refused && refused.id !== approval?.id && <p className="border border-destructive/50 px-4 py-2.5 font-mono text-[12px] text-destructive-text" role="alert">Your answer wasn't taken: {refused.text}</p>}
          {askRefused && askRefused.at !== ask?.asked_at && <p className="border border-destructive/50 px-4 py-2.5 font-mono text-[12px] text-destructive-text" role="alert">Your answer wasn't taken: {askRefused.text}</p>}
          {approval ? <ApprovalCard key={approval.id} pending={approval} onAnswer={(decision, note) => approve(approval.id, decision, note)} />
            : ask ? <ComputerAskCard key={askKey} ask={ask} onAnswer={onHandBack ? answerAsk : undefined}
                open={tab !== "screen" ? <Button size="sm" variant="primary" onClick={() => setTab("screen")}>Open the screen</Button> : null} />
            : view.needsYou && (budget ? <BudgetPaused pending={budget} /> : <NeedsYou waiting={waiting} />)}
          {/* With no served cap the banner names none to raise above; the run header's raise reads the run's own cap. */}
          {view.needsYou && budget && typeof budget.cap_usd === "number" && actions?.onRaiseCap && <RaiseCap key={`${run.run_id}:${budget.at}`} cap={budget.cap_usd} suggested={suggestedCap(budget)} least={leastCap(budget)} paused onRaise={actions.onRaiseCap} />}
          {tab === "report" && <RunResult run={run} rows={rows} files={files} onOpen={show} />}
          {tab === "report" && !run.result && !view.final && <Working {...beforeAnswer(run, view)} />}
          {tab === "report" && view.final && !run.result?.final_answer && !run.result?.output && !rows.some((r) => r.kind === "final_answer") && run.status !== "failed" && run.status !== "cancelled" && !run.review && (
            <p className="font-mono text-[13px] text-muted-foreground">This run gave no answer.</p>
          )}
          {tab === "timeline" && <Timeline rows={learningSteps(rows, run.learning)} live={view.live} asking={approvalRow?.id ?? (view.needsYou && !budget ? waiting?.id : undefined)} waitingOn={run.status === "input_required" ? run.pending?.kind : undefined} />}
          {(tab === "report" || tab === "timeline") && changes && <RunChanges got={changes.got} retry={changes.retry} />}
          {tab === "files" && <RunFiles files={files} onOpen={show} />}
          {tab === "screen" && hasScreen && <ScreenPanel runId={run.run_id} screen={screen} machine={machine} opens={screenOpens} followUp={view.canMessage && view.messageMode === "follow_up"} metered={metered}
            onTake={onTakeOver ? take : undefined} onHand={onHandBack ? () => hand() : undefined} />}
        </div>
      </div>}
      {/* While a call waits on an approval, a message declines it, as its reason: the box says so. */}
      {view.canMessage && (
        <div className="border-t px-5 py-4 md:px-8"><div className="mx-auto max-w-4xl"><Composer mode={view.messageMode!} onSend={onMessage} purpose={approval ? DECLINES : ask && askMode ? NOT_THE_ASK[askMode] : undefined} /></div></div>
      )}
      {open && <ArtifactViewer file={open.file} text={open.text} onClose={close} files={files} onOpen={show} />}
    </div>
  );
}
