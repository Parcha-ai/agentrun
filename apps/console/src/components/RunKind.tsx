import type { Run } from "@/lib/v2";

/** A run's kind as the runs list and the run page say it. A run a learned workflow answered alone (the server's `served`,
 *  the run's path as GET .../learning/cost places it) reads "Learned workflow", with the Learning tab's workflow series
 *  mark beside the words (the series token is a mark's colour, never text ink: it is under AA on the light card), and its
 *  workflow's name where the page has room (`named`). A run it handed back reads "agentic · handed back by <name>" where
 *  it is named. Any other run reads its kind. */
export function RunKind({ run, named = false }: { run: Pick<Run, "kind" | "served" | "handed_back">; named?: boolean }) {
  const served = run.served;
  if (served) {
    const name = named && served.workflow ? ` ${served.workflow}` : "";
    return (
      <span data-run-kind="learned" className="inline-flex items-center gap-1.5" title={served.workflow ? `Answered by the learned workflow ${served.workflow}` : "Answered by a learned workflow"}>
        <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-chart-workflow" />
        <span className="text-foreground">Learned workflow{name}</span>
      </span>
    );
  }
  const back = named ? run.handed_back?.workflow : undefined;
  return <>{run.kind}{back && ` · handed back by ${back}`}</>;
}
