import { BookOpen, ChevronDown, Hourglass, Pencil, Plus, RotateCcw, Sparkles, TriangleAlert, User } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import { problem, ProblemCard } from "@/components/learningProblem";
import { LearningSwitch } from "@/components/LearningSwitch";
import { Banner } from "@/components/ui/banner";
import { Input, Textarea } from "@/components/ui/field";
import { type Agent, editBody, noteSaveError, runsWhere } from "@/lib/agentForm";
import { type Client, ClientError } from "@/lib/client";
import { markdown, runLabel, when, runTitle as shownTitle } from "@/lib/format";
import {
  type AgentLearning, bodyOf, type LearningChange, change, costsShown, dropKind, dropWords, fileFor, impactWords, learningCost, type LearningNote, money, type NoteParts, noteParts,
  APPROVE_LATER, APPROVE_SIGN_IN, type Approval, approval, CHANGED, changeWords, HOST_RUNS, type LastChange, RESTORE_SIGN_IN, restores, type Retired, isPending, NO_VERSION, type NoteProblem, originOf, WAITS_WHY, notes, noteText, NOTE_TYPES, provenance, runsWord, seenVersion, shownImpact, took, TYPE_HINT, typeLabel,
  counted, type LearnedItem, learnedItems, statusFile,
} from "@/lib/learning";
import type { Places } from "@/lib/place";
import { cn } from "@/lib/utils";
import type { Run } from "@/lib/v2";

/** `server`: the server's own learning switch (capabilities `features.learning`); "off" means no run learns there.
 *  `places`: the server's places (capabilities `places`), for where an agent that names no place runs.
 *  `onChanged`: a write of the tab's own landed (an approve, a retire, an edit, a new note), so what waits for the owner's
 *  OK may have moved; the page around the tab reads its count again. Never for the tab's first read. */
export type LearningProps = { agent: Agent; v2: Client; focus?: string[]; server?: "on" | "off" | null; onAgent?: (agent: Agent) => void; places?: Places | null; onChanged?: () => void };

/** A failed write in the problem card's words, under its own title ("The note was not saved."). */
const failed = (e: unknown, what: string, title: string) => ({ ...problem(e, what), title });
const runTitle = (runs: Map<string, Run>, id: string) => { const r = runs.get(id); return r?.title ? shownTitle(r) : `run ${runLabel(id)}`; };
/** A rendered note body: markdown, sanitized, in the console's type at a note's size. */
const PROSE = "text-lead leading-[1.65] [&_a]:text-primary-text [&_a]:underline [&_a]:underline-offset-2 [&_code]:bg-muted [&_code]:px-1 [&_code]:font-mono [&_code]:text-body [&_h1]:mb-2 [&_h1]:text-prose [&_h1]:font-semibold [&_h2]:mb-2 [&_h2]:mt-3 [&_h2]:text-lead [&_h2]:font-semibold [&_h3]:mt-3 [&_h3]:font-semibold [&_li]:mb-0.5 [&_ol]:mb-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:mb-2 [&_p:last-child]:mb-0 [&_pre]:mb-2 [&_pre]:overflow-x-auto [&_pre]:border [&_pre]:bg-background [&_pre]:p-3 [&_pre]:font-mono [&_pre]:text-small [&_ul]:mb-2 [&_ul]:list-disc [&_ul]:pl-5";
/** Whether the keyboard's save is ⌘ or Ctrl, as the editor's hint names it (both save). */
const MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
/** The most pages of notes, or of changes, the tab reads past the first on its own (for a link's note, or a note's source). */
const MORE_PAGES = 20;

/** The agent's Learning tab: the notes it wrote for itself after its runs, which every later run reads first. Each note
 *  shows where it came from and how often it was used, and a person edits it (its version named, so a change made since
 *  is never written over), retires it, or adds one. Beside them: the learning switch, what runs did not keep and why, the
 *  before and after once there is one, and what the next run reads. */
export function LearningTab({ agent, v2, focus = [], server, onAgent, places, onChanged }: LearningProps) {
  const [view, setView] = useState<AgentLearning | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [later, setLater] = useState<{ items: LearningNote[]; cursor: string | null; error?: unknown; pages: number }>({ items: [], cursor: null, pages: 0 });
  // The changes past the view's first page, read only while a note's source is not yet known.
  const [olderLog, setOlderLog] = useState<{ items: LearningChange[]; cursor: string | null; pages: number }>({ items: [], cursor: null, pages: 0 });
  // Whether the runs read are all the agent's (false: the latest page of them only).
  const [adding, setAdding] = useState(false);
  const asked = useRef(0);
  const reading = useRef(false);
  // Reads the tab again. The answer settles once the list is read, or once that read failed (it never rejects), so an
  // approve or a retire that landed stays busy until then, and is never left busy after it.
  const read = (): Promise<void> => {
    const n = ++asked.current;
    reading.current = false;
    setError(null);
    const learning = v2.agentLearning(agent.agent_id).then((r) => {
      if (n !== asked.current) return;
      setView(r); setLater({ items: [], cursor: r.notes.next_cursor, pages: 0 }); setOlderLog({ items: [], cursor: r.log.next_cursor, pages: 0 });
    }, (e) => { if (n === asked.current) setError(e ?? new Error("unknown")); });
    // The agent's latest runs: what each read and kept, the titles a note's source is named by, and the drops.
    v2.listAgentRuns(agent.agent_id, 50, null, !!agent.archived_at).then((r) => { if (n === asked.current) { setRuns(r.runs); } }, () => {});
    return learning;
  };
  useEffect(() => { void read(); }, [v2, agent.agent_id]); // eslint-disable-line react-hooks/exhaustive-deps
  // After a write of the tab's own: the tab reads again, and the page is told.
  const changed = (): Promise<void> => { onChanged?.(); return read(); };
  // The next page of notes, for this read only: a page asked for before a refresh (an edit, a retire) never lands after
  // it, so old and new versions never mix and the cursor is always the current read's.
  const more = () => {
    if (!later.cursor || reading.current) return;
    const n = asked.current;
    reading.current = true;
    v2.learningNotes(agent.agent_id, later.cursor).then(
      (p) => { if (n !== asked.current) return; reading.current = false; setLater((x) => ({ items: [...x.items, ...p.items.filter((i) => !x.items.some((y) => y.file === i.file))], cursor: p.next_cursor, pages: x.pages + 1 })); },
      (e) => { if (n !== asked.current) return; reading.current = false; setLater((x) => ({ ...x, error: e ?? new Error("unknown") })); },
    );
  };

  const on = agent.definition.learning === true;
  const readOnly = !!agent.archived_at;
  const all = useMemo(() => [...(view?.notes.items ?? []), ...later.items], [view, later.items]);
  const active = all.filter((x) => x.status === "active");
  const waiting = all.filter(isPending);
  // The skills and the workflows it learned (a newer server's), each listed whole.
  const skills = learnedItems(view?.skills);
  const workflows = learnedItems(view?.workflows);
  // Whether this caller approves from the console, read once a note, a skill or a workflow waits: until the server
  // says so, no Approve.
  const [approves, setApproves] = useState<Approval | undefined>(undefined);
  const anyWaiting = waiting.length > 0 || [...skills, ...workflows].some((x) => x.status === "pending");
  useEffect(() => {
    if (!anyWaiting || approves !== undefined) return;
    let live = true;
    Promise.resolve().then(() => v2.capabilities()).then((c) => { if (live) setApproves(approval(c)); }, () => { if (live) setApproves("later"); });
    return () => { live = false; };
  }, [anyWaiting]); // eslint-disable-line react-hooks/exhaustive-deps
  const earlier = all.filter((x) => x.status === "superseded" || x.status === "retired");
  const byRun = useMemo(() => new Map(runs.map((r) => [r.run_id, r])), [runs]);
  const from = useMemo(() => provenance([...(view?.log.items ?? []), ...olderLog.items]), [view, olderLog.items]);
  // A note an address points at past the pages read: the next pages are read until it shows, at most MORE_PAGES of them.
  const missing = focus.filter((f) => !all.some((x) => x.file === f)).length > 0;
  useEffect(() => {
    if (view && missing && later.cursor && later.error === undefined && later.pages < MORE_PAGES) more();
  }, [view, missing, later.cursor, later.pages]); // eslint-disable-line react-hooks/exhaustive-deps
  // A note whose source is past the changes read: the next changes are read until every one is known, or they end.
  const unknown = all.some((x) => !from.has(x.file));
  useEffect(() => {
    if (!view || !unknown || !olderLog.cursor || olderLog.pages >= MORE_PAGES) return;
    const n = asked.current;
    v2.learningLog(agent.agent_id, olderLog.cursor).then(
      (p) => { if (n === asked.current) setOlderLog((x) => ({ items: [...x.items, ...p.items], cursor: p.next_cursor, pages: x.pages + 1 })); },
      () => { if (n === asked.current) setOlderLog((x) => ({ ...x, cursor: null })); },
    );
  }, [view, unknown, olderLog.cursor]); // eslint-disable-line react-hooks/exhaustive-deps
  const lookedBack = runs.filter((r) => r.learning && (r.learning.state === "merged" || r.learning.state === "dropped")).length;

  if (error && !view) return <ProblemCard problem={problem(error, "what this agent learned")} onRetry={read} className="" />;
  if (!view) return <Skeleton />;
  // A refresh that failed (after an edit, a retire or a new note) leaves the notes read before it on screen: a line beside
  // them says they were not read again, and why, and Try again reads them again.
  const stale = error ? <RefreshFailed error={error} onRetry={read} /> : null;

  const switchRow = (quiet: boolean) => <SavedSwitch agent={agent} v2={v2} onAgent={onAgent} server={server} disabled={readOnly} quiet={quiet} />;
  if (!all.length && !skills.length && !workflows.length && !adding) return (
    <div className="space-y-6">
      {stale}
      <Empty on={on} lookedBack={lookedBack} switchRow={switchRow(true)} onAdd={readOnly ? undefined : () => setAdding(true)} />
      <NotKept runs={runs} />
    </div>
  );

  return (
    <div className="space-y-6">
      {waiting.length > 0 && (
        <section className="border border-warning/50" aria-label="Waiting for your OK">
          <h2 className="caps flex items-baseline gap-2 border-b border-warning/50 px-4 py-3 text-small font-semibold">Waiting for your OK<span className="font-mono font-normal text-muted-foreground">{waiting.length}</span></h2>
          <p className="px-4 pt-3 text-body text-muted-foreground">{WAITS_WHY}</p>
          {/* Only on the host with a shell: an agent that runs on the server (its own place or the server's default for it) with
              bash in its tools. One in a box, or with no shell, runs no bash on the host. */}
          {runsWhere(agent, places)?.place.mode === "runner" && (agent.definition.tools ?? []).includes("bash") && <p className="px-4 pt-1 text-body text-muted-foreground">{HOST_RUNS}</p>}
          <ul className="space-y-3 p-4">
            {waiting.map((x) => (
              <li key={x.file}>
                <NoteCard note={x} v2={v2} agentId={agent.agent_id} readOnly={readOnly} focused={focus.includes(x.file)} from={from.get(x.file)} runs={byRun} onChanged={changed} approves={approves} />
              </li>
            ))}
          </ul>
        </section>
      )}
      {shownImpact(view.impact) ? <ImpactCard impact={view.impact} /> : view.impact === null && on && <p className="font-mono text-small text-muted-foreground">{IMPACT_LATER}</p>}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="min-w-0 space-y-6">
        <section className="min-w-0 space-y-3" aria-label="Notes">
          <div className="flex flex-wrap items-end gap-x-4 gap-y-2">
            <div className="min-w-0 flex-1">
              <h2 className="text-lg font-semibold">What it has learned</h2>
              <p className="mt-0.5 text-body text-muted-foreground">{active.length ? `${notes(active.length)} in use. Every later run reads ${active.length === 1 ? "it" : "them"} before it starts.` : "No note is in use: the next run starts with nothing learned."}</p>
            </div>
            {!readOnly && !adding && <Button size="sm" onClick={() => setAdding(true)}><Plus aria-hidden /> Add a note</Button>}
          </div>
          {stale}
          {!on && <Off server={server} />}
          {adding && <NoteEditor key="new" title="New note" v2={v2} agentId={agent.agent_id} taken={all.map((x) => x.file)} onDone={(saved) => { setAdding(false); if (saved) void changed(); }} />}
          <ul className="space-y-3">
            {active.map((x) => (
              <li key={x.file}>
                <NoteCard note={x} v2={v2} agentId={agent.agent_id} readOnly={readOnly} focused={focus.includes(x.file)} from={from.get(x.file)} runs={byRun} onChanged={changed} />
              </li>
            ))}
          </ul>
          {later.error !== undefined && <ProblemCard problem={problem(later.error, "more notes")} onRetry={more} className="" />}
          {later.cursor && <div className="flex justify-center"><Button size="sm" onClick={more}>Load more notes</Button></div>}
          {earlier.length > 0 && <Earlier notes={earlier} all={all} from={from} focus={focus} runs={byRun} v2={v2} agentId={agent.agent_id} readOnly={readOnly} onChanged={changed} />}
        </section>
        {(["skill", "workflow"] as const).map((kind) => {
          const items = kind === "skill" ? skills : workflows;
          if (!items.length) return null;
          const title = kind === "skill" ? "Skills it learned" : "Workflows it learned";
          // The ones a person retired are no longer given to a run: under Earlier, as retired notes are.
          const inUse = items.filter((x) => x.status !== "retired");
          const gone = items.filter((x) => x.status === "retired");
          return (
            <section key={kind} className="min-w-0 space-y-3" aria-label={title}>
              <div>
                <h2 className="text-lg font-semibold">{title}</h2>
                <p className="mt-0.5 text-body text-muted-foreground">{!inUse.length ? `No ${kind} is in use: the next run gets none.` : kind === "skill" ? `${counted(inUse.length, "skill")}: how to do a job it does again, given to every later run once active.` : `${counted(inUse.length, "workflow")}: a job it does again, as steps a later run can call.`}</p>
              </div>
              {inUse.length > 0 && (
                <ul className="space-y-3">
                  {inUse.map((x) => <li key={x.file}><LearnedCard item={x} kind={kind} v2={v2} agentId={agent.agent_id} readOnly={readOnly} runs={byRun} approves={approves} onChanged={changed} /></li>)}
                </ul>
              )}
              {gone.length > 0 && <EarlierLearned kind={kind} items={gone} v2={v2} agentId={agent.agent_id} runs={byRun} readOnly={readOnly} onChanged={changed} />}
            </section>
          );
        })}
        </div>
        <aside className="min-w-0 space-y-6" aria-label="About learning">
          <Panel title="Learning">{switchRow(false)}</Panel>
          <NotKept runs={runs} />
          <NextRun index={view.index} skills={skills.filter((s) => s.status === "active").map((s) => s.name)} off={!on || server === "off"} />
        </aside>
      </div>
    </div>
  );
}

/** A refresh that failed, beside the notes read before it: why, in the problem card's words, and Try again. The server's
 *  own words and code are its tooltip. */
function RefreshFailed({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const p = problem(error, "the notes");
  const said = [p.said, p.code].filter(Boolean).join(" · ");
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border border-destructive/40 px-3 py-2 text-body" role="alert" title={said || undefined}>
      <span className="min-w-0 flex-1">Couldn't refresh the notes: {p.why.charAt(0).toLowerCase() + p.why.slice(1)} What's shown may be out of date.</span>
      <Button type="button" onClick={onRetry} size="sm">Try again</Button>
    </div>
  );
}

/** Said where the before and after goes until the server has one (it needs two runs on each side of the first note). */
const IMPACT_LATER = "After two runs on each side of its first note, this shows what learning changed.";

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

/** Before and after the agent first learned, as a flat panel like the others: the median time to its answer and the
 *  median cost of a run, each side's, how many runs the after side counts, and what learning itself costs a run when
 *  the server says. Said as the numbers are, a slower or costlier after included: a change down is in the primary colour,
 *  one up in the warning colour, and neither is ever left out. Shown only when the server has two runs on each side. */
function ImpactCard({ impact }: { impact: NonNullable<AgentLearning["impact"]> }) {
  const { before: b, after: a } = impact;
  const stats: { label: string; now: string; was: string; delta: number | null; unit?: string }[] = [
    { label: "Answers in", now: took(a.median_duration_s), was: took(b.median_duration_s), delta: change(b.median_duration_s, a.median_duration_s) },
    ...(costsShown(impact) ? [{ label: "A run costs", now: money(a.median_cost_usd!), was: money(b.median_cost_usd!), delta: change(b.median_cost_usd!, a.median_cost_usd!) }] : []),
  ];
  const learning = learningCost(impact);
  const basis = [`Medians of ${runsWord(b.runs)} before its first note and ${runsWord(a.runs)} that started from its notes.`,
    ...(typeof a.cost_runs === "number" && typeof b.cost_runs === "number" ? [`Costs are of the ${b.cost_runs} and ${a.cost_runs} runs whose cost is known.`] : [])].join(" ");
  return (
    <section className="border" aria-label={impactWords(impact)}>
      <div className="flex flex-wrap items-center gap-x-8 gap-y-4 px-4 py-3">
        <div className="flex items-baseline gap-2.5">
          <span className="caps text-small font-semibold">Since it learned</span>
          <span className="font-mono text-label text-muted-foreground" title={basis}>on {runsWord(a.runs)}</span>
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
              <dd className="font-mono text-body text-muted-foreground">{money(learning)} a run</dd>
            </div>
          )}
        </dl>
      </div>
    </section>
  );
}

/** The learning switch on the tab: a new revision with `learning` on or off, made on the agent as the server has it
 *  now, shown as it goes and put back if the save fails. */
function SavedSwitch({ agent, v2, onAgent, server, disabled, quiet }: { agent: Agent; v2: Client; onAgent?: (a: Agent) => void; server?: "on" | "off" | null; disabled?: boolean; quiet?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [trouble, setTrouble] = useState<unknown>(null);
  const [shown, setShown] = useState<boolean | null>(null);
  const flip = async (next: boolean) => {
    setBusy(true); setTrouble(null); setShown(next);
    try {
      const { agent: now, etag } = await v2.getAgent(agent.agent_id);
      const body = editBody(now, { learning: next }, next ? "Learning on" : "Learning off");
      if (body.unchanged) onAgent?.(now);
      else { const { unchanged: _u, ...send } = body; onAgent?.((await v2.updateDefinition(agent.agent_id, send, etag)).agent); }
    } catch (e) { setTrouble(e ?? new Error("unknown")); }
    setShown(null); setBusy(false);
  };
  return (
    <LearningSwitch id={`learns-${agent.agent_id}`} className="px-4 py-4" quiet={quiet} checked={shown ?? agent.definition.learning === true} onChange={(v) => void flip(v)}
      busy={busy} disabled={disabled} server={server}
      problem={trouble ? <ProblemCard problem={failed(trouble, "the agent", "Learning was not changed.")} className="mt-2" /> : null} />
  );
}

function Off({ server }: { server?: "on" | "off" | null }) {
  return (
    <Banner tone="warning">Learning is off{server === "off" ? " on this server" : ""}, so later runs don't read these notes. They're kept for when it's back on.</Banner>
  );
}

/** No note yet, as the console says a tab is empty: a bordered centred line, one sentence on what learning is, and the
 *  switch as the next step (or, with learning on, how many runs looked back). */
function Empty({ on, lookedBack, switchRow, onAdd }: { on: boolean; lookedBack: number; switchRow: ReactNode; onAdd?: () => void }) {
  return (
    <section className="mx-auto max-w-xl border" aria-label="Learning">
      <div className="px-6 py-12 text-center">
        <Sparkles className="mx-auto mb-3 size-5 text-primary-text" aria-hidden />
        <p className="font-mono text-body text-muted-foreground">{on ? "Nothing learned yet." : "Learning is off for this agent."}</p>
        <p className="mx-auto mt-2 max-w-md text-lead text-muted-foreground">
          {on ? "After each run, it looks back and keeps a note when something will help next time. Its notes show here, and every later run reads them first."
            : "With learning on, it keeps short notes on what worked after each run, and every later run reads them before it starts."}
        </p>
        {on && lookedBack > 0 && <p className="mt-3 font-mono text-small text-muted-foreground">{runsWord(lookedBack)} looked back: nothing worth keeping yet.</p>}
      </div>
      <div className="border-t">{switchRow}</div>
      {onAdd && <div className="flex justify-center border-t px-4 py-3"><Button size="sm" variant="ghost" onClick={onAdd}><Plus aria-hidden /> Or write a note yourself</Button></div>}
    </section>
  );
}

type From = { run?: { id: string; at: string; reason: string } } | undefined;

/** One note: its name, type and description, its body, where it came from and how often runs used it; Edit and Retire. */
/** `approves`: for a note that waits, whether this caller approves from the console (undefined while that is read).
 */
function NoteCard({ note, v2, agentId, readOnly, focused, from, runs, onChanged, approves }: { note: LearningNote; v2: Client; agentId: string; readOnly: boolean; focused: boolean; from: From; runs: Map<string, Run>; onChanged: () => void | Promise<void>; approves?: Approval }) {
  const [editing, setEditing] = useState(false);
  const [retiring, setRetiring] = useState(false);
  const [flash, setFlash] = useState(focused);
  const [saved, setSaved] = useState<string | null>(null);
  const [approving, setApproving] = useState(false);
  const [said, setSaid] = useState<ReactNode>(null);
  const ref = useRef<HTMLElement>(null);
  const waits = isPending(note);
  // Approve, in one click, on the version the card shows, as an edit or a retire is made.
  const approve = async () => {
    const words = (text: string) => <p className="text-small text-destructive-text" role="alert">{text}</p>;
    setApproving(true); setSaid(null);
    try {
      const seen = await seenVersion(note, () => v2.readNote(agentId, note.file));
      if (seen.kind === "changed") { setSaid(words(`${CHANGED} Reload the tab to see the newest version.`)); setApproving(false); return; }
      if (seen.kind === "unknown") { setSaid(words(NO_VERSION)); setApproving(false); return; }
      await v2.approveNote(agentId, note.file, seen.etag);
    } catch (e) {
      setApproving(false);
      setSaid(e instanceof ClientError && noteSaveError(e).kind === "conflict" ? words(`${CHANGED} Reload the tab to see the newest version.`) : <ProblemCard problem={failed(e, "the note", "The note was not approved.")} className="" />);
      return;
    }
    // It landed: Approving until the list is read again, however that read ends.
    await onChanged();
    setApproving(false);
  };
  useEffect(() => {
    if (!focused) return;
    setFlash(true);
    ref.current?.scrollIntoView?.({ block: "center", behavior: "smooth" });
    const t = setTimeout(() => setFlash(false), 2600);
    return () => clearTimeout(t);
  }, [focused]);
  useEffect(() => { if (!saved) return; const t = setTimeout(() => setSaved(null), 2400); return () => clearTimeout(t); }, [saved]);
  if (editing) return <NoteEditor title="Edit note" v2={v2} agentId={agentId} file={note.file} seen={note} onDone={(ok) => { setEditing(false); if (ok) { setSaved("Saved"); onChanged(); } }} />;
  const body = bodyOf(note.text);
  // Its newest change by a person (or a run's other than the learning), as the server names it (last_change); none
  // when it names none.
  const person = lastChangeLine(note.last_change);
  return (
    <article ref={ref} id={`note-${note.file}`} tabIndex={-1} aria-label={note.name} className={cn("border bg-card/40 outline-none focus-visible:border-primary transition-[border-color,box-shadow] duration-slow", flash && "border-primary ring-1 ring-primary")}>
      <header className="flex flex-col gap-x-3 gap-y-1 px-5 pt-4 sm:flex-row sm:items-start">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="min-w-0 break-words text-prose font-semibold leading-snug">{note.name}</h3>
            <Chip>{typeLabel(note.type)}</Chip>
            {originOf(note) === "you" && <Chip tone="muted">From you</Chip>}
            {saved && <span className="caps text-micro text-success-text" role="status">{saved}</span>}
          </div>
          <p className="mt-1 text-body text-muted-foreground">{note.description}</p>
          {waits && (approves === "later" || approves === "password") && <p className="mt-2 font-mono text-label text-muted-foreground">{approves === "password" ? APPROVE_SIGN_IN : APPROVE_LATER}</p>}
        </div>
        {!readOnly && !retiring && (
          <div className="-ml-3 flex shrink-0 items-center gap-1 sm:ml-0">
            {waits ? approves === "yes" && <Button size="sm" variant="solid" onClick={() => void approve()} disabled={approving} aria-label={`Approve ${note.name}`}>{approving ? "Approving" : "Approve"}</Button>
              : <Button size="sm" variant="ghost" onClick={() => setEditing(true)} aria-label={`Edit ${note.name}`}><Pencil aria-hidden /> Edit</Button>}
            <Button size="sm" variant="destructive" onClick={() => setRetiring(true)} aria-label={`Retire ${note.name}`}>Retire</Button>
          </div>
        )}
      </header>
      {said && <div className="px-5 pt-3">{said}</div>}
      {body.trim() && <Body text={body} />}
      <footer className="flex flex-wrap items-center gap-x-5 gap-y-1.5 border-t px-5 py-2.5 font-mono text-label text-muted-foreground">
        {from?.run && <LearnedIn run={from.run.id} runs={runs} at={from.run.at} reason={from.run.reason} />}
        {person && <span className="flex items-center gap-1.5"><User className="size-3" aria-hidden />{person}</span>}
        {/* As the server counts them: the runs it was given to, and the runs that opened it (once one did). */}
        <span className="flex items-center gap-1.5"><BookOpen className="size-3" aria-hidden />Given to {runsWord(note.runs.given)}</span>
        {note.runs.read > 0 && <span className="flex items-center gap-1.5"><BookOpen className="size-3" aria-hidden />Read in {runsWord(note.runs.read)}</span>}
      </footer>
      {retiring && <RetireConfirm name={note.name} kind="note" retire={async () => {
        const seen = await seenVersion(note, () => v2.readNote(agentId, note.file));
        if (seen.kind === "changed") return `${CHANGED} Reload the tab to see the newest version.`;
        if (seen.kind === "unknown") return NO_VERSION;
        await v2.retireNote(agentId, note.file, seen.etag);
        return null;
      }} onDone={async (ok) => { if (ok) await onChanged(); setRetiring(false); }} />}
    </article>
  );
}

/** A skill or a workflow the agent learned, in use or waiting: its name, what it is for, the run that kept it, whether it
 *  waits for the owner's OK (Approve where this caller approves), and its text, read when it is opened. Approve and
 *  Retire (after the notes' confirm) are made on the file that says whether it is in use, a skill's SKILL.md or a
 *  workflow's README, at the version listed, or an open skill's shown. A run changes it; a person approves or retires
 *  it, never edits it. */
function LearnedCard({ item, kind, v2, agentId, readOnly, runs, approves, onChanged }: { item: LearnedItem; kind: "skill" | "workflow"; v2: Client; agentId: string; readOnly: boolean; runs: Map<string, Run>; approves?: Approval; onChanged: () => void | Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState<string | null>(null);
  // The version of the text shown: a skill is approved on it, never on a newer one the list holds (its etag).
  const [shown, setShown] = useState<string | null>(null);
  const [readError, setReadError] = useState<unknown>(null);
  const [approving, setApproving] = useState(false);
  const [retiring, setRetiring] = useState(false);
  const [said, setSaid] = useState<ReactNode>(null);
  const waits = item.status === "pending";
  const load = async () => {
    setReadError(null);
    setText(null);
    setShown(null);
    try { const read = await v2.readNote(agentId, item.file); setText(read.note); setShown(read.etag); } catch (e) { setReadError(e ?? new Error("unknown")); }
  };
  const show = async () => {
    if (open) return setOpen(false);
    setOpen(true);
    if (text === null) await load();
  };
  // The list moved to another version: a text shown of the old one goes, and an open card reads the new one.
  useEffect(() => {
    if (text === null && shown === null) return;
    if (open) void load();
    else { setText(null); setShown(null); }
  }, [item.etag]); // eslint-disable-line react-hooks/exhaustive-deps
  // The version an approve or a retire is made on: an open skill's, the one shown; else the list's (a workflow's text read
  // is its workflow.json, never the README either one names).
  const version = kind === "skill" && open && shown ? shown : item.etag;
  const approve = async () => {
    setApproving(true); setSaid(null);
    try {
      await v2.approveNote(agentId, statusFile(item), version);
    } catch (e) {
      setApproving(false);
      setSaid(e instanceof ClientError && noteSaveError(e).kind === "conflict" ? <p className="text-small text-destructive-text" role="alert">{`${CHANGED} Reload the tab to see the newest version.`}</p> : <ProblemCard problem={failed(e, `the ${kind}`, `The ${kind} was not approved.`)} className="" />);
      return;
    }
    // It landed: Approving until the list is read again, however that read ends.
    await onChanged();
    setApproving(false);
  };
  const label = `the ${kind} ${item.name}`;
  return (
    <article aria-label={item.name} className="border bg-card/40">
      <header className="flex flex-col gap-x-3 gap-y-1 px-5 pt-4 sm:flex-row sm:items-start">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="min-w-0 break-words font-mono text-lead font-semibold leading-snug">{item.name}</h3>
            {waits && <Chip tone="warning"><Hourglass className="size-3" aria-hidden />Waits for your OK</Chip>}
          </div>
          {item.description && <p className="mt-1 text-body text-muted-foreground">{item.description}</p>}
          {waits && (approves === "later" || approves === "password") && <p className="mt-2 font-mono text-label text-muted-foreground">{approves === "password" ? APPROVE_SIGN_IN : APPROVE_LATER}</p>}
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
        : kind === "skill" ? <Body text={bodyOf(text)} />
        : <pre className="mx-5 mt-3 max-h-80 overflow-auto border bg-background p-3 font-mono text-small">{text}</pre>)}
      <footer className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1.5 border-t px-5 py-2.5 font-mono text-label text-muted-foreground">
        {item.run && <LearnedIn run={item.run} runs={runs} />}
        {lastChangeLine(item.last_change) && <span className="flex items-center gap-1.5"><User className="size-3" aria-hidden />{lastChangeLine(item.last_change)}</span>}
        <span>{item.bytes < 1024 ? `${item.bytes} B` : `${(item.bytes / 1024).toFixed(1)} KB`}</span>
      </footer>
      {retiring && <RetireConfirm name={item.name} kind={kind} retire={async () => { await v2.retireNote(agentId, statusFile(item), version); return null; }} onDone={async (ok) => { if (ok) await onChanged(); setRetiring(false); }} />}
    </article>
  );
}

/** A newest change the server names, in words with when ("Approved by you · Nov 5, 7:30 PM"); none for a run's learning,
 *  which "Learned in" says, or when the server names no change. */
function lastChangeLine(last: LastChange | undefined): string | null {
  return last && last.kind !== "learned" ? `${changeWords(last.kind, last.by)} · ${when(last.at)}` : null;
}

/** Who retired one and when, as the server names it (`retired`), else just "Retired". */
function retiredLine(retired: Retired | undefined): string {
  return retired ? `${changeWords("retired", retired.by)} · ${when(retired.at)}` : "Retired";
}

/** "Learned in" the run that kept it, linked by its short id (its whole title on hover), and when (`at`), with why it
 *  was kept as the hover (`reason`). */
function LearnedIn({ run, runs, at, reason }: { run: string; runs: Map<string, Run>; at?: string; reason?: string }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5"><span className="flex shrink-0 items-center gap-1.5 whitespace-nowrap" title={reason ? `Kept because: ${reason}` : undefined}><Sparkles className="size-3 shrink-0 text-primary-text" aria-hidden />Learned in</span>
      <a href={`#/runs/${encodeURIComponent(run)}`} className="shrink-0 font-mono text-foreground/80 underline-offset-2 hover:text-foreground hover:underline" title={runTitle(runs, run)}>{runLabel(run)}</a>
      {at && <span className="shrink-0">· {when(at)}</span>}
    </span>
  );
}

/** A note's body, cut to a few lines with a way to show it whole when it is long. */
function Body({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const long = text.split("\n").length > 8 || text.length > 520;
  const html = useMemo(() => markdown(text), [text]);
  return (
    <div className="px-5 pb-4 pt-3">
      <div className={cn("relative", long && !open && "max-h-[9.5rem] overflow-hidden")}>
        <div className={PROSE} dangerouslySetInnerHTML={{ __html: html }} />
        {long && !open && <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-background to-transparent" aria-hidden />}
      </div>
      {long && <button type="button" onClick={() => setOpen((o) => !o)} className="caps mt-2 flex items-center gap-1 text-label text-muted-foreground hover:text-foreground"><ChevronDown className={cn("size-3.5 transition-transform", open && "rotate-180")} aria-hidden />{open ? "Show less" : "Show all"}</button>}
    </div>
  );
}

/** What a retire does, said in its confirm: a note is no longer read, a skill or a workflow no longer given to a run. */
const RETIRES: Record<"note" | "skill" | "workflow", string> = {
  note: "Later runs stop reading it. It stays under Earlier notes.",
  skill: "Later runs stop getting it. It stays under Earlier skills.",
  workflow: "Later runs stop getting it. It stays under Earlier workflows.",
};

/** Retire, after a confirm in place as the run header's cancel is: "Yes, retire" takes the focus, so Enter retires,
 *  and Esc or Keep keeps it. `retire` makes it on the version the card showed, and answers why it did not, or null: a
 *  note changed since is never retired unseen (seenVersion), it says so instead, and one the server names no version of
 *  is not retired either. A 412, made on a version changed since, says so in the same words. */
function RetireConfirm({ name, kind, retire, onDone }: { name: string; kind: "note" | "skill" | "workflow"; retire: () => Promise<string | null>; onDone: (retired: boolean) => void | Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<ReactNode>(null);
  const yes = useRef<HTMLButtonElement>(null);
  useEffect(() => { yes.current?.focus(); }, []);
  const words = (text: string) => <p className="text-small text-destructive-text" role="alert">{text}</p>;
  const go = async () => {
    setBusy(true); setSaid(null);
    try {
      const not = await retire();
      if (not !== null) { setBusy(false); setSaid(words(not)); return; }
    } catch (e) {
      setBusy(false);
      setSaid(e instanceof ClientError && noteSaveError(e).kind === "conflict" ? words(`${CHANGED} Reload the tab to see the newest version.`) : <ProblemCard problem={failed(e, `the ${kind}`, `The ${kind} was not retired.`)} className="" />);
      return;
    }
    // It landed: Retiring until the card's owner has read the list again (and closed this), however that read ends.
    await onDone(true);
  };
  return (
    <div role="alertdialog" aria-label={`Retire ${name}?`} onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); void onDone(false); } }}
      className="flex flex-wrap items-center gap-3 border-t border-destructive/40 bg-destructive/5 px-5 py-3">
      <p className="min-w-0 flex-1 text-body"><span className="font-semibold">Retire it?</span> {RETIRES[kind]}</p>
      {said && <div className="w-full">{said}</div>}
      <Button ref={yes} size="sm" variant="destructive" onClick={() => void go()} disabled={busy}>{busy ? "Retiring" : "Yes, retire"}</Button>
      <Button size="sm" variant="ghost" onClick={() => void onDone(false)} disabled={busy}>Keep</Button>
    </div>
  );
}

/** Restore a retired one, after a confirm: `restore` is made on the version its row shows (If-Match), and the tab is read
 *  again (`onChanged`). A version changed since says so and reads it again; one no longer retired (restored elsewhere)
 *  reads it again; a token is told restoring takes the password sign-in; a refusal by the checks a new one passes shows
 *  the server's words, and it stays retired. */
function RestoreConfirm({ name, kind, from, restore, onChanged, onDone }: { name: string; kind: "note" | "skill" | "workflow"; from: Retired["from"] | undefined; restore: () => Promise<unknown>; onChanged: () => void | Promise<void>; onDone: () => void }) {
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
      return void setSaid(<ProblemCard problem={failed(e, `the ${kind}`, `The ${kind} was not restored.`)} className="" />);
    }
    // It landed: the tab is read again (a note's restore also marks what it supersedes), then the confirm goes.
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

/** A note to edit (`file`, opened on the version its card showed: `seen`) or a new one: name, description and type as
 *  fields, the body as markdown. ⌘/Ctrl+Enter saves anywhere in it and Enter saves in a one-line field; Esc cancels. A
 *  note that changed since the card showed it opens on its newest version, and says so. One that changes while it is
 *  open is not written over: the save is refused, the newest version loads, and the edit stays below to copy. A note
 *  the server names no version of is never saved (no empty If-Match). */
function NoteEditor({ title, v2, agentId, file, seen, taken: names = [], onDone }: { title: string; v2: Client; agentId: string; file?: string; seen?: LearningNote; taken?: string[]; onDone: (saved: boolean) => void }) {
  const [parts, setParts] = useState<NoteParts | null>(file ? null : { name: "", description: "", type: "feedback", body: "\n", rest: [] });
  const [etag, setEtag] = useState<string | null>(null);
  const [readError, setReadError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<NoteProblem[]>([]);
  const [trouble, setTrouble] = useState<unknown>(null);
  const [taken, setTaken] = useState(false);
  const [stale, setStale] = useState<string | null>(null);
  const [moved, setMoved] = useState(false);
  const first = useRef<HTMLInputElement>(null);
  /** The note as the server has it now. */
  const reload = async () => {
    if (!file) return;
    try { const n = await v2.readNote(agentId, file); setParts(noteParts(n.note)); setEtag(n.etag); setReadError(null); } catch (e) { setReadError(e ?? new Error("unknown")); }
  };
  /** The note as its card showed it, or its newest version, said so, when it changed since. */
  const open = async () => {
    if (!file || !seen) return reload();
    try {
      const v = await seenVersion(seen, () => v2.readNote(agentId, file));
      if (v.kind === "same") { setParts(noteParts(v.text)); setEtag(v.etag); }
      else if (v.kind === "changed") { setParts(noteParts(v.now.note)); setEtag(v.now.etag); setMoved(true); }
      else { setParts(noteParts(seen.text)); setEtag(null); }
    } catch (e) { setReadError(e ?? new Error("unknown")); }
  };
  useEffect(() => { void open(); }, [file]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (parts) first.current?.focus(); }, [parts === null]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (p: Partial<NoteParts>) => setParts((x) => (x ? { ...x, ...p } : x));
  const ready = !!parts && parts.name.trim() !== "" && parts.description.trim() !== "" && !busy;
  const save = async () => {
    if (!parts || !ready) return;
    setTrouble(null); setProblems([]); setTaken(false);
    if (file && !etag) { setTrouble(NO_VERSION); return; }
    setBusy(true);
    const text = noteText(parts);
    try {
      await v2.writeNote(agentId, file ?? fileFor(parts.name, names), text, file ? { etag: etag ?? "" } : { create: true });
      onDone(true);
    } catch (e) {
      setBusy(false);
      const p = e instanceof ClientError ? noteSaveError(e, !file) : null;
      // Someone, or a run, changed it since it was opened: show the newest, keep this edit to copy.
      if (p?.kind === "conflict") { setStale(text); setMoved(false); await reload(); }
      else if (p?.kind === "refused") setProblems(p.problems);
      else if (p?.kind === "taken") setTaken(true);
      else setTrouble(e ?? new Error("unknown"));
    }
  };
  const keys = (e: KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onDone(false); }
    else if (e.key === "Enter" && (e.metaKey || e.ctrlKey || (e.target as HTMLElement).tagName === "INPUT")) { e.preventDefault(); void save(); }
  };
  return (
    <section className="border border-border-strong bg-card" aria-label={title} onKeyDown={keys}>
      <div className="flex items-center gap-3 border-b px-5 py-2.5">
        <h3 className="caps text-label font-semibold">{title}</h3>
        <span className="ml-auto hidden font-mono text-label text-muted-foreground sm:inline"><kbd>{MAC ? "⌘" : "Ctrl"}+Enter</kbd> save · <kbd>Esc</kbd> cancel</span>
      </div>
      {readError !== null && <ProblemCard problem={problem(readError, "the note")} onRetry={() => { setReadError(null); void open(); }} className="m-5" />}
      {!parts && readError === null && <div className="space-y-3 p-5" role="status" aria-label="Loading the note"><div aria-hidden className="h-9 bg-muted motion-safe:animate-pulse" /><div aria-hidden className="h-24 bg-muted/70 motion-safe:animate-pulse" /></div>}
      {parts && (
        <div className="space-y-4 px-5 py-4">
          {moved && !stale && (
            <div className="border border-warning/50 bg-warning/10 px-4 py-3 text-body" role="status">
              <p className="flex items-center gap-2 font-semibold"><TriangleAlert className="size-4 text-warning-text" aria-hidden />Changed since you opened it</p>
              <p className="mt-1 text-muted-foreground">This is the newest version, not the one the card showed.</p>
            </div>
          )}
          {stale && (
            <div className="border border-warning/50 bg-warning/10 px-4 py-3 text-body" role="alert">
              <p className="flex items-center gap-2 font-semibold"><TriangleAlert className="size-4 text-warning-text" aria-hidden />Changed since you opened it</p>
              <p className="mt-1 text-muted-foreground">This is the newest version. Your edit wasn't saved; it's below to copy.</p>
              <details className="mt-2"><summary className="caps cursor-pointer text-label text-muted-foreground hover:text-foreground">Your edit</summary><pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words border bg-background p-3 font-mono text-small">{stale}</pre></details>
            </div>
          )}
          <label className="block"><span className="caps mb-1.5 block text-label font-semibold">Name</span>
            <Input ref={first} value={parts.name} onChange={(e) => set({ name: e.target.value })} placeholder="e.g., Try /policies/refund-policy first" /></label>
          <label className="block"><span className="caps mb-1.5 block text-label font-semibold">Description</span>
            <span className="-mt-0.5 mb-1.5 block text-small text-muted-foreground">One line: what the next run sees before it opens the note.</span>
            <Input value={parts.description} onChange={(e) => set({ description: e.target.value })} placeholder="When it applies, and what to do" /></label>
          <fieldset>
            <legend className="caps mb-1.5 text-label font-semibold">Type</legend>
            <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Type">
              {NOTE_TYPES.map((t) => (
                <label key={t} className={cn("caps cursor-pointer border px-3 py-1.5 text-label", parts.type === t ? "border-foreground" : "text-muted-foreground hover:text-foreground")} title={t}>
                  <input type="radio" name={`type-${file ?? "new"}`} className="sr-only" checked={parts.type === t} onChange={() => set({ type: t })} />{typeLabel(t)}
                </label>
              ))}
            </div>
            <p className="mt-1.5 text-small text-muted-foreground">{TYPE_HINT[parts.type]}</p>
          </fieldset>
          <label className="block"><span className="caps mb-1.5 block text-label font-semibold">Note</span>
            <Textarea value={parts.body.replace(/^\n/, "")} onChange={(e) => set({ body: `\n${e.target.value}` })} rows={7} placeholder="What to do, and why. Markdown." className="resize-y leading-[1.65]" /></label>
          {problems.length > 0 && (
            <div className="border border-destructive/50 bg-destructive/5 px-4 py-3 text-body" role="alert">
              <p className="font-semibold text-destructive-text">Not saved: the note doesn't pass the checks.</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-5">{problems.map((p, i) => <li key={i}>{p.detail}</li>)}</ul>
            </div>
          )}
          {taken && <p className="text-body text-destructive-text" role="alert">Not saved: a note by this name exists already. Change its name.</p>}
          {trouble === NO_VERSION ? <p className="text-body text-destructive-text" role="alert">Not saved: {NO_VERSION}</p>
            : trouble !== null && <ProblemCard problem={failed(trouble, "the note", "The note was not saved.")} className="" />}
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="solid" onClick={() => void save()} disabled={!ready}>{busy ? "Saving" : file ? "Save" : "Add note"}</Button>
            <Button size="sm" variant="ghost" onClick={() => onDone(false)} disabled={busy}>Cancel</Button>
            {!file && parts.name.trim() && <span className="ml-auto font-mono text-label text-muted-foreground">{fileFor(parts.name, names)}</span>}
          </div>
        </div>
      )}
    </section>
  );
}

/** The notes no longer in use: replaced by a newer one, or retired. Closed until asked; one a link points at opens it. */
function Earlier({ notes: list, all, from, focus, runs, v2, agentId, readOnly, onChanged }: { notes: LearningNote[]; all: LearningNote[]; from: ReturnType<typeof provenance>; focus: string[]; runs: Map<string, Run>; v2: Client; agentId: string; readOnly: boolean; onChanged: () => void | Promise<void> }) {
  const [restoring, setRestoring] = useState<string | null>(null);
  const [open, setOpen] = useState(list.some((x) => focus.includes(x.file)));
  // The retired notes opened to their text: read-only, as no later run reads them.
  const [shown, setShown] = useState<Set<string>>(new Set());
  const toggle = (file: string) => setShown((s) => { const n = new Set(s); if (n.has(file)) n.delete(file); else n.add(file); return n; });
  // A note a link points at that arrives with a later page opens the list too.
  const pointed = list.some((x) => focus.includes(x.file));
  useEffect(() => { if (pointed) setOpen(true); }, [pointed]);
  const nameOf = (file: string | null) => all.find((x) => x.file === file)?.name ?? file;
  // To the note that replaced it: scrolled to, and the focus on it.
  const toNote = (file: string) => {
    const card = document.getElementById(`note-${file}`);
    card?.scrollIntoView?.({ block: "center", behavior: "smooth" });
    card?.focus({ preventScroll: true });
  };
  return (
    <Folded title="Earlier notes" count={`${list.length} no longer read`} open={open} onToggle={() => setOpen((o) => !o)}>
      {list.map((x) => {
        const retired = x.status === "retired";
        const opened = retired && shown.has(x.file);
        const run = from.get(x.file)?.run;
        return (
          <li key={x.file} id={`note-${x.file}`} className={cn("border-b px-4 py-3 last:border-b-0", focus.includes(x.file) && "bg-primary/5")}>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-lead text-muted-foreground line-through decoration-muted-foreground/40">{x.name}</span>
              <Chip tone="muted">{retired ? "Retired" : "Replaced"}</Chip>
              {retired && <ShowButton open={opened} label={`the note ${x.name}`} onClick={() => toggle(x.file)} />}
              {retired && !readOnly && x.etag && restoring !== x.file && <Button size="sm" onClick={() => setRestoring(x.file)} aria-label={`Restore ${x.name}`}><RotateCcw aria-hidden /> Restore</Button>}
            </div>
            <p className="mt-1 font-mono text-label text-muted-foreground">
              {x.status === "superseded" && x.superseded_by ? <>Replaced by <button type="button" onClick={() => toNote(x.superseded_by!)} className="text-foreground/80 underline-offset-2 hover:text-foreground hover:underline">{nameOf(x.superseded_by)}</button></> : retired ? retiredLine(x.retired) : null}
            </p>
            {restoring === x.file && <div className="-mx-4 mt-2"><RestoreConfirm name={x.name} kind="note" from={x.retired?.from} restore={() => v2.restoreNote(agentId, x.file, x.etag!)} onChanged={onChanged} onDone={() => setRestoring(null)} /></div>}
            {opened && (
              <div className="-mx-4 mt-2 border-t pt-1">
                <p className="mt-2 px-5 text-body text-muted-foreground">{x.description}</p>
                {bodyOf(x.text).trim() && <Body text={bodyOf(x.text)} />}
                {run && <p className="mt-3 flex px-5 font-mono text-label text-muted-foreground"><LearnedIn run={run.id} runs={runs} at={run.at} reason={run.reason} /></p>}
              </div>
            )}
          </li>
        );
      })}
    </Folded>
  );
}

/** A closed list under its caps title and count, opened on a click: the notes, skills and workflows no longer in use. */
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

/** The skills or the workflows a person retired, as retired notes are shown: closed until asked, each by its name, and
 *  who retired it and when once the changes read say. No Approve and no Retire: no later run is given it. */
function EarlierLearned({ kind, items, v2, agentId, runs, readOnly, onChanged }: { kind: "skill" | "workflow"; items: LearnedItem[]; v2: Client; agentId: string; runs: Map<string, Run>; readOnly: boolean; onChanged: () => void | Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [restoring, setRestoring] = useState<string | null>(null);
  // The ones opened to their text, read from the file when opened (a skill's SKILL.md, a workflow's workflow.json).
  const [shown, setShown] = useState<Set<string>>(new Set());
  const toggle = (file: string) => setShown((s) => { const n = new Set(s); if (n.has(file)) n.delete(file); else n.add(file); return n; });
  return (
    <Folded title={kind === "skill" ? "Earlier skills" : "Earlier workflows"} count={`${items.length} no longer given`} open={open} onToggle={() => setOpen((o) => !o)}>
      {items.map((x) => {
        return (
          <li key={x.file} className="border-b px-4 py-3 last:border-b-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-body text-muted-foreground line-through decoration-muted-foreground/40">{x.name}</span>
              <Chip tone="muted">Retired</Chip>
              <ShowButton open={shown.has(x.file)} label={`the ${kind} ${x.name}`} onClick={() => toggle(x.file)} />
              {!readOnly && restoring !== x.file && <Button size="sm" onClick={() => setRestoring(x.file)} aria-label={`Restore ${x.name}`}><RotateCcw aria-hidden /> Restore</Button>}
            </div>
            {x.description && <p className="mt-1 text-small text-muted-foreground">{x.description}</p>}
            <p className="mt-1 font-mono text-label text-muted-foreground">{retiredLine(x.retired)}</p>
            {/* Restored by the file that says whether it is in use (a skill's SKILL.md, a draft's README), on the listed version. */}
            {restoring === x.file && <div className="-mx-4 mt-2"><RestoreConfirm name={x.name} kind={kind} from={x.retired?.from} restore={() => v2.restoreNote(agentId, statusFile(x), x.etag)} onChanged={onChanged} onDone={() => setRestoring(null)} /></div>}
            {shown.has(x.file) && (
              <div className="-mx-4 mt-2 border-t pt-1">
                <FileText v2={v2} agentId={agentId} file={x.file} etag={x.etag} kind={kind} label={`the ${kind} ${x.name}`} />
                {x.run && <p className="mt-3 flex px-5 font-mono text-label text-muted-foreground"><LearnedIn run={x.run} runs={runs} /></p>}
              </div>
            )}
          </li>
        );
      })}
    </Folded>
  );
}

/** Show or Hide, for a thing opened to its text in place: `label` names it for a screen reader ("the note …"). */
function ShowButton({ open, label, onClick }: { open: boolean; label: string; onClick: () => void }) {
  return <Button size="sm" variant="ghost" className="ml-auto" onClick={onClick} aria-expanded={open} aria-label={`${open ? "Hide" : "Show"} ${label}`}><ChevronDown className={cn("transition-transform", open && "rotate-180")} aria-hidden />{open ? "Hide" : "Show"}</Button>;
}

/** A learned file's text, read when shown (GET …/learning/files/{file}, retired ones too): a skill's as its body, a
 *  workflow's JSON as it is. Read again when the list moves to another version of it (`etag`), as LearnedCard does. */
function FileText({ v2, agentId, file, etag, kind, label }: { v2: Client; agentId: string; file: string; etag: string; kind: "skill" | "workflow"; label: string }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  // The newest read wins: one started before (an older version's, or a retry's) that answers late is dropped.
  const reads = useRef(0);
  const load = async () => {
    const n = ++reads.current;
    setError(null); setText(null);
    try { const read = await v2.readNote(agentId, file); if (n === reads.current) setText(read.note); } catch (e) { if (n === reads.current) setError(e ?? new Error("unknown")); }
  };
  useEffect(() => { void load(); }, [file, etag]); // eslint-disable-line react-hooks/exhaustive-deps
  if (error !== null) return <div className="px-5 pt-3"><ProblemCard problem={problem(error, label)} onRetry={() => void load()} className="" /></div>;
  if (text === null) return <div className="px-5 pt-3" role="status" aria-label={`Loading ${label}`}><div aria-hidden className="h-16 bg-muted motion-safe:animate-pulse" /></div>;
  return kind === "skill" ? <Body text={bodyOf(text)} /> : <pre className="mx-5 mt-3 max-h-80 overflow-auto border bg-background p-3 font-mono text-small">{text}</pre>;
}

/** The latest runs that kept nothing, and why, in plain words: notes turned away, skips and stops, newest first. Runs
 *  with nothing new to remember are counted, not listed. */
function NotKept({ runs }: { runs: Run[] }) {
  const dropped = runs.filter((r) => r.learning?.state === "dropped");
  const listed = dropped.filter((r) => dropKind(r.learning!.reason) !== "nothing").slice(0, 6);
  const nothing = dropped.length - dropped.filter((r) => dropKind(r.learning!.reason) !== "nothing").length;
  if (!dropped.length) return null;
  return (
    // Each run's sentence as the server says it ("Not kept: …", "Not kept, with the skill …: …"), under a title that does
    // not say it again.
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
      {nothing > 0 && <p className={cn("px-4 py-3 font-mono text-label text-muted-foreground", listed.length > 0 && "border-t")}>{listed.length ? `${nothing} more ${nothing === 1 ? "run" : "runs"} had` : `${runsWord(nothing)} had`} nothing new to remember.</p>}
    </Panel>
  );
}

/** What the next run reads: the index first, one line a note in use (so its lines are counted as notes), built by the
 *  server from the notes, and the agent's active skills by name (one that waits for its owner's OK is given to no run;
 *  the server may still leave an active one out of a run, over its budget, so they are the agent's, not a promise).
 *  `off`: learning is off, for the agent or on this server, and the next run gets neither. Read-only. */
function NextRun({ index, skills, off }: { index: string; skills: string[]; off: boolean }) {
  const [open, setOpen] = useState(false);
  const lines = off ? 0 : index.split("\n").filter((l) => l.trim()).length;
  // The index as Markdown, sanitized (markdown(): HTML a run wrote reads as text). A note's file is no address here, so
  // its link reads as its name.
  const rendered = useMemo(() => markdown(index.trim()), [index]);
  const active = off ? [] : skills;
  const given = active.length ? `${active.length} ${active.length === 1 ? "skill" : "skills"}` : "";
  return (
    <section className="border" aria-label="What the next run reads">
      <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-2 px-4 py-3 text-left hover:bg-accent">
        <ChevronDown className={cn("size-3.5 text-muted-foreground transition-transform", !open && "-rotate-90")} aria-hidden />
        <span className="caps text-small font-semibold">What the next run reads</span>
        <span className="ml-auto font-mono text-label text-muted-foreground">{[lines ? notes(lines) : "", given].filter(Boolean).join(" · ") || "nothing"}</span>
      </button>
      {open && (
        <div className="border-t">
          {off ? <p className="px-4 py-3 text-body text-muted-foreground">Learning is off: the next run gets no notes or skills.</p>
            : lines ? <div className={cn(PROSE, "max-h-72 overflow-auto break-words px-4 py-3 text-body")} dangerouslySetInnerHTML={{ __html: rendered }} />
            : <p className="px-4 py-3 text-body text-muted-foreground">{active.length ? "No note is in use." : "Nothing yet: no note is in use."}</p>}
          {active.length > 0 && <p className="break-words border-t px-4 py-3 font-mono text-small leading-[1.7]">Active skills: {active.join(", ")}</p>}
          <p className="border-t px-4 py-2 text-label text-muted-foreground">Read-only: the notes in use, one line each, and the agent's active skills.</p>
        </div>
      )}
    </section>
  );
}

