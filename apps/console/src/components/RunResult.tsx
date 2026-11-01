import { markdown } from "@/lib/format";
import type { Run, TimelineRow } from "@/lib/v2";

/** The run's answer, as a report: an agentic run's final answer as Markdown, a workflow run's typed output as
 *  JSON (with its written reports as Markdown). Nothing is invented when there is no answer. */
export function RunResult({ run, rows }: { run: Run; rows: TimelineRow[] }) {
  const answer = run.result?.final_answer ?? rows.findLast((r) => r.kind === "final_answer")?.text ?? null;
  if (answer) return <article className="report max-w-none" dangerouslySetInnerHTML={{ __html: markdown(answer) }} />;
  if (run.result?.output !== undefined && run.result.output !== null) {
    // A workflow's output can carry written reports (a text field of several lines): each reads as Markdown under its
    // field's name, and the rest of the output stays JSON.
    const out = run.result.output;
    const written = out && typeof out === "object" && !Array.isArray(out)
      ? Object.entries(out as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === "string" && e[1].includes("\n") && e[1].length > 80) : [];
    const rest = written.length ? Object.fromEntries(Object.entries(out as Record<string, unknown>).filter(([k]) => !written.some(([w]) => w === k))) : out;
    return (
      <div className="space-y-8">
        {written.map(([k, text]) => (
          <section key={k}>
            <p className="caps mb-2 text-[11px] text-muted-foreground">{k.replace(/_/g, " ")}</p>
            <article className="report max-w-none border bg-card p-5" dangerouslySetInnerHTML={{ __html: markdown(text) }} />
          </section>
        ))}
        {(!written.length || Object.keys(rest as object).length > 0) && (
          <section>
            <p className="caps mb-2 text-[11px] text-muted-foreground">{written.length ? "The rest of the output" : "Output"}</p>
            <pre className="overflow-auto border bg-card p-4 font-mono text-[12px] leading-[1.8]">{JSON.stringify(rest, null, 2)}</pre>
          </section>
        )}
      </div>
    );
  }
  return null;
}
