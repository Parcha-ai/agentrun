import { BookOpen, Hourglass, Sparkles } from "lucide-react";
import { Chip } from "@/components/ui/chip";
import { Tip } from "@/components/ui/tip";
import { goingWords, learnedBy, learningHash, type NoteRef, notes, pendingBy, REDACTED, underWay, usedBy, waitsForOk, waitWords } from "@/lib/learning";
import { cn } from "@/lib/utils";
import type { Run } from "@/lib/v2";

/** A run's learning at a glance: "Used 1 note" for the notes it read before it worked, "Learned 1 note" for the notes it
 *  kept, and "Looking back" while it decides what to keep. Nothing for a run that does not learn, read nothing and kept
 *  nothing. `link` (the run's own page): each chip opens its notes in the agent's Learning tab, and names them in a
 *  tooltip on hover and on focus. A chip inside a row that is itself a link stays text and names them in its title. The
 *  names are never only in a tooltip: the chip's label says them, and the link opens them. A name the server cut of a
 *  secret is never linked. */
export function LearningChips({ run, link = false, className }: { run: Pick<Run, "agent_id" | "learning">; link?: boolean; className?: string }) {
  const used = usedBy(run.learning);
  const learned = learnedBy(run.learning);
  const going = underWay(run.learning) && run.learning!.state !== "seeded";
  const waiting = pendingBy(run.learning);
  const waits = waitsForOk(run.learning);
  if (!used.length && !learned.length && !going && !waits) return null;
  return (
    <span className={cn("inline-flex flex-wrap items-center gap-2", className)} aria-label="Learning">
      {used.length > 0 && <NotesChip agentId={run.agent_id} refs={used} link={link} kind="used" />}
      {learned.length > 0 && <NotesChip agentId={run.agent_id} refs={learned} link={link} kind="learned" replaces={learned.reduce((n, l) => n + (l.supersedes?.length ?? 0), 0)} />}
      {waits && <NotesChip agentId={run.agent_id} refs={waiting} link={link} kind="pending" />}
      {going && (
        <Chip tone="active">
          <span className="relative flex size-1.5" aria-hidden><span className="absolute inline-flex size-full animate-ping bg-run-active opacity-75" /><span className="relative inline-flex size-1.5 bg-run-active" /></span>
          {goingWords(run.learning!.state)}
        </Chip>
      )}
    </span>
  );
}

/** One chip: the notes a run read (`used`), kept (`learned`), or kept for the owner's OK (`pending`, which links to the
 *  tab even when the run names none, so the waiting notes are one click away). */
function NotesChip({ agentId, refs, link, kind, replaces = 0 }: { agentId: string; refs: NoteRef[]; link: boolean; kind: "used" | "learned" | "pending"; replaces?: number }) {
  const label = kind === "pending" ? waitWords(refs.length) : `${kind === "used" ? "Used" : "Learned"} ${notes(refs.length)}`;
  const names = refs.map((r) => r.name).join(", ");
  const Icon = kind === "used" ? BookOpen : kind === "pending" ? Hourglass : Sparkles;
  const chip = (
    <Chip tone={kind === "pending" ? "warning" : undefined} className={cn(kind === "learned" ? "border-primary/50 bg-primary/10 text-primary" : kind === "used" ? "border-border-strong/70 text-foreground/80" : "", link && "cursor-pointer transition-colors group-hover/tip:border-foreground/70")}>
      <Icon className="size-3" aria-hidden />{label}
    </Chip>
  );
  const linked = refs.filter((r) => r.file !== REDACTED);
  const said = `${label}${names ? `: ${names}` : ""}${replaces ? ` (replaces ${replaces === 1 ? "1 older note" : `${replaces} older notes`})` : ""}`;
  if (!link || (!linked.length && kind !== "pending")) return <span title={said} aria-label={said} className="inline-flex">{chip}</span>;
  const tip = (
    <>
      <span className="caps block text-[10px] text-muted-foreground">{kind === "used" ? "This run read" : kind === "learned" ? "This run kept" : "Waits for your OK before any run reads it"}</span>
      {refs.length > 0 && <ul className="mt-1 space-y-0.5">{refs.map((r) => <li key={r.file} className="font-medium">{r.name}</li>)}</ul>}
      {replaces > 0 && <span className="mt-1 block text-muted-foreground">Replaces {replaces === 1 ? "1 older note" : `${replaces} older notes`}.</span>}
      <span className="mt-1.5 block text-[11px] text-muted-foreground">Open in Learning</span>
    </>
  );
  return (
    <Tip tip={tip}>
      <a href={learningHash(agentId, linked.map((r) => r.file))} aria-label={said} className="inline-flex">{chip}</a>
    </Tip>
  );
}
