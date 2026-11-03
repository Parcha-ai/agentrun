import { ArrowRight, BookOpen, ChevronDown, Pencil, Plus, RotateCw, Sparkles, TriangleAlert, User } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import { LearningSwitch } from "@/components/LearningSwitch";
import { type Agent, editBody } from "@/lib/agentForm";
import { type Client, ClientError } from "@/lib/client";
import { markdown, when } from "@/lib/format";
import {
  type AgentLearning, bodyOf, change, dollars, dropKind, dropWords, fileFor, impactWords, type LearningNote, type NoteParts, noteParts,
  type NoteProblem, notes, noteText, NOTE_TYPES, provenance, runsWord, seconds, shortTitle, shownImpact, TYPE_HINT, typeLabel, usedBy,
} from "@/lib/learning";
import { cn } from "@/lib/utils";
import type { Run } from "@/lib/v2";

/** `server`: the server's own learning switch (capabilities `features.learning`); "off" means no run learns there. */
export type LearningProps = { agent: Agent; v2: Client; focus?: string[]; server?: "on" | "off" | null; onAgent?: (agent: Agent) => void };

const problemOf = (e: unknown) => (e instanceof ClientError ? e.message : e instanceof Error ? e.message : String(e));
const runTitle = (runs: Map<string, Run>, id: string) => runs.get(id)?.title || `run ${id.slice(0, 8)}`;
/** A rendered note body: markdown, sanitized, in the console's type at a note's size. */
const PROSE = "text-[14px] leading-[1.65] [&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2 [&_code]:bg-muted [&_code]:px-1 [&_code]:font-mono [&_code]:text-[12.5px] [&_h1]:mb-2 [&_h1]:text-[15px] [&_h1]:font-semibold [&_h2]:mb-2 [&_h2]:mt-3 [&_h2]:text-[14px] [&_h2]:font-semibold [&_h3]:mt-3 [&_h3]:font-semibold [&_li]:mb-0.5 [&_ol]:mb-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:mb-2 [&_p:last-child]:mb-0 [&_pre]:mb-2 [&_pre]:overflow-x-auto [&_pre]:border [&_pre]:bg-background [&_pre]:p-3 [&_pre]:font-mono [&_pre]:text-[12px] [&_ul]:mb-2 [&_ul]:list-disc [&_ul]:pl-5";
/** Whether the keyboard's save is ⌘ or Ctrl, as the editor's hint names it (both save). */
const MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const field = "w-full border bg-background px-3 py-2 font-mono text-[13px] outline-none placeholder:text-muted-foreground focus:border-border-strong";

/** The agent's Learning tab: the notes it wrote for itself after its runs, which every later run reads first. Each note
 *  shows where it came from and how often it was used, and a person edits it (its version named, so a change made since
 *  is never written over), retires it, or adds one. Beside them: the learning switch, what runs did not keep and why, the
 *  before and after once there is one, and what the next run reads. */
export function LearningTab({ agent, v2, focus = [], server, onAgent }: LearningProps) {
  const [view, setView] = useState<AgentLearning | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [later, setLater] = useState<{ items: LearningNote[]; cursor: string | null; error?: string }>({ items: [], cursor: null });
  const [adding, setAdding] = useState(false);
  const asked = useRef(0);
  const read = () => {
    const n = ++asked.current;
    setError(null);
    v2.agentLearning(agent.agent_id).then((r) => { if (n === asked.current) { setView(r); setLater({ items: [], cursor: r.notes.next_cursor }); } }, (e) => { if (n === asked.current) setError(problemOf(e)); });
    // The agent's latest runs: what each read and kept, the titles a note's source is named by, and the drops.
    v2.listAgentRuns(agent.agent_id, 50, null, !!agent.archived_at).then((r) => { if (n === asked.current) setRuns(r.runs); }, () => {});
  };
  useEffect(read, [v2, agent.agent_id]); // eslint-disable-line react-hooks/exhaustive-deps
  const more = () => {
    if (!later.cursor) return;
    v2.learningNotes(agent.agent_id, later.cursor).then(
      (p) => setLater((x) => ({ items: [...x.items, ...p.items.filter((i) => !x.items.some((y) => y.file === i.file))], cursor: p.next_cursor })),
      (e) => setLater((x) => ({ ...x, error: problemOf(e) })),
    );
  };

  const on = agent.definition.learning === true;
  const readOnly = !!agent.archived_at;
  const all = useMemo(() => [...(view?.notes.items ?? []), ...later.items], [view, later.items]);
  const active = all.filter((x) => x.status === "active");
  const earlier = all.filter((x) => x.status !== "active");
  const byRun = useMemo(() => new Map(runs.map((r) => [r.run_id, r])), [runs]);
  const from = useMemo(() => provenance(view?.log.items ?? []), [view]);
  // How many of the runs read here used each note: shown only by a server that says what a run read.
  const usedIn = useMemo(() => {
    const out = new Map<string, number>();
    for (const r of runs) for (const u of usedBy(r.learning)) out.set(u.file, (out.get(u.file) ?? 0) + 1);
    return out;
  }, [runs]);
  const lookedBack = runs.filter((r) => r.learning && (r.learning.state === "merged" || r.learning.state === "dropped")).length;

  if (error && !view) return (
    <div className="border p-5" role="alert">
      <p className="text-[14px] text-destructive-text">What this agent learned could not be read: {error}</p>
      <Button size="sm" className="mt-3" onClick={read}><RotateCw aria-hidden /> Try again</Button>
    </div>
  );
  if (!view) return <Skeleton />;

  const switchRow = (quiet: boolean) => <SavedSwitch agent={agent} v2={v2} onAgent={onAgent} server={server} disabled={readOnly} quiet={quiet} />;
  if (!all.length && !adding) return (
    <div className="space-y-6">
      <Empty on={on} lookedBack={lookedBack} switchRow={switchRow(true)} onAdd={readOnly ? undefined : () => setAdding(true)} />
      <NotKept runs={runs} />
    </div>
  );

  return (
    <div className="space-y-6">
      {shownImpact(view.impact) && <ImpactCard impact={view.impact} />}
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
        <section className="min-w-0 space-y-3" aria-label="Notes">
          <div className="flex flex-wrap items-end gap-x-4 gap-y-2">
            <div className="min-w-0 flex-1">
              <h2 className="text-lg font-semibold">What it has learned</h2>
              <p className="mt-0.5 text-[13px] text-muted-foreground">{active.length ? `${notes(active.length)} in use. Every later run reads them before it starts.` : "No note is in use: the next run starts with nothing learned."}</p>
            </div>
            {!readOnly && !adding && <Button size="sm" onClick={() => setAdding(true)}><Plus aria-hidden /> Add a note</Button>}
          </div>
          {!on && <Off server={server} />}
          {adding && <NoteEditor key="new" title="New note" v2={v2} agentId={agent.agent_id} taken={all.map((x) => x.file)} onDone={(saved) => { setAdding(false); if (saved) read(); }} />}
          <ul className="space-y-3">
            {active.map((x) => (
              <li key={x.file}>
                <NoteCard note={x} v2={v2} agentId={agent.agent_id} readOnly={readOnly} focused={focus.includes(x.file)} from={from.get(x.file)} runs={byRun} usedIn={usedIn.get(x.file)} onChanged={read} />
              </li>
            ))}
          </ul>
          {later.error && <p className="border p-3 text-[13px] text-destructive-text" role="alert">More notes could not be read: {later.error}</p>}
          {later.cursor && <div className="flex justify-center"><Button size="sm" onClick={more}>Load more notes</Button></div>}
          {earlier.length > 0 && <Earlier notes={earlier} all={all} from={from} focus={focus} />}
        </section>
        <aside className="min-w-0 space-y-6" aria-label="About learning">
          <Panel title="Learning">{switchRow(false)}</Panel>
          <NotKept runs={runs} />
          <NextRun index={view.index} />
        </aside>
      </div>
    </div>
  );
}

/** A titled box at the side: the caps header bar the console's sections have. */
function Panel({ title, note, children, label }: { title: string; note?: ReactNode; children: ReactNode; label?: string }) {
  return (
    <section className="border" aria-label={label ?? title}>
      <div className="flex items-center gap-3 border-b px-4 py-2.5">
        <h3 className="caps text-[11px] font-semibold">{title}</h3>
        {note && <span className="ml-auto font-mono text-[11px] text-muted-foreground">{note}</span>}
      </div>
      {children}
    </section>
  );
}

function Skeleton() {
  return (
    <div className="space-y-3" aria-busy="true" aria-label="Loading what it learned">
      <div className="h-6 w-56 animate-pulse bg-muted" />
      {[0, 1, 2].map((i) => (
        <div key={i} className="space-y-3 border p-5">
          <div className="h-4 w-1/3 animate-pulse bg-muted" />
          <div className="h-3 w-2/3 animate-pulse bg-muted/70" />
          <div className="h-3 w-1/2 animate-pulse bg-muted/70" />
        </div>
      ))}
    </div>
  );
}

/** Before and after the agent first learned: its median run time and cost on each side, and how many runs the after
 *  side counts. Shown only when the server has two runs on each side. */
function ImpactCard({ impact }: { impact: NonNullable<AgentLearning["impact"]> }) {
  const { before: b, after: a } = impact;
  const stats: { label: string; from: string; to: string; delta: number | null }[] = [
    { label: "Run time", from: seconds(b.median_duration_s), to: seconds(a.median_duration_s), delta: change(b.median_duration_s, a.median_duration_s) },
    ...(b.median_cost_usd !== null && a.median_cost_usd !== null ? [{ label: "Cost", from: dollars(b.median_cost_usd), to: dollars(a.median_cost_usd), delta: change(b.median_cost_usd, a.median_cost_usd) }] : []),
  ];
  return (
    <section className="relative overflow-hidden border border-primary/40 bg-gradient-to-br from-primary/[0.07] via-transparent to-transparent" aria-label={impactWords(impact)}>
      <div className="flex flex-wrap items-center gap-x-8 gap-y-4 px-5 py-4">
        <div className="flex items-center gap-2.5">
          <Sparkles className="size-4 text-primary" aria-hidden />
          <span className="caps text-[11px] font-semibold text-primary">Since it learned</span>
        </div>
        <dl className="flex flex-1 flex-wrap gap-x-10 gap-y-3">
          {stats.map((s) => (
            <div key={s.label} className="flex items-baseline gap-3">
              <dt className="caps text-[10px] text-muted-foreground">{s.label}</dt>
              <dd className="flex items-baseline gap-2 font-mono">
                <span className="text-[15px] text-muted-foreground line-through decoration-muted-foreground/40">{s.from}</span>
                <ArrowRight className="size-3.5 self-center text-muted-foreground" aria-hidden />
                <span className="text-[22px] font-semibold leading-none">{s.to}</span>
                {s.delta !== null && s.delta !== 0 && <span className={cn("text-[12px]", s.delta < 0 ? "text-success-text" : "text-warning-text")}>{s.delta > 0 ? "+" : "−"}{Math.abs(s.delta)}%</span>}
              </dd>
            </div>
          ))}
        </dl>
        <span className="font-mono text-[11px] text-muted-foreground" title={`Medians: ${runsWord(b.runs)} before its first note, ${runsWord(a.runs)} that started from its notes. Costs are estimates.`}>on {runsWord(a.runs)}</span>
      </div>
    </section>
  );
}

/** The learning switch on the tab: a new revision with `learning` on or off, made on the agent as the server has it
 *  now, shown as it goes and put back if the save fails. */
function SavedSwitch({ agent, v2, onAgent, server, disabled, quiet }: { agent: Agent; v2: Client; onAgent?: (a: Agent) => void; server?: "on" | "off" | null; disabled?: boolean; quiet?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [shown, setShown] = useState<boolean | null>(null);
  const flip = async (next: boolean) => {
    setBusy(true); setProblem(null); setShown(next);
    try {
      const { agent: now, etag } = await v2.getAgent(agent.agent_id);
      const body = editBody(now, { learning: next }, next ? "Learning on" : "Learning off");
      if (body.unchanged) onAgent?.(now);
      else { const { unchanged: _u, ...send } = body; onAgent?.((await v2.updateDefinition(agent.agent_id, send, etag)).agent); }
    } catch (e) { setProblem(`Not changed: ${problemOf(e)}`); }
    setShown(null); setBusy(false);
  };
  return (
    <LearningSwitch id={`learns-${agent.agent_id}`} className="px-4 py-4" quiet={quiet} checked={shown ?? agent.definition.learning === true} onChange={(v) => void flip(v)}
      busy={busy} disabled={disabled} server={server} noWrite={!(agent.definition.tools ?? []).includes("write")} problem={problem} />
  );
}

function Off({ server }: { server?: "on" | "off" | null }) {
  return (
    <p className="flex items-start gap-2 border border-warning/40 bg-warning/5 px-4 py-3 text-[13px]" role="status">
      <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning-text" aria-hidden />
      <span>Learning is off{server === "off" ? " on this server" : ""}, so later runs don't read these notes. They're kept for when it's back on.</span>
    </p>
  );
}

/** No note yet: what learning is, in one sentence, with the switch; or, with learning on, that nothing is learned yet. */
function Empty({ on, lookedBack, switchRow, onAdd }: { on: boolean; lookedBack: number; switchRow: ReactNode; onAdd?: () => void }) {
  return (
    <section className="mx-auto max-w-xl border" aria-label="Learning">
      <div className="flex flex-col items-center px-6 pb-6 pt-10 text-center">
        <span className="flex size-10 items-center justify-center border border-primary/50 bg-primary/10"><Sparkles className="size-5 text-primary" aria-hidden /></span>
        <h2 className="mt-4 text-lg font-semibold">{on ? "Nothing learned yet" : "Let it learn from its runs"}</h2>
        <p className="mt-2 max-w-md text-[14px] text-muted-foreground">
          {on ? "After each run, it looks back and keeps a note when something will help next time. Its notes show here, and every later run reads them first."
            : "With learning on, it keeps short notes on what worked after each run, and every later run reads them before it starts."}
        </p>
        {on && lookedBack > 0 && <p className="mt-3 font-mono text-[12px] text-muted-foreground">{runsWord(lookedBack)} looked back: nothing worth keeping yet.</p>}
      </div>
      <div className="border-t">{switchRow}</div>
      {onAdd && <div className="flex justify-center border-t px-4 py-3"><Button size="sm" variant="ghost" onClick={onAdd}><Plus aria-hidden /> Or write a note yourself</Button></div>}
    </section>
  );
}

type From = { run?: { id: string; at: string; reason: string }; edited?: string } | undefined;

/** One note: its name, type and description, its body, where it came from and how often runs used it; Edit and Retire. */
function NoteCard({ note, v2, agentId, readOnly, focused, from, runs, usedIn, onChanged }: { note: LearningNote; v2: Client; agentId: string; readOnly: boolean; focused: boolean; from: From; runs: Map<string, Run>; usedIn?: number; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [retiring, setRetiring] = useState(false);
  const [flash, setFlash] = useState(focused);
  const [saved, setSaved] = useState<string | null>(null);
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!focused) return;
    setFlash(true);
    ref.current?.scrollIntoView?.({ block: "center", behavior: "smooth" });
    const t = setTimeout(() => setFlash(false), 2600);
    return () => clearTimeout(t);
  }, [focused]);
  useEffect(() => { if (!saved) return; const t = setTimeout(() => setSaved(null), 2400); return () => clearTimeout(t); }, [saved]);
  if (editing) return <NoteEditor title="Edit note" v2={v2} agentId={agentId} file={note.file} onDone={(ok) => { setEditing(false); if (ok) { setSaved("Saved"); onChanged(); } }} />;
  const body = bodyOf(note.text);
  return (
    <article ref={ref} id={`note-${note.file}`} aria-label={note.name} className={cn("border bg-card/40 transition-[border-color,box-shadow] duration-700", flash && "border-primary shadow-[0_0_0_1px_hsl(var(--primary))]")}>
      <header className="flex flex-col gap-x-3 gap-y-1 px-5 pt-4 sm:flex-row sm:items-start">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="min-w-0 break-words text-[15px] font-semibold leading-snug">{note.name}</h3>
            <span title={note.type} className="inline-flex"><Chip>{typeLabel(note.type)}</Chip></span>
            {saved && <span className="caps text-[10px] text-success-text" role="status">{saved}</span>}
          </div>
          <p className="mt-1 text-[13px] text-muted-foreground">{note.description}</p>
        </div>
        {!readOnly && !retiring && (
          <div className="-ml-3 flex shrink-0 items-center gap-1 sm:ml-0">
            <Button size="sm" variant="ghost" onClick={() => setEditing(true)} aria-label={`Edit ${note.name}`}><Pencil aria-hidden /> Edit</Button>
            <Button size="sm" variant="ghost" onClick={() => setRetiring(true)} aria-label={`Retire ${note.name}`}>Retire</Button>
          </div>
        )}
      </header>
      {body.trim() && <Body text={body} />}
      <footer className="flex flex-wrap items-center gap-x-5 gap-y-1.5 border-t px-5 py-2.5 font-mono text-[11px] text-muted-foreground">
        {from?.run ? (
          <span className="flex min-w-0 items-center gap-1.5"><span className="flex shrink-0 items-center gap-1.5 whitespace-nowrap" title={`Kept because: ${from.run.reason}`}><Sparkles className="size-3 shrink-0 text-primary" aria-hidden />Learned in</span>
            <a href={`#/runs/${encodeURIComponent(from.run.id)}`} className="min-w-0 truncate text-foreground/80 underline-offset-2 hover:text-foreground hover:underline" title={runTitle(runs, from.run.id)}>{shortTitle(runTitle(runs, from.run.id))}</a>
            <span className="shrink-0">· {when(from.run.at)}</span>
          </span>
        ) : from?.edited ? <span className="flex items-center gap-1.5"><User className="size-3" aria-hidden />Written by you · {when(from.edited)}</span> : null}
        {from?.run && from.edited && <span className="flex items-center gap-1.5"><User className="size-3" aria-hidden />Edited by you · {when(from.edited)}</span>}
        {usedIn !== undefined && usedIn > 0 && <span className="flex items-center gap-1.5"><BookOpen className="size-3" aria-hidden />Used in {runsWord(usedIn)}</span>}
      </footer>
      {retiring && <RetireConfirm note={note} v2={v2} agentId={agentId} onDone={(ok) => { setRetiring(false); if (ok) onChanged(); }} />}
    </article>
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
      {long && <button type="button" onClick={() => setOpen((o) => !o)} className="caps mt-2 flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"><ChevronDown className={cn("size-3.5 transition-transform", open && "rotate-180")} aria-hidden />{open ? "Show less" : "Show all"}</button>}
    </div>
  );
}

/** Retire, after a confirm: Enter retires, Esc keeps it. Made on the note as it is now (its version read first), so a
 *  change made since is never retired unseen. */
function RetireConfirm({ note, v2, agentId, onDone }: { note: LearningNote; v2: Client; agentId: string; onDone: (retired: boolean) => void }) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const yes = useRef<HTMLButtonElement>(null);
  useEffect(() => { yes.current?.focus(); }, []);
  const go = async () => {
    setBusy(true); setProblem(null);
    try {
      const { etag } = await v2.readNote(agentId, note.file);
      await v2.retireNote(agentId, note.file, etag ?? "");
      onDone(true);
    } catch (e) {
      setBusy(false);
      setProblem(e instanceof ClientError && e.status === 412 ? "It changed since you opened it. Reload the tab to see the newest version." : `Not retired: ${problemOf(e)}`);
    }
  };
  return (
    <div role="alertdialog" aria-label={`Retire ${note.name}?`} onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); onDone(false); } }}
      className="flex flex-wrap items-center gap-3 border-t border-destructive/40 bg-destructive/5 px-5 py-3">
      <p className="min-w-0 flex-1 text-[13px]"><span className="font-semibold">Retire it?</span> It leaves every later run's instructions; the record stays.</p>
      {problem && <p className="w-full text-[12px] text-destructive-text" role="alert">{problem}</p>}
      <Button ref={yes} size="sm" variant="destructive" onClick={() => void go()} disabled={busy}>{busy ? "Retiring" : "Retire"}</Button>
      <Button size="sm" variant="ghost" onClick={() => onDone(false)} disabled={busy}>Keep</Button>
    </div>
  );
}

/** A note to edit (`file`: read first, with its version) or a new one: name, description and type as fields, the body as
 *  markdown. ⌘/Ctrl+Enter saves anywhere in it and Enter saves in a one-line field; Esc cancels. A note that changed
 *  since it was opened is not written over: the newest version loads, and the edit stays below to copy. */
function NoteEditor({ title, v2, agentId, file, taken = [], onDone }: { title: string; v2: Client; agentId: string; file?: string; taken?: string[]; onDone: (saved: boolean) => void }) {
  const [parts, setParts] = useState<NoteParts | null>(file ? null : { name: "", description: "", type: "feedback", body: "\n", rest: [] });
  const [etag, setEtag] = useState<string | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<NoteProblem[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [stale, setStale] = useState<string | null>(null);
  const first = useRef<HTMLInputElement>(null);
  const load = async () => {
    if (!file) return;
    try { const n = await v2.readNote(agentId, file); setParts(noteParts(n.text)); setEtag(n.etag); setReadError(null); } catch (e) { setReadError(problemOf(e)); }
  };
  useEffect(() => { void load(); }, [file]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (parts) first.current?.focus(); }, [parts === null]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (p: Partial<NoteParts>) => setParts((x) => (x ? { ...x, ...p } : x));
  const ready = !!parts && parts.name.trim() !== "" && parts.description.trim() !== "" && !busy;
  const save = async () => {
    if (!parts || !ready) return;
    setBusy(true); setProblem(null); setProblems([]);
    const text = noteText(parts);
    try {
      await v2.writeNote(agentId, file ?? fileFor(parts.name, taken), text, file ? { etag: etag ?? "" } : { create: true });
      onDone(true);
    } catch (e) {
      setBusy(false);
      if (e instanceof ClientError && e.status === 412 && file) {
        // Someone, or a run, changed it since it was opened: show the newest, keep this edit to copy.
        setStale(text);
        await load();
      } else if (e instanceof ClientError && e.problems?.length) setProblems(e.problems);
      else setProblem(e instanceof ClientError && e.status === 412 ? "A note by this name exists already: change its name." : problemOf(e));
    }
  };
  const keys = (e: KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onDone(false); }
    else if (e.key === "Enter" && (e.metaKey || e.ctrlKey || (e.target as HTMLElement).tagName === "INPUT")) { e.preventDefault(); void save(); }
  };
  return (
    <section className="border border-border-strong bg-card" aria-label={title} onKeyDown={keys}>
      <div className="flex items-center gap-3 border-b px-5 py-2.5">
        <h3 className="caps text-[11px] font-semibold">{title}</h3>
        <span className="ml-auto hidden font-mono text-[11px] text-muted-foreground sm:inline"><kbd>{MAC ? "⌘" : "Ctrl"}+Enter</kbd> save · <kbd>Esc</kbd> cancel</span>
      </div>
      {readError && <p className="px-5 py-4 text-[13px] text-destructive-text" role="alert">The note could not be read: {readError}</p>}
      {!parts && !readError && <div className="space-y-3 p-5"><div className="h-9 animate-pulse bg-muted" /><div className="h-24 animate-pulse bg-muted/70" /></div>}
      {parts && (
        <div className="space-y-4 px-5 py-4">
          {stale && (
            <div className="border border-warning/50 bg-warning/10 px-4 py-3 text-[13px]" role="alert">
              <p className="flex items-center gap-2 font-semibold"><TriangleAlert className="size-4 text-warning-text" aria-hidden />Changed since you opened it</p>
              <p className="mt-1 text-muted-foreground">This is the newest version. Your edit wasn't saved; it's below to copy.</p>
              <details className="mt-2"><summary className="caps cursor-pointer text-[11px] text-muted-foreground hover:text-foreground">Your edit</summary><pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words border bg-background p-3 font-mono text-[12px]">{stale}</pre></details>
            </div>
          )}
          <label className="block"><span className="caps mb-1.5 block text-[11px] font-semibold">Name</span>
            <input ref={first} value={parts.name} onChange={(e) => set({ name: e.target.value })} placeholder="e.g., Try /policies/refund-policy first" className={field} /></label>
          <label className="block"><span className="caps mb-1.5 block text-[11px] font-semibold">Description</span>
            <span className="-mt-0.5 mb-1.5 block text-[12px] text-muted-foreground">One line: what the next run sees before it opens the note.</span>
            <input value={parts.description} onChange={(e) => set({ description: e.target.value })} placeholder="When it applies, and what to do" className={field} /></label>
          <fieldset>
            <legend className="caps mb-1.5 text-[11px] font-semibold">Type</legend>
            <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Type">
              {NOTE_TYPES.map((t) => (
                <label key={t} className={cn("caps cursor-pointer border px-3 py-1.5 text-[11px]", parts.type === t ? "border-foreground" : "text-muted-foreground hover:text-foreground")} title={t}>
                  <input type="radio" name={`type-${file ?? "new"}`} className="sr-only" checked={parts.type === t} onChange={() => set({ type: t })} />{typeLabel(t)}
                </label>
              ))}
            </div>
            <p className="mt-1.5 text-[12px] text-muted-foreground">{TYPE_HINT[parts.type]}</p>
          </fieldset>
          <label className="block"><span className="caps mb-1.5 block text-[11px] font-semibold">Note</span>
            <textarea value={parts.body.replace(/^\n/, "")} onChange={(e) => set({ body: `\n${e.target.value}` })} rows={7} placeholder="What to do, and why. Markdown." className={cn(field, "resize-y leading-[1.65]")} /></label>
          {problems.length > 0 && (
            <div className="border border-destructive/50 bg-destructive/5 px-4 py-3 text-[13px]" role="alert">
              <p className="font-semibold text-destructive-text">Not saved: the note doesn't pass the checks.</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-5">{problems.map((p, i) => <li key={i}>{p.detail}</li>)}</ul>
            </div>
          )}
          {problem && <p className="text-[13px] text-destructive-text" role="alert">Not saved: {problem}</p>}
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="solid" onClick={() => void save()} disabled={!ready}>{busy ? "Saving" : file ? "Save" : "Add note"}</Button>
            <Button size="sm" variant="ghost" onClick={() => onDone(false)} disabled={busy}>Cancel</Button>
            {!file && parts.name.trim() && <span className="ml-auto font-mono text-[11px] text-muted-foreground">{fileFor(parts.name, taken)}</span>}
          </div>
        </div>
      )}
    </section>
  );
}

/** The notes no longer in use: replaced by a newer one, or retired. Closed until asked; one a link points at opens it. */
function Earlier({ notes: list, all, from, focus }: { notes: LearningNote[]; all: LearningNote[]; from: ReturnType<typeof provenance>; focus: string[] }) {
  const [open, setOpen] = useState(list.some((x) => focus.includes(x.file)));
  const nameOf = (file: string | null) => all.find((x) => x.file === file)?.name ?? file;
  return (
    <section className="border" aria-label="Earlier notes">
      <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-2 px-4 py-2.5 text-left hover:bg-accent">
        <ChevronDown className={cn("size-3.5 text-muted-foreground transition-transform", !open && "-rotate-90")} aria-hidden />
        <span className="caps text-[11px] font-semibold">Earlier notes</span>
        <span className="font-mono text-[11px] text-muted-foreground">{list.length} no longer read</span>
      </button>
      {open && (
        <ul className="border-t">
          {list.map((x) => (
            <li key={x.file} id={`note-${x.file}`} className={cn("border-b px-4 py-3 last:border-b-0", focus.includes(x.file) && "bg-primary/5")}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[14px] text-muted-foreground line-through decoration-muted-foreground/40">{x.name}</span>
                <Chip tone="muted">{x.status === "retired" ? "Retired" : "Replaced"}</Chip>
              </div>
              <p className="mt-1 font-mono text-[11px] text-muted-foreground">
                {x.status === "superseded" && x.superseded_by ? <>Replaced by <a href={`#note-${x.superseded_by}`} onClick={(e) => { e.preventDefault(); document.getElementById(`note-${x.superseded_by}`)?.scrollIntoView?.({ block: "center", behavior: "smooth" }); }} className="text-foreground/80 hover:underline">{nameOf(x.superseded_by)}</a></> : x.status === "retired" ? `Retired${from.get(x.file)?.edited ? ` by you · ${when(from.get(x.file)!.edited!)}` : ""}` : null}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** A reason under the panel's own title says it once: "Not kept: too specific" reads "Too specific". */
const untitled = (words: string) => words.replace(/^Not kept:\s*(.)/, (_, c: string) => c.toUpperCase());

/** The latest runs that kept nothing, and why, in plain words: notes turned away, skips and stops, newest first. Runs
 *  with nothing new to remember are counted, not listed. */
function NotKept({ runs }: { runs: Run[] }) {
  const dropped = runs.filter((r) => r.learning?.state === "dropped");
  const listed = dropped.filter((r) => dropKind(r.learning!.reason) !== "nothing").slice(0, 6);
  const nothing = dropped.length - dropped.filter((r) => dropKind(r.learning!.reason) !== "nothing").length;
  if (!dropped.length) return null;
  return (
    <Panel title="Not kept">
      {listed.length > 0 && (
        <ul>
          {listed.map((r) => (
            <li key={r.run_id} className="border-b last:border-b-0">
              <a href={`#/runs/${encodeURIComponent(r.run_id)}`} className="block px-4 py-3 hover:bg-accent">
                <span className="block text-[13px]">{untitled(dropWords(r.learning!))}</span>
                <span className="mt-1 flex items-center gap-2 font-mono text-[11px] text-muted-foreground"><span className="min-w-0 truncate" title={r.title}>{r.title}</span><span className="shrink-0">· {when(r.created_at)}</span></span>
              </a>
            </li>
          ))}
        </ul>
      )}
      {nothing > 0 && <p className={cn("px-4 py-3 font-mono text-[11px] text-muted-foreground", listed.length > 0 && "border-t")}>{listed.length ? `${nothing} more ${nothing === 1 ? "run" : "runs"} had` : `${runsWord(nothing)} had`} nothing new to remember.</p>}
    </Panel>
  );
}

/** The index the next run reads first, one line a note in use: built by the server from the notes, so read-only. */
function NextRun({ index }: { index: string }) {
  const [open, setOpen] = useState(false);
  const lines = index.split("\n").filter((l) => l.trim()).length;
  return (
    <section className="border" aria-label="What the next run reads">
      <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-2 px-4 py-2.5 text-left hover:bg-accent">
        <ChevronDown className={cn("size-3.5 text-muted-foreground transition-transform", !open && "-rotate-90")} aria-hidden />
        <span className="caps text-[11px] font-semibold">What the next run reads</span>
        <span className="ml-auto font-mono text-[11px] text-muted-foreground">{lines ? `${lines} ${lines === 1 ? "line" : "lines"}` : "nothing"}</span>
      </button>
      {open && (
        <div className="border-t">
          {lines ? <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words px-4 py-3 font-mono text-[11.5px] leading-[1.7]">{index.trim()}</pre>
            : <p className="px-4 py-3 text-[13px] text-muted-foreground">Nothing yet: no note is in use.</p>}
          <p className="border-t px-4 py-2 text-[11px] text-muted-foreground">Read-only: it's made from the notes in use, one line each.</p>
        </div>
      )}
    </section>
  );
}

