import { BookOpen, CircleSlash, Hourglass, Sparkles, Workflow, Wrench } from "lucide-react";
import { Chip } from "@/components/ui/chip";
import { Tip } from "@/components/ui/tip";
import { counted, dropKind, dropWords, givenBy, goingWords, learnedBy, type LearnedFileRef, learningHash, type NoteRef, notes, pendingBy, readBy, REDACTED, skillsBy, underWay, waitingWords, waitsForOk, waitWords, workflowsBy } from "@/lib/learning";
import { cn } from "@/lib/utils";
import type { RunSummary } from "@/lib/v2";

/** A run's learning at a glance: "Started with: 2 notes" for the notes it was given, "Read: 1 note" for the note files it
 *  opened, "Learned 1 note" for the notes it
 *  kept, "Learned 1 skill" and "Learned 1 workflow" for the skill and the workflow it kept (one that waits for the
 *  owner's OK says so instead), "Kept nothing" with why when its learning was turned away, refused, skipped or stopped, and
 *  "Looking back" while it decides what to keep. Nothing for a run that does not learn, read nothing and kept
 *  nothing. `link` (the run's own page): each chip opens its notes in the agent's Learning tab, and names them in a
 *  tooltip on hover and on focus. A chip inside a row that is itself a link stays text and names them in its title. The
 *  names are never only in a tooltip: the chip's label says them, and the link opens them. A name the server cut of a
 *  secret is never linked. */
export function LearningChips({ run, link = false, className }: { run: Pick<RunSummary, "agent_id" | "learning">; link?: boolean; className?: string }) {
  const given = givenBy(run.learning);
  const read = readBy(run.learning);
  const learned = learnedBy(run.learning);
  const going = underWay(run.learning) && run.learning!.state !== "seeded";
  const waiting = pendingBy(run.learning);
  const waits = waitsForOk(run.learning);
  const kept = [...skillsBy(run.learning), ...workflowsBy(run.learning)];
  // Kept nothing for a reason (turned away, refused, skipped, stopped): said, with the server's sentence. A run with
  // nothing new to remember says nothing.
  const lost = run.learning?.state === "dropped" && dropKind(run.learning.reason) !== "nothing" ? dropWords(run.learning) : null;
  if (!given.length && !read.length && !learned.length && !going && !waits && !kept.length && !lost) return null;
  return (
    <span className={cn("inline-flex flex-wrap items-center gap-2", className)} aria-label="Learning">
      {given.length > 0 && <NotesChip agentId={run.agent_id} refs={given} link={link} kind="given" />}
      {read.length > 0 && <NotesChip agentId={run.agent_id} refs={read} link={link} kind="read" />}
      {learned.length > 0 && <NotesChip agentId={run.agent_id} refs={learned} link={link} kind="learned" replaces={learned.reduce((n, l) => n + (l.supersedes?.length ?? 0), 0)} />}
      {waits && <NotesChip agentId={run.agent_id} refs={waiting} link={link} kind="pending" />}
      {lost && <KeptNothing agentId={run.agent_id} said={lost} link={link} />}
      {(["skill", "workflow"] as const).flatMap((kind) => {
        const mine = (kind === "skill" ? skillsBy : workflowsBy)(run.learning);
        return [false, true].map((pending) => {
          const these = mine.filter((x) => (x.pending === true) === pending);
          return these.length ? <SkillsChip key={`${kind}-${pending}`} agentId={run.agent_id} refs={these} link={link} kind={kind} pending={pending} /> : null;
        });
      })}
      {going && (
        <Chip tone="active">
          <span className="relative flex size-1.5" aria-hidden><span className="absolute inline-flex size-full animate-ping bg-run-active opacity-75" /><span className="relative inline-flex size-1.5 bg-run-active" /></span>
          {goingWords(run.learning!.state)}
        </Chip>
      )}
    </span>
  );
}

/** "Kept nothing", and why in the server's own sentence (dropWords: its `detail`). `link` (the run's page): the chip opens
 *  the agent's Learning tab, and the sentence shows beside it; in a row, which is itself a link, it is the chip's title. */
function KeptNothing({ agentId, said, link }: { agentId: string; said: string; link: boolean }) {
  const chip = <Chip tone="muted" className={cn(link && "cursor-pointer")}><CircleSlash className="size-3" aria-hidden />Kept nothing</Chip>;
  if (!link) return <span title={`Kept nothing: ${said}`} aria-label={`Kept nothing: ${said}`} className="inline-flex">{chip}</span>;
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <a href={learningHash(agentId)} aria-label={`Kept nothing: ${said}`} className="inline-flex">{chip}</a>
      <span className="text-small text-muted-foreground">{said}</span>
    </span>
  );
}

/** One chip for the skills or the workflows a run kept, or kept to wait for the owner's OK: "Learned 1 skill", "1 skill
 *  waits for your OK". `link`: it opens the agent's Learning tab, where they are listed. */
function SkillsChip({ agentId, refs, link, kind, pending }: { agentId: string; refs: LearnedFileRef[]; link: boolean; kind: "skill" | "workflow"; pending: boolean }) {
  const label = pending ? `${counted(refs.length, kind)} ${refs.length === 1 ? "waits" : "wait"} for your OK` : `Learned ${counted(refs.length, kind)}`;
  const said = `${label}: ${refs.map((r) => r.name).join(", ")}`;
  const Icon = pending ? Hourglass : kind === "skill" ? Wrench : Workflow;
  const chip = (
    <Chip tone={pending ? "warning" : undefined} className={cn(!pending && "border-primary/50 bg-primary/10 text-primary-text", link && "cursor-pointer")}>
      <Icon className="size-3" aria-hidden />{label}
    </Chip>
  );
  if (!link) return <span title={said} aria-label={said} className="inline-flex">{chip}</span>;
  return <a href={learningHash(agentId)} title={said} aria-label={said} className="inline-flex">{chip}</a>;
}

/** One chip: the notes a run started with (`given`), opened (`read`), kept (`learned`), or kept for the owner's OK
 *  (`pending`, which links to the
 *  tab even when the run names none, so the waiting notes are one click away). */
function NotesChip({ agentId, refs, link, kind, replaces = 0 }: { agentId: string; refs: NoteRef[]; link: boolean; kind: "given" | "read" | "learned" | "pending"; replaces?: number }) {
  const label = kind === "pending" ? waitWords(refs.length) : kind === "given" ? `Started with: ${notes(refs.length)}` : kind === "read" ? `Read: ${notes(refs.length)}` : `Learned ${notes(refs.length)}`;
  const names = refs.map((r) => r.name).join(", ");
  const quiet = kind === "given" || kind === "read";
  const Icon = quiet ? BookOpen : kind === "pending" ? Hourglass : Sparkles;
  const chip = (
    <Chip tone={kind === "pending" ? "warning" : undefined} className={cn(kind === "learned" ? "border-primary/50 bg-primary/10 text-primary-text" : quiet ? "border-border-strong/70 text-foreground/80" : "", link && "cursor-pointer transition-colors group-hover/tip:border-foreground/70")}>
      <Icon className="size-3" aria-hidden />{label}
    </Chip>
  );
  const linked = refs.filter((r) => r.file !== REDACTED);
  const said = `${label}${names ? `: ${names}` : ""}${replaces ? ` (replaces ${replaces === 1 ? "1 older note" : `${replaces} older notes`})` : ""}`;
  if (!link || (!linked.length && kind !== "pending")) return <span title={said} aria-label={said} className="inline-flex">{chip}</span>;
  const tip = (
    <>
      <span className="caps block text-micro text-muted-foreground">{kind === "given" ? "This run started with" : kind === "read" ? "This run read" : kind === "learned" ? "This run kept" : "Waits for your OK before any run reads it"}</span>
      {refs.length > 0 && <ul className="mt-1 space-y-0.5">{refs.map((r) => <li key={r.file} className="font-semibold">{r.name}</li>)}</ul>}
      {replaces > 0 && <span className="mt-1 block text-muted-foreground">Replaces {replaces === 1 ? "1 older note" : `${replaces} older notes`}.</span>}
      <span className="mt-1.5 block text-label text-muted-foreground">Open in Learning</span>
    </>
  );
  return (
    <Tip tip={tip}>
      <a href={learningHash(agentId, linked.map((r) => r.file))} aria-label={said} className="inline-flex">{chip}</a>
    </Tip>
  );
}

/** How many of an agent's learned items wait for its owner's OK, in the warning tone, its label in words ("2 learned items
 *  wait for your OK"): on its page's Learning tab. Nothing at 0. */
export function WaitingCount({ n, className }: { n: number; className?: string }) {
  if (n <= 0) return null;
  return <span aria-label={waitingWords(n)} className={cn("inline-flex min-w-[18px] items-center justify-center border border-warning/50 bg-warning/10 px-1 font-mono text-micro text-warning-text", className)}>{n}</span>;
}
