import type { Run } from "@/lib/v2";

/** A run's kind as the runs list and the run page say it. A run a learned workflow answered alone (the server's `path`
 *  `workflow`, the path GET .../learning/cost places it on) reads "Learned workflow", with the Learning tab's workflow
 *  series mark beside the words (the series token is a mark's colour, never text ink: it is under AA on the light card),
 *  and its workflow's name where the page has room (`named`). A run it handed back (`path` `handed_back`) reads
 *  "agentic · handed back by <name>" where it is named. Where it is named, a run whose answer re-picked after a quote miss
 *  (the server's `workflow.repick`) says so: "· re-picked" when the re-pick answered, and on a hand-back whether the
 *  re-pick missed before it. Any other run reads its kind. */
export function RunKind({ run, named = false }: { run: Pick<Run, "kind" | "path" | "workflow">; named?: boolean }) {
  const name = run.workflow?.name;
  const repick = named ? run.workflow?.repick ?? null : null;
  if (run.path === "workflow") {
    return (
      <span data-run-kind="learned" className="inline-flex items-center gap-1.5" title={name ? `Answered by the learned workflow ${name}${repick ? " on its re-pick" : ""}` : "Answered by a learned workflow"}>
        {/* The Learning tab's legend mark for the series (CostPerRun.tsx). */}
        <svg width="10" height="10" aria-hidden className="shrink-0"><circle cx="5" cy="5" r="4" className="fill-chart-workflow" /></svg>
        <span className="text-foreground">Learned workflow{named && name ? ` ${name}` : ""}{repick && <span data-run-repick={repick} className="text-muted-foreground"> · re-picked</span>}</span>
      </span>
    );
  }
  const back = named && run.path === "handed_back" ? name : undefined;
  const after = back && repick ? (repick === "missed" ? " after its re-pick missed" : " after a re-pick") : "";
  return <span data-run-kind={run.kind}>{run.kind}{back && ` · handed back by ${back}${after}`}</span>;
}
