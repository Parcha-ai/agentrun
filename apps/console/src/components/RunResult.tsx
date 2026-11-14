import { AnswerFields } from "@/components/AnswerFields";
import { Banner } from "@/components/ui/banner";
import { answerRecord } from "@/lib/answerJson";
import { markdown, openLinkedFile } from "@/lib/format";
import type { Run, RunFile, TimelineRow } from "@/lib/v2";

/** The run's answer, as a report. An agentic run whose agent has an output schema: its result.output read with that
 *  schema (`schema`, the agent's definition.output_schema), never the answer's text: each string the schema marks
 *  `contentMediaType: "text/markdown"` a Markdown section, the rest fields; when its answer still missed the schema, why
 *  (result.output_error), then the answer as written. Any other agentic run: its final answer as Markdown (one that ends
 *  in, or is, a JSON object reads that object as fields, AnswerFields). A workflow run: its typed output as JSON (with its
 *  written reports as Markdown). Nothing is invented when there is no answer. A link in it that names one of the run's
 *  `files` opens that file (`onOpen`, the Files tab's viewer); no other relative link leaves the page. */
export function RunResult({ run, rows, files = [], onOpen, schema }: { run: Run; rows: TimelineRow[]; files?: RunFile[]; onOpen?: (file: RunFile) => void; schema?: unknown }) {
  const answer = run.result?.final_answer ?? rows.findLast((r) => r.kind === "final_answer")?.text ?? null;
  const linked = onOpen ? { paths: files.map((f) => f.path) } : undefined;
  const open = openLinkedFile((path) => { const f = files.find((x) => x.path === path); if (f) onOpen?.(f); });
  const output = run.result?.output;
  // An agentic run's output is there only when its agent has an output schema and the answer met it (serve's store-view).
  if (run.kind === "agentic" && output !== undefined && output !== null) {
    return output && typeof output === "object" && !Array.isArray(output)
      ? <div className="min-w-0" onClick={open}><AnswerFields record={output as Record<string, unknown>} schema={schema} linked={linked} /></div>
      : <pre className="whitespace-pre-wrap break-words [overflow-wrap:anywhere] border bg-card p-4 font-mono text-small leading-[1.8]">{JSON.stringify(output, null, 2)}</pre>;
  }
  const missed = run.kind === "agentic" ? run.result?.output_error : undefined;
  const missedNote = missed ? <Banner tone="warning" title="The answer did not match the output schema">{missed}</Banner> : null;
  if (answer?.trim()) {
    const ends = answerRecord(answer);
    if (!ends) return <div className="min-w-0 space-y-6">{missedNote}<article className="report max-w-none" onClick={open} dangerouslySetInnerHTML={{ __html: markdown(answer, linked) }} /></div>;
    return (
      <div className="min-w-0 space-y-6">
        {missedNote}
        {ends.words && <article className="report max-w-none" onClick={open} dangerouslySetInnerHTML={{ __html: markdown(ends.words, linked) }} />}
        <AnswerFields record={ends.record} />
      </div>
    );
  }
  if (missedNote) return missedNote;
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
            <p className="caps mb-2 text-label text-muted-foreground">{k.replace(/_/g, " ")}</p>
            <article className="report max-w-none border bg-card p-5" onClick={open} dangerouslySetInnerHTML={{ __html: markdown(text, linked) }} />
          </section>
        ))}
        {(!written.length || Object.keys(rest as object).length > 0) && (
          <section>
            <p className="caps mb-2 text-label text-muted-foreground">{written.length ? "The rest of the output" : "Output"}</p>
            <pre className="whitespace-pre-wrap break-words [overflow-wrap:anywhere] border bg-card p-4 font-mono text-small leading-[1.8]">{JSON.stringify(rest, null, 2)}</pre>
          </section>
        )}
      </div>
    );
  }
  return null;
}
