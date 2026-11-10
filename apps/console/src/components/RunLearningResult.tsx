import { ArrowUpRight, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import { ProblemCard } from "@/components/Problem";
import { money, underWay, type RunLearningResultData } from "@/lib/learning";
import { when } from "@/lib/format";
import { problem } from "@/lib/problem";
import type { Run } from "@/lib/v2";

type Props = {
  run: Pick<Run, "run_id" | "agent_id" | "learning">;
  read?: () => Promise<RunLearningResultData | null>;
  onViewChanges?: () => void;
};
type Read = { data: RunLearningResultData | null | undefined; error?: unknown; reading: boolean };
const stateLabel: Record<string, string> = { seeded: "Prepared", reflecting: "Reflecting", proposed: "Under review", merged: "Saved", dropped: "Not saved", pending: "Awaiting approval" };
const count = (value: number | null | undefined) => typeof value === "number" && Number.isFinite(value) ? value.toLocaleString("en-US") : "Not reported";

/** A read-only view of the recorded result, separate from the run's compact learning summary. */
export function RunLearningResult({ run, read, onViewChanges }: Props) {
  const [got, setGot] = useState<Read>({ data: undefined, reading: true });
  const [tries, setTries] = useState(0);
  const reader = useRef(read);
  reader.current = read;
  const available = !!read;
  const runId = run.run_id;
  const state = run.learning?.state;
  const at = run.learning?.at;
  useEffect(() => {
    let current = true;
    if (!available) { setGot({ data: undefined, reading: false }); return; }
    setGot((last) => ({ ...last, error: undefined, reading: true }));
    Promise.resolve().then(() => reader.current!()).then((data) => {
      if (data && data.run !== runId) throw new Error("The learning result belongs to a different run. Refresh to try again.");
      if (current) setGot({ data, reading: false });
    }).catch((error) => { if (current) setGot((last) => ({ ...last, error: error ?? new Error("The learning result could not be read."), reading: false })); });
    return () => { current = false; };
  }, [runId, state, at, available, tries]);
  // Returning from an external run or owner review reads the result again. The parent also updates the result when
  // the run's learning state moves, so a completed job can finish grading without reloading the page.
  useEffect(() => {
    const refresh = () => { if (!document.hidden) setTries((n) => n + 1); };
    window.addEventListener("focus", refresh); document.addEventListener("visibilitychange", refresh);
    return () => { window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh); };
  }, []);
  const result = got.data;
  const retry = () => setTries((n) => n + 1);
  const grade = result?.tokens?.grade;
  return <section className="overflow-hidden border bg-card" aria-label="Learning result">
    <header className="flex flex-wrap items-center gap-3 border-b px-5 py-4">
      <h2 className="text-lead font-semibold">Learning result</h2>
      {result && <Chip>{stateLabel[result.state] ?? result.state}</Chip>}
      <div className="ml-auto flex items-center gap-3">
        <a href={`#/agents/${encodeURIComponent(run.agent_id)}/learning`} className="inline-flex items-center gap-1 text-small text-muted-foreground hover:text-primary-text">Agent learning<ArrowUpRight className="size-3" aria-hidden /></a>
        {available && <Button size="icon" aria-label="Refresh learning result" disabled={got.reading} onClick={retry}><RefreshCw aria-hidden /></Button>}
      </div>
    </header>
    {got.reading && <p className="px-5 py-3 text-body text-muted-foreground" role="status">{result === undefined ? "Reading learning result…" : "Refreshing learning result…"}</p>}
    {got.error !== undefined && <div className="space-y-2 p-4">{result !== undefined && <p className="text-small text-muted-foreground">Showing the last result read.</p>}<ProblemCard problem={problem(got.error, "the learning result")} onRetry={retry} className="" /></div>}
    {!available && <p className="px-5 py-6 text-body text-muted-foreground">Detailed learning results are unavailable in this view.</p>}
    {available && result === null && <p className="px-5 py-6 text-body text-muted-foreground">No learning result was recorded for this run.</p>}
    {result && <div className="space-y-6 p-5">
      <div>
        {result.detail && <p className="break-words text-body leading-relaxed">{result.detail}</p>}
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-label text-muted-foreground">
          {result.at && <span>Updated {when(result.at)}</span>}{result.reason && <span>Reason: {result.reason}</span>}
        </div>
      </div>
      <section aria-label="Grader decision">
        <h3 className="mb-2 text-body font-semibold">Grader decision</h3>
        {result.verdict ? <>
          <p className="text-small text-muted-foreground">{result.verdict.merge
            ? result.verdict.items?.some((item) => !item.keep) ? "Recommended keeping some changes." : "Recommended keeping these changes."
            : "Did not recommend keeping these changes."}</p>
          <p className="mt-2 break-words text-body leading-relaxed">{result.verdict.reason}</p>
          {result.verdict.items?.length ? <ul className="mt-3 divide-y border">{result.verdict.items.map((item, i) => <li key={`${item.file}-${i}`} className="space-y-2 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2"><code className="min-w-0 break-all text-small">{item.file}</code><Chip tone={item.pending ? "warning" : item.keep ? "success" : "muted"}>{item.pending ? "Needs approval" : item.keep ? "Keep" : "Do not keep"}</Chip></div>
            <p className="break-words text-body leading-relaxed text-muted-foreground">{item.why}</p>
            {item.question && <p className="text-small">{item.question}</p>}
            {item.origin && <p className="text-label text-muted-foreground">{item.origin === "you" ? "From your instruction" : `Origin: ${item.origin}`}</p>}
          </li>)}</ul> : <p className="mt-2 text-small text-muted-foreground">No item decisions reported.</p>}
        </> : <p className="text-body text-muted-foreground">{underWay(result) ? "No grader decision recorded yet." : "No grader decision was recorded for this run."}</p>}
      </section>
      {!!result.pending?.length && <div className="border border-warning/40 px-4 py-3 break-words text-small leading-relaxed">
        <p className="font-semibold">Held for approval in this result</p>
        <p className="mt-1 text-muted-foreground">{result.pending.map((item) => item.name).join(", ")}. These changes required approval when recorded. Check their current status in Agent learning.</p>
      </div>}
      <section aria-label="Learning validation">
        <h3 className="mb-2 text-body font-semibold">Validation</h3>
        {result.problems?.length ? <ul className="space-y-3">{result.problems.map((issue, i) => <li key={i} className="border p-3"><p className="text-body">{issue.detail}</p><p className="mt-1 break-all font-mono text-label text-muted-foreground">{[issue.rule, issue.path].filter(Boolean).join(" · ")}</p></li>)}</ul>
          : <p className="text-small text-muted-foreground">No validation problems reported.</p>}
      </section>
      <section aria-label="Grading usage">
        <h3 className="mb-3 text-body font-semibold">Grading usage</h3>
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {[["Grading cost", typeof result.cost_usd?.grade === "number" ? money(result.cost_usd.grade) : "Not reported"], ["Input", count(grade?.input)], ["Output", count(grade?.output)], ["Cache reads", count(grade?.cache_read)], ["Cache writes", count(grade?.cache_write)]].map(([name, value]) => <div key={name} className="border p-3"><dt className="mb-1 text-label text-muted-foreground">{name}</dt><dd className="font-mono text-body">{value}</dd></div>)}
        </dl>
        <p className="mt-3 text-label leading-relaxed text-muted-foreground">Input excludes cache reads and writes. Reflection usage is included in the run's totals. These figures cover grading only.</p>
      </section>
      <section aria-label="Learning provenance" className="border-t pt-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3"><h3 className="text-body font-semibold">Provenance</h3>{onViewChanges && <Button size="sm" onClick={onViewChanges}>View changes<ArrowUpRight aria-hidden /></Button>}</div>
        <dl className="space-y-3 text-small">
          <div><dt className="mb-1 text-muted-foreground">Seed commit</dt><dd className="break-all font-mono">{result.seed ?? "Not reported"}</dd></div>
          <div><dt className="mb-1 text-muted-foreground">Merge commit</dt><dd className="break-all font-mono">{result.merged ?? "Not merged"}</dd></div>
        </dl>
      </section>
    </div>}
  </section>;
}
