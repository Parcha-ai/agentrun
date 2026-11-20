import { ChevronDown, Hourglass, Pencil, RefreshCw, RotateCcw, Sparkles, TriangleAlert, User } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { workflowGraph } from "@dsl/graph";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import { problem, ProblemCard } from "@/components/learningProblem";
import { NativeLearningSwitch } from "@/components/NativeAgent";
import { CostPerRun } from "@/components/CostPerRun";
import { LearningBill } from "@/components/LearningBill";
import { WorkflowReplay } from "@/components/WorkflowReplay";
import { LoopFeed } from "@/components/LoopFeed";
import { LoopStory } from "@/components/LoopStory";
import { compileAfterOf, storyOf } from "@/lib/learningLoop";
import { LearningSwitch } from "@/components/LearningSwitch";
import { GraphLegend, WorkflowGraph } from "@/components/WorkflowGraph";
import { Banner } from "@/components/ui/banner";
import { Textarea } from "@/components/ui/field";
import { type Agent, editBody, learningOn, learningWriteError } from "@/lib/agentForm";
import { type Client, ClientError } from "@/lib/client";
import { markdown, runLabel, when, runTitle as shownTitle } from "@/lib/format";
import {
  type AgentLearning, APPROVE_SIGN_IN, type Approval, approval, bytesOf, CHANGED, changeWords, correctionLines, corrections, counted, dropKind, dropWords,
  givenToRuns, impactBase, impactWords, type LastChange, type LearnedItem, type LearningProblem, learningWords, RESTORE_SIGN_IN, restores, type Retired, runsWord, shownImpact, took, tookChange, UNREADABLE_RETIRED,
} from "@/lib/learning";
import { learningPerRun } from "@/lib/learningBill";
import { backendSdkOf } from "@/lib/backendSdk";
import { LearningModelSetup } from "./LearningModelSetup";
import { metaOf } from "@/lib/runGraph";
import { cn } from "@/lib/utils";
import type { LearningCost, LearningLoop, Promotion, Run, Serving } from "@/lib/v2";

/** `server`: the server's own learning switch (capabilities `features.learning`); "off" means no run learns there.
 *  `onChanged`: a write of the tab's own landed (an approve, a retire, a restore, an edit of the corrections), so what
 *  waits for the owner's OK may have moved; the page around the tab reads its count again. Never for the tab's first
 *  read. */
export type LearningProps = { agent: Agent; v2: Client; server?: "on" | "off" | null; onAgent?: (agent: Agent) => void; onChanged?: () => void };

/** A failed write in the problem card's words, under its own title ("The corrections were not saved."). */
const failed = (e: unknown, what: string, title: string) => ({ ...problem(e, what), title });
const runTitle = (runs: Map<string, Run>, id: string) => { const r = runs.get(id); return r?.title ? shownTitle(r) : `run ${runLabel(id)}`; };
/** Rendered markdown, sanitized, in the console's type at a card's size. */
const PROSE = "text-lead leading-[1.65] [&_a]:text-primary-text [&_a]:underline [&_a]:underline-offset-2 [&_code]:bg-muted [&_code]:px-1 [&_code]:font-mono [&_code]:text-body [&_h1]:mb-2 [&_h1]:text-prose [&_h1]:font-semibold [&_h2]:mb-2 [&_h2]:mt-3 [&_h2]:text-lead [&_h2]:font-semibold [&_h3]:mt-3 [&_h3]:font-semibold [&_li]:mb-0.5 [&_ol]:mb-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:mb-2 [&_p:last-child]:mb-0 [&_pre]:mb-2 [&_pre]:overflow-x-auto [&_pre]:border [&_pre]:bg-background [&_pre]:p-3 [&_pre]:font-mono [&_pre]:text-small [&_ul]:mb-2 [&_ul]:list-disc [&_ul]:pl-5";
/** Whether the keyboard's save is ⌘ or Ctrl, as the editor's hint names it (both save). */
const MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const REFRESH_MS = 15_000;

/** Keep the version a person is editing, reviewing or confirming stable until they finish. Take/release the hold
 * in the state setter: a reply can arrive before React commits, or it can batch a quick operation's start and end. */
type RefreshHolds = { items: Set<symbol>; changed: (held: boolean) => void };
function useRefreshState<T = boolean>(holds: RefreshHolds, initial: T = false as T) {
  const [active, setActive] = useState(initial);
  const token = useRef(Symbol("learning interaction")).current;
  useEffect(() => () => { holds.items.delete(token); holds.changed(holds.items.size > 0); }, [holds, token]);
  const set = (value: T) => {
    if (value) holds.items.add(token); else holds.items.delete(token);
    holds.changed(holds.items.size > 0); setActive(value);
  };
  return [active, set] as const;
}

/** The agent's Learning tab: its owner's corrections (corrections.md, given whole to every later run, edited here) and
 *  the workflow drafts its runs compiled (approved, retired or restored here). Beside them: the learning switch, the
 *  loop at a glance, what runs did not keep and why, the before and after once there is one, and what the next run is
 *  given. */
export function LearningTab(props: LearningProps) {
  // Drafts and outstanding reads belong to one agent, even if the router reuses this component for another.
  return <LearningView key={props.agent.agent_id} {...props} />;
}

function LearningView({ agent, v2, server, onAgent, onChanged }: LearningProps) {
  const [view, setView] = useState<AgentLearning | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  // The loop's own reads, shared by the story, the cost chart, the workflow card and the feed: a read that fails leaves
  // its part out (no marker, no standing, no feed), never the tab.
  const [promotions, setPromotions] = useState<Promotion[]>([]);
  const [serving, setServing] = useState<Serving[]>([]);
  const [loop, setLoop] = useState<LearningLoop | null>(null);
  const [cost, setCost] = useState<LearningCost | null>(null);
  const [held, setHeld] = useState(false);
  const refreshHolds = useMemo<RefreshHolds>(() => ({ items: new Set<symbol>(), changed: setHeld }), []);
  // Bumped by each refresh but the first (the chart reads its own cost when it mounts): the cost, the bill's among it,
  // is read again with the tab, timed or by hand.
  const [costReads, setCostReads] = useState(0);
  const asked = useRef(0);
  const live = useRef(true);
  const refreshing = useRef(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  // Reads the tab again. The answer settles once the view is read, or once that read failed (it never rejects), so an
  // approve or a retire that landed stays busy until then, and is never left busy after it. A background read never
  // lands over an interaction a person has open (an edit, a confirm). `cost`: the cost chart reads again too.
  const refresh = (mode: "background" | "manual" | "write", cost = true): Promise<void> => {
    const background = mode === "background";
    if (!live.current || (background && (refreshing.current || refreshHolds.items.size))) return Promise.resolve();
    const n = ++asked.current;
    if (cost) setCostReads((k) => k + 1);
    refreshing.current = true; setIsRefreshing(true);
    setError(null);
    const current = () => live.current && n === asked.current && (mode === "write" || !refreshHolds.items.size);
    const learning = v2.agentLearning(agent.agent_id).then((r) => { if (current()) setView(r); }, (e) => { if (current()) setError(e ?? new Error("unknown")); });
    // The agent's latest runs: the titles a draft's source is named by, and the drops.
    v2.listAgentRuns(agent.agent_id, 50, null, !!agent.archived_at).then((r) => { if (current()) setRuns(r.runs); }, () => {});
    // A client without the read (a fake in a test) is a failed read, never a thrown render.
    Promise.resolve().then(() => v2.learningPromotions(agent.agent_id)).then((r) => { if (current()) { setPromotions(r.promotions); setServing(r.serving); } }, () => {});
    Promise.resolve().then(() => v2.learningLoop(agent.agent_id)).then((r) => { if (current()) setLoop(r); }, () => {});
    return learning.finally(() => { if (n === asked.current) { refreshing.current = false; setIsRefreshing(false); } });
  };
  const read = () => refresh("manual");
  const automatic = useRef<() => void>(() => {});
  automatic.current = () => { if (!document.hidden) void refresh("background"); };
  useEffect(() => {
    live.current = true;
    // The chart reads its own cost as it mounts: this first read leaves it be.
    void refresh("manual", false);
    const wake = () => automatic.current();
    window.addEventListener("focus", wake);
    document.addEventListener("visibilitychange", wake);
    const timer = window.setInterval(wake, REFRESH_MS);
    return () => {
      live.current = false; asked.current++;
      window.removeEventListener("focus", wake);
      document.removeEventListener("visibilitychange", wake);
      window.clearInterval(timer);
    };
  }, [v2, agent.agent_id, agent.archived_at]); // eslint-disable-line react-hooks/exhaustive-deps
  // After a write of the tab's own: the tab reads again, and the page is told.
  const changed = (): Promise<void> => { onChanged?.(); return refresh("write"); };

  const on = learningOn(agent.definition.learning);
  const readOnly = !!agent.archived_at;
  const workflows = view?.workflows ?? [];
  const lines = correctionLines(view?.corrections ?? "");
  // Whether this caller is the owner signed in to the console, read once a draft waits: until the server says so, no
  // Approve.
  const [approves, setApproves] = useState<Approval | undefined>(undefined);
  const anyWaiting = workflows.some((x) => x.status === "pending");
  useEffect(() => {
    if (!anyWaiting || approves !== undefined) return;
    let live = true;
    Promise.resolve().then(() => v2.capabilities()).then((c) => { if (live) setApproves(approval(c)); }, () => { if (live) setApproves("password"); });
    return () => { live = false; };
  }, [anyWaiting]); // eslint-disable-line react-hooks/exhaustive-deps
  const byRun = useMemo(() => new Map(runs.map((r) => [r.run_id, r])), [runs]);
  const lookedBack = runs.filter((r) => r.learning && (r.learning.state === "merged" || r.learning.state === "dropped")).length;
  // The loop at a glance: the corrections, the compile, the takeover, the money, where it is unsure; each says what comes
  // next. Its compile count is the server's (the loop read's completed_runs, what compileDue counts: the agent's own
  // completed runs, never the one page of runs this tab reads).
  const execution = agent.definition.native ? "native" : backendSdkOf(agent.definition) ? "sdk" : "hosted";
  const story = storyOf({ corrections: lines.length, runs: loop?.completed_runs ?? 0, workflows, cost, promotions, serving, loop, execution, compileAfter: compileAfterOf(agent.definition.learning) });

  const frame = (content: ReactNode) => <div className="space-y-3">
    <div className="flex justify-end"><Button size="icon" variant="ghost" aria-label="Refresh learning" title="Refresh learning" disabled={held || isRefreshing}
      onClick={() => { if (!refreshHolds.items.size && !refreshing.current) void read(); }}><RefreshCw className={cn(isRefreshing && "animate-spin")} aria-hidden /></Button></div>
    {view && <LearningModelSetup access={view.learning_model ?? (agent.definition.native ? { location: "native", ready: true, model: null, needs: null, reason: null } : undefined)} />}
    {content}
  </div>;
  if (error && !view) return frame(<ProblemCard problem={problem(error, "what this agent learned")} onRetry={read} className="" />);
  if (!view) return frame(<Skeleton />);
  // A refresh that failed (after an edit, a retire) leaves what was read before it on screen: a line beside it says it
  // was not read again, and why, and Try again reads it again.
  const stale = error ? <RefreshFailed error={error} onRetry={read} /> : null;
  const switchRow = (quiet: boolean) => <SavedSwitch agent={agent} v2={v2} onAgent={onAgent} server={server} disabled={readOnly} quiet={quiet} />;
  const correctionsCard = <CorrectionsCard text={view.corrections} v2={v2} agentId={agent.agent_id} readOnly={readOnly} onChanged={changed} refreshHolds={refreshHolds} />;

  if (!lines.length && !workflows.length) return frame(
    <div className="space-y-6">
      {stale}
      <Empty on={on} lookedBack={lookedBack} switchRow={switchRow(true)} />
      {correctionsCard}
      {on && <LoopStory stages={story} />}
      <CostPerRun v2={v2} agentId={agent.agent_id} on={on} quiet promotions={promotions} onCost={setCost} reads={costReads} execution={execution} />
      <LearningBill v2={v2} agentId={agent.agent_id} cost={cost} serving={serving} />
      <LoopFeed loop={loop} promotions={promotions} serving={serving} cost={cost} />
      <NotKept runs={runs} />
    </div>
  );

  // The drafts a person retired are no longer given to a run: under Earlier workflows.
  const inUse = workflows.filter((x) => x.status !== "retired");
  const gone = workflows.filter((x) => x.status === "retired");
  return frame(
    <div className="space-y-6">
      {/* The loop at a glance. */}
      <LoopStory stages={story} />
      {shownImpact(view.impact) && <ImpactCard impact={view.impact} cost={cost} />}
      <CostPerRun v2={v2} agentId={agent.agent_id} on={on} promotions={promotions} onCost={setCost} reads={costReads} execution={execution} />
      <LearningBill v2={v2} agentId={agent.agent_id} cost={cost} serving={serving} />
      <WorkflowReplay v2={v2} agentId={agent.agent_id} workflows={workflows} promotions={promotions} serving={serving} cost={cost} onReplayed={() => { void read(); }} />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="min-w-0 space-y-6">
          {stale}
          {!on && <Off server={server} />}
          {correctionsCard}
          {workflows.length > 0 && (
            <section className="min-w-0 space-y-3" aria-label="Workflows it learned">
              <div>
                <h2 className="text-lg font-semibold">Workflows it learned</h2>
                <p className="mt-0.5 text-body text-muted-foreground">{!inUse.length ? "No workflow is in use: the next run gets none." : `${counted(inUse.length, "workflow")}: a job it does again, as steps a later run can call.`}</p>
              </div>
              {inUse.length > 0 && (
                <ul className="space-y-3">
                  {inUse.map((x) => <li key={x.file}><LearnedCard item={x} v2={v2} agentId={agent.agent_id} readOnly={readOnly} runs={byRun} approves={approves} onChanged={changed} refreshHolds={refreshHolds} /></li>)}
                </ul>
              )}
              {gone.length > 0 && <EarlierLearned items={gone} v2={v2} agentId={agent.agent_id} runs={byRun} readOnly={readOnly} onChanged={changed} refreshHolds={refreshHolds} />}
            </section>
          )}
        </div>
        <aside className="min-w-0 space-y-6" aria-label="About learning">
          <Panel title="Learning">{switchRow(false)}</Panel>
          <LoopFeed loop={loop} promotions={promotions} serving={serving} cost={cost} />
          <NotKept runs={runs} />
          <NextRun corrections={lines.length} workflows={workflows.filter((w) => givenToRuns(w.status))} off={!on || server === "off"} />
        </aside>
      </div>
    </div>
  );
}

/** A refresh that failed, beside what was read before it: why, in the problem card's words, and Try again. The server's
 *  own words and code are its tooltip. */
function RefreshFailed({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const p = problem(error, "what it learned");
  const said = [p.said, p.code].filter(Boolean).join(" · ");
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border border-destructive/40 px-3 py-2 text-body" role="alert" title={said || undefined}>
      <span className="min-w-0 flex-1">Couldn't refresh what it learned: {p.why.charAt(0).toLowerCase() + p.why.slice(1)} What's shown may be out of date.</span>
      <Button type="button" onClick={onRetry} size="sm">Try again</Button>
    </div>
  );
}

/** A titled box at the side, as Mission Control's lists are: a bordered section under a caps header. */
function Panel({ title, children, label }: { title: string; children: ReactNode; label?: string }) {
  return (
    <section className="border" aria-label={label ?? title}>
      <h2 className="caps border-b px-4 py-3 text-small font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function Skeleton() {
  const bone = "block bg-muted motion-safe:animate-pulse";
  return (
    <div className="space-y-3" role="status" aria-busy="true" aria-label="Loading what it learned">
      <span aria-hidden className={cn(bone, "h-6 w-56")} />
      {[0, 1, 2].map((i) => (
        <div key={i} aria-hidden className="space-y-3 border p-5">
          <span className={cn(bone, "h-4 w-1/3")} />
          <span className={cn(bone, "h-3 w-2/3 bg-muted/70")} />
          <span className={cn(bone, "h-3 w-1/2 bg-muted/70")} />
        </div>
      ))}
      <span className="sr-only">Loading what it learned…</span>
    </div>
  );
}

/** Before and after the agent first learned (a correction or a workflow: the server counts a run that started from
 *  either on the after side), as a flat panel like the others: the median time to its answer, each side's, how many
 *  runs the after side counts, and what learning itself books a run, the bill's (`cost`, the tab's cost read: its
 *  compile turns, audit shadows and replays over the runs that did a job). What a run costs is the cost card's all-in
 *  before and after alone: a median of the job's own cost here left learning out and said a second ratio. Said as the
 *  numbers are, a slower after included: a change down is in the primary colour, one up in the warning colour, and
 *  neither is ever left out. Shown only when the server has two runs on each side. */
function ImpactCard({ impact, cost }: { impact: NonNullable<AgentLearning["impact"]>; cost: LearningCost | null }) {
  const { before: b, after: a } = impact;
  const stats: { label: string; now: string; was: string; delta: number | null }[] = [
    // The change is of the times as shown, so "1.5s instead of 1.4s" never reads +7% against "2s instead of 1s".
    { label: "Answers in", now: took(a.median_duration_s), was: took(b.median_duration_s), delta: tookChange(b.median_duration_s, a.median_duration_s) },
  ];
  const learning = cost?.bill ? learningPerRun(cost.bill) : null;
  const basis = `Medians of ${runsWord(b.runs)} before it first learned and ${runsWord(a.runs)} that started from what it learned (a correction or a workflow).`;
  return (
    <section className="border" aria-label={impactWords(impact, learning)}>
      <div className="flex flex-wrap items-center gap-x-8 gap-y-4 px-4 py-3">
        <div className="flex items-baseline gap-2.5">
          <span className="caps text-small font-semibold">Since it learned</span>
          <span className="font-mono text-label text-muted-foreground" title={basis}>{impactBase(impact)}</span>
        </div>
        <dl className="flex flex-1 flex-wrap items-baseline gap-x-10 gap-y-3" aria-hidden>
          {stats.map((s) => (
            <div key={s.label} className="flex items-baseline gap-3">
              <dt className="caps text-micro text-muted-foreground">{s.label}</dt>
              <dd className="flex items-baseline gap-2 font-mono">
                <span className="text-figure font-semibold leading-none">{s.now}</span>
                <span className="text-small text-muted-foreground">instead of {s.was}</span>
                {s.delta !== null && s.delta !== 0 && <span className={cn("text-small", s.delta < 0 ? "text-primary-text" : "text-warning-text")}>{s.delta > 0 ? "+" : "−"}{Math.abs(s.delta)}%</span>}
              </dd>
            </div>
          ))}
          {learning !== null && (
            <div className="flex items-baseline gap-3">
              <dt className="caps text-micro text-muted-foreground">Learning itself</dt>
              <dd className="font-mono text-body text-muted-foreground" title="The bill's learning spend (compile turns, audits' shadow runs, replays) over the runs that did a job.">{learningWords(learning)}</dd>
            </div>
          )}
        </dl>
      </div>
    </section>
  );
}

/** The learning switch on the tab: a new revision with `learning` on or off, made on the agent as the server has it
 *  now, shown as it goes and put back if the save fails. */
function SavedSwitch(props: { agent: Agent; v2: Client; onAgent?: (a: Agent) => void; server?: "on" | "off" | null; disabled?: boolean; quiet?: boolean }) {
  return props.agent.definition.native ? <div className="p-4"><NativeLearningSwitch agent={props.agent} v2={props.v2} learning={props.server} onAgent={props.onAgent} /></div> : <ManagedSavedSwitch {...props} />;
}

function ManagedSavedSwitch({ agent, v2, onAgent, server, disabled, quiet }: { agent: Agent; v2: Client; onAgent?: (a: Agent) => void; server?: "on" | "off" | null; disabled?: boolean; quiet?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [trouble, setTrouble] = useState<unknown>(null);
  const [shown, setShown] = useState<boolean | null>(null);
  const flip = async (next: boolean) => {
    setBusy(true); setTrouble(null); setShown(next);
    try {
      const { agent: now, etag } = await v2.getAgent(agent.agent_id);
      // Preserve learning already enabled by another writer.
      const learning = !next ? false : learningOn(now.definition.learning) ? now.definition.learning : true;
      const body = editBody(now, { learning }, next ? "Learning on" : "Learning off");
      if (body.unchanged) onAgent?.(now);
      else { const { unchanged: _u, ...send } = body; onAgent?.((await v2.updateDefinition(agent.agent_id, send, etag)).agent); }
    } catch (e) { setTrouble(e ?? new Error("unknown")); }
    setShown(null); setBusy(false);
  };
  return (
    <LearningSwitch id={`learns-${agent.agent_id}`} className="px-4 py-4" quiet={quiet} checked={shown ?? learningOn(agent.definition.learning)} onChange={(v) => void flip(v)}
      busy={busy} disabled={disabled} server={server}
      problem={trouble ? <ProblemCard problem={failed(trouble, "the agent", "Learning was not changed.")} className="mt-2" /> : null} />
  );
}

function Off({ server }: { server?: "on" | "off" | null }) {
  return (
    <Banner tone="warning">Learning is off{server === "off" ? " on this server" : ""}, so later runs aren't given these corrections or workflows. They're kept for when it's back on.</Banner>
  );
}

/** Nothing learned yet, as the console says a tab is empty: a bordered centred line, one sentence on what learning is,
 *  and the switch as the next step (or, with learning on, how many runs had their compile turn). */
function Empty({ on, lookedBack, switchRow }: { on: boolean; lookedBack: number; switchRow: ReactNode }) {
  return (
    <section className="mx-auto max-w-xl border" aria-label="Learning">
      <div className="px-6 py-12 text-center">
        <Sparkles className="mx-auto mb-3 size-5 text-primary-text" aria-hidden />
        <p className="font-mono text-body text-muted-foreground">{on ? "Nothing learned yet." : "Learning is off for this agent."}</p>
        <p className="mx-auto mt-2 max-w-md text-lead text-muted-foreground">
          {on ? "Every later run is given your corrections whole, and a job it does again compiles into a workflow. Both show here."
            : "With learning on, every later run is given your corrections, and a job it does again compiles into a workflow."}
        </p>
        {on && lookedBack > 0 && <p className="mt-3 font-mono text-small text-muted-foreground">{runsWord(lookedBack)} had their compile turn: no workflow kept yet.</p>}
      </div>
      <div className="border-t">{switchRow}</div>
    </section>
  );
}

/** corrections.md: its owner's corrections, one line each, given whole to every later run under `# Learned`. Shown as it
 *  is on main; Edit reads the file with its version and its cap, and saves it whole on that version (If-Match). A change
 *  made since (a run's correction from a grade, another edit) is never written over: the save is refused, the newest
 *  version loads, and the edit stays below to copy. ⌘/Ctrl+Enter saves; Esc cancels. */
function CorrectionsCard({ text, v2, agentId, readOnly, onChanged, refreshHolds }: { text: string; v2: Client; agentId: string; readOnly: boolean; onChanged: () => void | Promise<void>; refreshHolds: RefreshHolds }) {
  const [editing, setEditing] = useRefreshState(refreshHolds);
  const [saved, setSaved] = useState(false);
  const lines = correctionLines(text);
  // Any saved text is shown, whatever its lines count: a file of headings alone still reaches every later run.
  const shown = text.trim() !== "";
  const html = useMemo(() => markdown(text.trim()), [text]);
  useEffect(() => { if (!saved) return; const t = setTimeout(() => setSaved(false), 2400); return () => clearTimeout(t); }, [saved]);
  return (
    <section className="min-w-0 space-y-3" aria-label="Corrections">
      <div className="flex flex-wrap items-end gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1">
          <h2 className="flex items-center gap-2 text-lg font-semibold">Corrections{saved && <span className="caps text-micro text-success-text" role="status">Saved</span>}</h2>
          <p className="mt-0.5 text-body text-muted-foreground">{lines.length ? `${corrections(lines.length)}. Every later run is given ${lines.length === 1 ? "it" : "them"} whole before it starts.` : shown ? "Every later run is given this text whole before it starts." : "None yet. A correction you give with a run's grade is kept here, one line each; every later run is given them whole."}</p>
        </div>
        {!readOnly && !editing && <Button size="sm" variant="ghost" onClick={() => setEditing(true)} aria-label="Edit corrections"><Pencil aria-hidden /> Edit</Button>}
      </div>
      {editing ? <CorrectionsEditor v2={v2} agentId={agentId} onDone={(ok) => { setEditing(false); if (ok) { setSaved(true); void onChanged(); } }} />
        : shown && <div className="border bg-card/40"><div className={cn(PROSE, "max-h-96 overflow-auto break-words px-5 py-4")} dangerouslySetInnerHTML={{ __html: html }} /></div>}
    </section>
  );
}

/** corrections.md opened to edit: read with its version and its cap (GET …/learning/corrections), saved whole on that
 *  version (PUT, If-Match). The bytes it holds count against its cap as you type, and a save past it is never sent. */
function CorrectionsEditor({ v2, agentId, onDone }: { v2: Client; agentId: string; onDone: (saved: boolean) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const [etag, setEtag] = useState<string | null>(null);
  const [cap, setCap] = useState(0);
  const [readError, setReadError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<LearningProblem[]>([]);
  const [trouble, setTrouble] = useState<unknown>(null);
  const [stale, setStale] = useState<string | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  /** The file as the server has it now. */
  const load = async (keep = false) => {
    setReadError(null);
    try { const c = await v2.corrections(agentId); if (!keep) setDraft(c.text); else setDraft((d) => d ?? c.text); setEtag(c.etag); setCap(c.cap_bytes); } catch (e) { setReadError(e ?? new Error("unknown")); }
  };
  useEffect(() => { void load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (draft !== null) area.current?.focus(); }, [draft === null]); // eslint-disable-line react-hooks/exhaustive-deps
  const size = draft === null ? 0 : bytesOf(draft);
  const over = cap > 0 && size > cap;
  const ready = draft !== null && etag !== null && !over && !busy;
  const save = async () => {
    if (!ready) return;
    setTrouble(null); setProblems([]);
    setBusy(true);
    try {
      await v2.writeCorrections(agentId, draft!, etag!);
      onDone(true);
    } catch (e) {
      setBusy(false);
      const p = e instanceof ClientError ? learningWriteError(e) : null;
      // A run's correction, or another edit, changed it since it was opened: show the newest, keep this edit to copy.
      if (p?.kind === "conflict") { setStale(draft); setDraft(null); await load(); }
      else if (p?.kind === "refused") setProblems(p.problems);
      else setTrouble(e ?? new Error("unknown"));
    }
  };
  const keys = (e: KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onDone(false); }
    else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void save(); }
  };
  return (
    <section className="border border-border-strong bg-card" aria-label="Edit corrections" onKeyDown={keys}>
      <div className="flex items-center gap-3 border-b px-5 py-2.5">
        <h3 className="caps text-label font-semibold">corrections.md</h3>
        <span className="ml-auto hidden font-mono text-label text-muted-foreground sm:inline"><kbd>{MAC ? "⌘" : "Ctrl"}+Enter</kbd> save · <kbd>Esc</kbd> cancel</span>
      </div>
      {readError !== null && <ProblemCard problem={problem(readError, "the corrections")} onRetry={() => void load(true)} className="m-5" />}
      <div className="space-y-4 px-5 py-4">
        {stale && (
          <div className="border border-warning/50 bg-warning/10 px-4 py-3 text-body" role="alert">
            <p className="flex items-center gap-2 font-semibold"><TriangleAlert className="size-4 text-warning-text" aria-hidden />Changed since you opened it</p>
            <p className="mt-1 text-muted-foreground">This is the newest version. Your edit wasn't saved; it's below to copy.</p>
            <details className="mt-2"><summary className="caps cursor-pointer text-label text-muted-foreground hover:text-foreground">Your edit</summary><pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words border bg-background p-3 font-mono text-small">{stale}</pre></details>
          </div>
        )}
        {draft === null ? (readError === null && <div role="status" aria-label="Loading the corrections"><div aria-hidden className="h-24 bg-muted motion-safe:animate-pulse" /></div>) : (
          <label className="block"><span className="sr-only">Corrections</span>
            <Textarea ref={area} value={draft} onChange={(e) => setDraft(e.target.value)} rows={8} placeholder="One correction a line: what to do differently, and why." className="resize-y font-mono leading-[1.65]" /></label>
        )}
        {cap > 0 && <p className={cn("font-mono text-label", over ? "text-destructive-text" : "text-muted-foreground")} role={over ? "alert" : undefined}>{size} of {cap} bytes{over ? ": too long to save" : ""}</p>}
        {problems.length > 0 && (
          <div className="border border-destructive/50 bg-destructive/5 px-4 py-3 text-body" role="alert">
            <p className="font-semibold text-destructive-text">Not saved: it doesn't pass the checks.</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-5">{problems.map((p, i) => <li key={i}>{p.detail}</li>)}</ul>
          </div>
        )}
        {trouble !== null && <ProblemCard problem={failed(trouble, "the corrections", "The corrections were not saved.")} className="" />}
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="solid" onClick={() => void save()} disabled={!ready}>{busy ? "Saving" : "Save"}</Button>
          <Button size="sm" variant="ghost" onClick={() => onDone(false)} disabled={busy}>Cancel</Button>
        </div>
      </div>
    </section>
  );
}

/** A workflow draft the agent learned, in use or waiting: its name, what it is for, the run that kept it, whether it
 *  waits for the owner's OK (Approve where this caller approves), and its graph, read when it is opened. Approve and
 *  Retire (after a confirm) are made on its README, at the version listed. A run changes it; a person approves or
 *  retires it, never edits it. */
/** Where a workflow given to runs stands, as the server's `status` says it (the promotions read's own word). */
const STANDS: Partial<Record<LearnedItem["status"], { word: string; tone: "success" | "active" | "warning" | "muted"; title: string }>> = {
  serving: { word: "Serving", tone: "success", title: "It runs first on the runs it fits." },
  checking: { word: "Checking", tone: "active", title: "Its check on the agent's own runs decides whether this revision serves. The previous revision keeps serving meanwhile; the agent takes the runs only when none serves." },
  held: { word: "Held", tone: "warning", title: "It does not serve: its newest check or audit held it." },
  stopped: { word: "Stopped", tone: "muted", title: "It does not run first until a new revision lands: its checks stopped it, or it cost as much as the agent by hand. The agent takes its runs." },
};

function LearnedCard({ item, v2, agentId, readOnly, runs, approves, onChanged, refreshHolds }: { item: LearnedItem; v2: Client; agentId: string; readOnly: boolean; runs: Map<string, Run>; approves?: Approval; onChanged: () => void | Promise<void>; refreshHolds: RefreshHolds }) {
  const [open, setOpen] = useRefreshState(refreshHolds);
  const [text, setText] = useState<string | null>(null);
  const [readError, setReadError] = useState<unknown>(null);
  const [approving, setApproving] = useRefreshState(refreshHolds);
  const [retiring, setRetiring] = useRefreshState(refreshHolds);
  const [said, setSaid] = useState<ReactNode>(null);
  const waits = item.status === "pending";
  const load = async () => {
    setReadError(null);
    setText(null);
    try { setText((await v2.readLearningFile(agentId, item.file)).text); } catch (e) { setReadError(e ?? new Error("unknown")); }
  };
  const show = async () => {
    if (open) return setOpen(false);
    setOpen(true);
    if (text === null) await load();
  };
  // The list moved to another version: a text shown of the old one goes, and an open card reads the new one.
  useEffect(() => {
    if (text === null) return;
    if (open) void load();
    else setText(null);
  }, [item.etag]); // eslint-disable-line react-hooks/exhaustive-deps
  const approve = async () => {
    setApproving(true); setSaid(null);
    try {
      await v2.approveWorkflow(agentId, item.readme, item.etag);
    } catch (e) {
      setApproving(false);
      setSaid(e instanceof ClientError && learningWriteError(e).kind === "conflict" ? <p className="text-small text-destructive-text" role="alert">{`${CHANGED} Reload the tab to see the newest version.`}</p> : <ProblemCard problem={failed(e, "the workflow", "The workflow was not approved.")} className="" />);
      return;
    }
    // It landed: Approving until the list is read again, however that read ends.
    await onChanged();
    setApproving(false);
  };
  const label = `the workflow ${item.name}`;
  return (
    <article aria-label={item.name} className="border bg-card/40">
      <header className="flex flex-col gap-x-3 gap-y-1 px-5 pt-4 sm:flex-row sm:items-start">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="min-w-0 break-words font-mono text-lead font-semibold leading-snug">{item.name}</h3>
            {waits && <Chip tone="warning"><Hourglass className="size-3" aria-hidden />Waits for your OK</Chip>}
            {STANDS[item.status] && <Chip tone={STANDS[item.status]!.tone} title={STANDS[item.status]!.title}>{STANDS[item.status]!.word}</Chip>}
          </div>
          {item.description && <p className="mt-1 text-body text-muted-foreground">{item.description}</p>}
          {waits && approves === "password" && <p className="mt-2 font-mono text-label text-muted-foreground">{APPROVE_SIGN_IN}</p>}
        </div>
        <div className="-ml-3 flex shrink-0 items-center gap-1 sm:ml-0">
          {!readOnly && !retiring && <>
            {waits && approves === "yes" && <Button size="sm" variant="solid" onClick={() => void approve()} disabled={approving} aria-label={`Approve ${item.name}`}>{approving ? "Approving" : "Approve"}</Button>}
            <Button size="sm" variant="destructive" onClick={() => setRetiring(true)} aria-label={`Retire ${item.name}`}>Retire</Button>
          </>}
          <Button size="sm" variant="ghost" onClick={() => void show()} aria-expanded={open} aria-label={`${open ? "Hide" : "Show"} ${label}`}><ChevronDown className={cn("transition-transform", open && "rotate-180")} aria-hidden />{open ? "Hide" : "Show"}</Button>
        </div>
      </header>
      {said && <div className="px-5 pt-3">{said}</div>}
      {open && (readError !== null ? <div className="px-5 pt-3"><ProblemCard problem={problem(readError, label)} onRetry={() => void load()} className="" /></div>
        : text === null ? <div className="px-5 pt-3" role="status" aria-label={`Loading ${label}`}><div aria-hidden className="h-16 bg-muted motion-safe:animate-pulse" /></div>
        : <LearnedWorkflow name={item.name} text={text} />)}
      <footer className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1.5 border-t px-5 py-2.5 font-mono text-label text-muted-foreground">
        {item.run && <LearnedIn run={item.run} runs={runs} />}
        {lastChangeLine(item.last_change) && <span className="flex items-center gap-1.5"><User className="size-3" aria-hidden />{lastChangeLine(item.last_change)}</span>}
        <span>{item.bytes < 1024 ? `${item.bytes} B` : `${(item.bytes / 1024).toFixed(1)} KB`}</span>
      </footer>
      {retiring && <RetireConfirm name={item.name} retire={() => v2.retireWorkflow(agentId, item.readme, item.etag)} onDone={async (ok) => { if (ok) await onChanged(); setRetiring(false); }} />}
    </article>
  );
}

/** A learned workflow opened: drawn with the workflow graph a workflow agent's tab draws, from its workflow.json, with its
 *  JSON a click away under it. A text that is not JSON, or names no root node to draw, shows as its text, as it is. */
function LearnedWorkflow({ name, text }: { name: string; text: string }) {
  const { doc, graph } = useMemo(() => {
    try { const doc: unknown = JSON.parse(text); return { doc, graph: workflowGraph(doc) }; } catch { return { doc: null, graph: null }; }
  }, [text]);
  const marks = useMemo(() => (graph ? { meta: metaOf(doc, graph) } : undefined), [doc, graph]);
  const json = <pre className="max-h-80 overflow-auto border bg-background p-3 font-mono text-small">{text}</pre>;
  if (!graph?.nodes.length) return <div className="mx-5 mt-3">{json}</div>;
  return (
    <div className="mx-5 mt-3 space-y-2">
      <div className="overflow-auto border bg-[radial-gradient(hsl(var(--border))_1px,transparent_1px)] [background-size:22px_22px] px-4 py-4">
        <WorkflowGraph graph={graph} marks={marks} label={`The workflow ${name}, as a graph`} minScale={0.55} maxScale={1} />
      </div>
      <GraphLegend />
      <details>
        <summary className="caps cursor-pointer text-label text-muted-foreground hover:text-foreground">workflow.json</summary>
        <div className="mt-2">{json}</div>
      </details>
    </div>
  );
}

/** A newest change the server names, in words with when ("Approved by you · Nov 5, 7:30 PM"); none for a run's learning,
 *  which "Learned in" says, or when the server names no change. */
function lastChangeLine(last: LastChange | undefined): string | null {
  return last && last.kind !== "learned" ? `${changeWords(last.kind, last.by)} · ${when(last.at)}` : null;
}

/** Who retired one and when, as the server names it (`retired`), else just "Retired"; one whose README can't be read
 *  says so and how to fix it, never who retired it (UNREADABLE_RETIRED). */
function retiredLine(retired: Retired | undefined): string {
  if (retired?.by === "host") return UNREADABLE_RETIRED;
  return retired ? `${changeWords("retired", retired.by)} · ${when(retired.at)}` : "Retired";
}

/** "Learned in" the run that kept it, linked by its short id (its whole title on hover). */
function LearnedIn({ run, runs }: { run: string; runs: Map<string, Run> }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5"><span className="flex shrink-0 items-center gap-1.5 whitespace-nowrap"><Sparkles className="size-3 shrink-0 text-primary-text" aria-hidden />Learned in</span>
      <a href={`#/runs/${encodeURIComponent(run)}`} className="shrink-0 font-mono text-foreground/80 underline-offset-2 hover:text-foreground hover:underline" title={runTitle(runs, run)}>{runLabel(run)}</a>
    </span>
  );
}

/** Retire, after a confirm in place as the run header's cancel is: "Yes, retire" takes the focus, so Enter retires,
 *  and Esc or Keep keeps it. `retire` makes it on the version the card showed. A 412, made on a version changed since,
 *  says so. */
function RetireConfirm({ name, retire, onDone }: { name: string; retire: () => Promise<unknown>; onDone: (retired: boolean) => void | Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<ReactNode>(null);
  const yes = useRef<HTMLButtonElement>(null);
  useEffect(() => { yes.current?.focus(); }, []);
  const go = async () => {
    setBusy(true); setSaid(null);
    try {
      await retire();
    } catch (e) {
      setBusy(false);
      setSaid(e instanceof ClientError && learningWriteError(e).kind === "conflict" ? <p className="text-small text-destructive-text" role="alert">{`${CHANGED} Reload the tab to see the newest version.`}</p> : <ProblemCard problem={failed(e, "the workflow", "The workflow was not retired.")} className="" />);
      return;
    }
    // It landed: Retiring until the card's owner has read the list again (and closed this), however that read ends.
    await onDone(true);
  };
  return (
    <div role="alertdialog" aria-label={`Retire ${name}?`} onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); void onDone(false); } }}
      className="flex flex-wrap items-center gap-3 border-t border-destructive/40 bg-destructive/5 px-5 py-3">
      <p className="min-w-0 flex-1 text-body"><span className="font-semibold">Retire it?</span> Later runs stop getting it. It stays under Earlier workflows.</p>
      {said && <div className="w-full">{said}</div>}
      <Button ref={yes} size="sm" variant="destructive" onClick={() => void go()} disabled={busy}>{busy ? "Retiring" : "Yes, retire"}</Button>
      <Button size="sm" variant="ghost" onClick={() => void onDone(false)} disabled={busy}>Keep</Button>
    </div>
  );
}

/** Restore a retired draft, after a confirm: `restore` is made on the version its row shows (If-Match), and the tab is
 *  read again (`onChanged`). A version changed since says so and reads it again; one no longer retired (restored
 *  elsewhere) reads it again; a token is told restoring takes the password sign-in; a refusal by the checks a new one
 *  passes shows the server's words, and it stays retired. */
function RestoreConfirm({ name, from, restore, onChanged, onDone }: { name: string; from: Retired["from"] | undefined; restore: () => Promise<unknown>; onChanged: () => void | Promise<void>; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<ReactNode>(null);
  const yes = useRef<HTMLButtonElement>(null);
  useEffect(() => { yes.current?.focus(); }, []);
  const words = (text: string) => <p className="text-small text-destructive-text" role="alert">{text}</p>;
  const go = async () => {
    setBusy(true); setSaid(null);
    try { await restore(); }
    catch (e) {
      setBusy(false);
      if (e instanceof ClientError && (e.status === 412 || e.code === "precondition_failed")) { setSaid(words(CHANGED)); await onChanged(); return; }
      if (e instanceof ClientError && e.status === 403) return void setSaid(words(RESTORE_SIGN_IN));
      if (e instanceof ClientError && e.problems?.length) {
        return void setSaid(<div className="text-small text-destructive-text" role="alert"><p>Not restored: {e.message}</p><ul className="mt-1 list-disc space-y-0.5 pl-5">{e.problems.map((p, i) => <li key={i}>{p.detail}</li>)}</ul></div>);
      }
      // Not retired any more (restored in another tab): the tab is read again, which shows it where it is now.
      if (e instanceof ClientError && e.status === 400) { await onChanged(); onDone(); return; }
      return void setSaid(<ProblemCard problem={failed(e, "the workflow", "The workflow was not restored.")} className="" />);
    }
    // It landed: the tab is read again, then the confirm goes.
    await onChanged();
    onDone();
  };
  return (
    <div role="alertdialog" aria-label={`Restore ${name}?`} onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); onDone(); } }}
      className="flex flex-wrap items-center gap-3 border-t bg-card px-5 py-3">
      <p className="min-w-0 flex-1 text-body"><span className="font-semibold">Restore it?</span> {restores(from)}</p>
      {said && <div className="w-full">{said}</div>}
      <Button ref={yes} size="sm" variant="solid" onClick={() => void go()} disabled={busy}>{busy ? "Restoring" : "Yes, restore"}</Button>
      <Button size="sm" variant="ghost" onClick={onDone} disabled={busy}>Keep</Button>
    </div>
  );
}

/** A closed list under its caps title and count, opened on a click: the workflows no longer in use. */
function Folded({ title, count, open, onToggle, children }: { title: string; count: string; open: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <section className="border" aria-label={title}>
      <button type="button" aria-expanded={open} onClick={onToggle} className="flex w-full items-center gap-2 px-4 py-3 text-left hover:bg-accent">
        <ChevronDown className={cn("size-3.5 text-muted-foreground transition-transform", !open && "-rotate-90")} aria-hidden />
        <span className="caps text-small font-semibold">{title}</span>
        <span className="font-mono text-label text-muted-foreground">{count}</span>
      </button>
      {open && <ul className="border-t">{children}</ul>}
    </section>
  );
}

/** The workflow drafts a person retired: closed until asked, each by its name, and who retired it and when once the
 *  server says. No Approve and no Retire: no later run is given it. Restore puts it back. */
function EarlierLearned({ items, v2, agentId, runs, readOnly, onChanged, refreshHolds }: { items: LearnedItem[]; v2: Client; agentId: string; runs: Map<string, Run>; readOnly: boolean; onChanged: () => void | Promise<void>; refreshHolds: RefreshHolds }) {
  const [open, setOpen] = useState(false);
  const [restoring, setRestoring] = useRefreshState<string | null>(refreshHolds, null);
  // The ones opened to their workflow.json, read when opened.
  const [shown, setShown] = useState<Set<string>>(new Set());
  const toggle = (file: string) => setShown((s) => { const n = new Set(s); if (n.has(file)) n.delete(file); else n.add(file); return n; });
  return (
    <Folded title="Earlier workflows" count={`${items.length} no longer given`} open={open} onToggle={() => setOpen((o) => !o)}>
      {items.map((x) => (
        <li key={x.file} className="border-b px-4 py-3 last:border-b-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-body text-muted-foreground line-through decoration-muted-foreground/40">{x.name}</span>
            <Chip tone="muted">Retired</Chip>
            <ShowButton open={shown.has(x.file)} label={`the workflow ${x.name}`} onClick={() => toggle(x.file)} />
            {!readOnly && restoring !== x.file && <Button size="sm" onClick={() => setRestoring(x.file)} aria-label={`Restore ${x.name}`}><RotateCcw aria-hidden /> Restore</Button>}
          </div>
          {x.description && <p className="mt-1 text-small text-muted-foreground">{x.description}</p>}
          <p className="mt-1 font-mono text-label text-muted-foreground">{retiredLine(x.retired)}</p>
          {restoring === x.file && <div className="-mx-4 mt-2"><RestoreConfirm name={x.name} from={x.retired?.from} restore={() => v2.restoreWorkflow(agentId, x.readme, x.etag)} onChanged={onChanged} onDone={() => setRestoring(null)} /></div>}
          {shown.has(x.file) && (
            <div className="-mx-4 mt-2 border-t pt-1">
              <FileText v2={v2} agentId={agentId} file={x.file} etag={x.etag} label={`the workflow ${x.name}`} />
              {x.run && <p className="mt-3 flex px-5 font-mono text-label text-muted-foreground"><LearnedIn run={x.run} runs={runs} /></p>}
            </div>
          )}
        </li>
      ))}
    </Folded>
  );
}

/** Show or Hide, for a thing opened to its text in place: `label` names it for a screen reader ("the workflow …"). */
function ShowButton({ open, label, onClick }: { open: boolean; label: string; onClick: () => void }) {
  return <Button size="sm" variant="ghost" className="ml-auto" onClick={onClick} aria-expanded={open} aria-label={`${open ? "Hide" : "Show"} ${label}`}><ChevronDown className={cn("transition-transform", open && "rotate-180")} aria-hidden />{open ? "Hide" : "Show"}</Button>;
}

/** A retired draft's workflow.json, read when shown (GET …/learning/files/{file}), as it is. Read again when the list
 *  moves to another version of it (`etag`), as LearnedCard does. */
function FileText({ v2, agentId, file, etag, label }: { v2: Client; agentId: string; file: string; etag: string; label: string }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  // The newest read wins: one started before (an older version's, or a retry's) that answers late is dropped.
  const reads = useRef(0);
  const load = async () => {
    const n = ++reads.current;
    setError(null); setText(null);
    try { const read = await v2.readLearningFile(agentId, file); if (n === reads.current) setText(read.text); } catch (e) { if (n === reads.current) setError(e ?? new Error("unknown")); }
  };
  useEffect(() => { void load(); }, [file, etag]); // eslint-disable-line react-hooks/exhaustive-deps
  if (error !== null) return <div className="px-5 pt-3"><ProblemCard problem={problem(error, label)} onRetry={() => void load()} className="" /></div>;
  if (text === null) return <div className="px-5 pt-3" role="status" aria-label={`Loading ${label}`}><div aria-hidden className="h-16 bg-muted motion-safe:animate-pulse" /></div>;
  return <pre className="mx-5 mt-3 max-h-80 overflow-auto border bg-background p-3 font-mono text-small">{text}</pre>;
}

/** The latest runs that kept nothing, and why, in plain words: drafts the checks refused, skips and stops, newest first.
 *  Runs with nothing new to keep are counted, not listed. */
function NotKept({ runs }: { runs: Run[] }) {
  const dropped = runs.filter((r) => r.learning?.state === "dropped");
  const listed = dropped.filter((r) => dropKind(r.learning!.reason) !== "nothing").slice(0, 6);
  const nothing = dropped.length - dropped.filter((r) => dropKind(r.learning!.reason) !== "nothing").length;
  if (!dropped.length) return null;
  return (
    // Each run's sentence as the server says it, under a title that does not say it again.
    <Panel title="Kept nothing">
      {listed.length > 0 && (
        <ul>
          {listed.map((r) => (
            <li key={r.run_id} className="border-b last:border-b-0">
              <a href={`#/runs/${encodeURIComponent(r.run_id)}`} className="block px-4 py-3 hover:bg-accent">
                <span className="block text-body">{dropWords(r.learning!)}</span>
                <span className="mt-1 flex items-center gap-2 font-mono text-label text-muted-foreground"><span className="min-w-0 truncate" title={shownTitle(r)}>{shownTitle(r)}</span><span className="shrink-0">· {when(r.created_at)}</span></span>
              </a>
            </li>
          ))}
        </ul>
      )}
      {nothing > 0 && <p className={cn("px-4 py-3 font-mono text-label text-muted-foreground", listed.length > 0 && "border-t")}>{listed.length ? `${nothing} more ${nothing === 1 ? "run" : "runs"} had` : `${runsWord(nothing)} had`} nothing new to compile.</p>}
    </Panel>
  );
}

/** What the next run is given: corrections.md whole (its lines counted) and the agent's workflows given to runs, by name
 *  with where each stands (`serving`, `checking`, `held`, `stopped`: only a serving one runs first; one that waits for
 *  its owner's OK is given to no run). `off`: learning is off, for the agent or on this server, and the next run gets
 *  neither. Read-only. */
function NextRun({ corrections: lines, workflows, off }: { corrections: number; workflows: { name: string; status: string }[]; off: boolean }) {
  const given = off ? [] : [...(lines ? [corrections(lines)] : []), ...(workflows.length ? [counted(workflows.length, "workflow")] : [])];
  return (
    <section className="border" aria-label="What the next run is given">
      <h2 className="caps border-b px-4 py-3 text-small font-semibold">What the next run is given</h2>
      <p className="px-4 py-3 text-body text-muted-foreground">{off ? "Learning is off: the next run gets no corrections or workflows." : given.length ? `${given.join(" and ")}.` : "Nothing yet."}</p>
      {!off && workflows.length > 0 && <p className="break-words border-t px-4 py-3 font-mono text-small leading-[1.7]">Workflows: {workflows.map((w) => `${w.name} (${w.status})`).join(", ")}</p>}
    </section>
  );
}
