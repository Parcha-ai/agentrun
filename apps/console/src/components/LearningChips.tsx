import { CircleSlash, Hourglass, Workflow } from "lucide-react";
import { Chip } from "@/components/ui/chip";
import { counted, dropKind, dropWords, goingWords, type LearnedFileRef, learningHash, underWay, waitingWords, workflowsBy } from "@/lib/learning";
import { cn } from "@/lib/utils";
import type { Run } from "@/lib/v2";

/** A run's learning at a glance: "Learned 1 workflow" for the workflow draft it kept (one that waits for the owner's OK
 *  says so instead), "Kept nothing" with why when its learning was refused, skipped or stopped, and "Looking back" while
 *  it decides what to keep. Nothing for a run that does not learn and kept nothing. `link` (the run's own page): each chip
 *  opens the agent's Learning tab. A chip inside a row that is itself a link stays text and names them in its title. */
export function LearningChips({ run, link = false, className }: { run: Pick<Run, "agent_id" | "learning">; link?: boolean; className?: string }) {
  const going = underWay(run.learning) && run.learning!.state !== "seeded";
  const kept = workflowsBy(run.learning);
  // Kept nothing for a reason (refused, skipped, stopped): said, with the server's sentence. A run with nothing new to
  // keep says nothing.
  const lost = run.learning?.state === "dropped" && dropKind(run.learning.reason) !== "nothing" ? dropWords(run.learning) : null;
  if (!going && !kept.length && !lost) return null;
  return (
    <span className={cn("inline-flex flex-wrap items-center gap-2", className)} aria-label="Learning">
      {lost && <KeptNothing agentId={run.agent_id} said={lost} link={link} />}
      {[false, true].map((pending) => {
        const these = kept.filter((x) => (x.pending === true) === pending);
        return these.length ? <WorkflowsChip key={String(pending)} agentId={run.agent_id} refs={these} link={link} pending={pending} /> : null;
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

/** One chip for the workflow drafts a run kept, or kept to wait for the owner's OK: "Learned 1 workflow", "1 workflow
 *  waits for your OK". `link`: it opens the agent's Learning tab, where they are listed. */
function WorkflowsChip({ agentId, refs, link, pending }: { agentId: string; refs: LearnedFileRef[]; link: boolean; pending: boolean }) {
  const label = pending ? `${counted(refs.length, "workflow")} ${refs.length === 1 ? "waits" : "wait"} for your OK` : `Learned ${counted(refs.length, "workflow")}`;
  const said = `${label}: ${refs.map((r) => r.name).join(", ")}`;
  const Icon = pending ? Hourglass : Workflow;
  const chip = (
    <Chip tone={pending ? "warning" : undefined} className={cn(!pending && "border-primary/50 bg-primary/10 text-primary-text", link && "cursor-pointer")}>
      <Icon className="size-3" aria-hidden />{label}
    </Chip>
  );
  if (!link) return <span title={said} aria-label={said} className="inline-flex">{chip}</span>;
  return <a href={learningHash(agentId)} title={said} aria-label={said} className="inline-flex">{chip}</a>;
}

/** How many of an agent's learned workflows wait for its owner's OK, in the warning tone, its label in words ("2 learned
 *  workflows wait for your OK"): on its page's Learning tab. Nothing at 0. */
export function WaitingCount({ n, className }: { n: number; className?: string }) {
  if (n <= 0) return null;
  return <span aria-label={waitingWords(n)} className={cn("inline-flex min-w-[18px] items-center justify-center border border-warning/50 bg-warning/10 px-1 font-mono text-micro text-warning-text", className)}>{n}</span>;
}
