import { markdown } from "@/lib/format";
import type { Run, TimelineRow } from "@/lib/v2";

/** The run's answer, as a report: an agentic run's final answer as Markdown, a workflow run's typed output as
 *  JSON. Nothing is invented when there is no answer. */
export function RunResult({ run, rows }: { run: Run; rows: TimelineRow[] }) {
  const answer = run.result?.final_answer ?? rows.findLast((r) => r.kind === "final_answer")?.text ?? null;
  if (answer) return <article className="report max-w-none" dangerouslySetInnerHTML={{ __html: markdown(answer) }} />;
  if (run.result?.output !== undefined && run.result.output !== null) {
    return (
      <section>
        <p className="caps mb-2 text-[11px] text-muted-foreground">Output</p>
        <pre className="overflow-auto border bg-card p-4 font-mono text-[12px] leading-[1.8]">{JSON.stringify(run.result.output, null, 2)}</pre>
      </section>
    );
  }
  return null;
}
