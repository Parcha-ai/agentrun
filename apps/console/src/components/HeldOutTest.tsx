import { useEffect, useState } from "react";
import { Bone } from "@/components/Skeleton";
import { problem, ProblemCard } from "@/components/learningProblem";
import type { Client } from "@/lib/client";
import { level } from "@/lib/costPerRun";
import { when } from "@/lib/format";
import type { LearningEval, LearningEvals } from "@/lib/v2";

// The Learning tab's headline (GET /v2/agents/{id}/learning/evals): the agent's latest eval record, a test on jobs it never
// learned from: its accuracy with the 95% Wilson interval and n (the server's, from the counts posted), and the cost a
// task with learning against by hand. Only ever a posted record: "Not measured yet" until one is, and never a figure from
// the agent's own runs (those are the jobs it learned from).

/** What a person does to get the headline. */
export const RECORD_HOW = "Run the agent on jobs it never learned from and record the counts: agentrun learning record-eval <agent> --body @eval.json (POST /v2/agents/{id}/learning/evals).";

const percent = (share: number) => `${Math.round(share * 1000) / 10}%`;

/** The figures a record says, as a person reads them. */
export function headlineOf(record: LearningEval) {
  const { cost_per_task_usd: learned, baseline_cost_per_task_usd: hand } = record;
  const counted = learned !== null && hand !== null;
  const times = counted && learned > 0 ? Math.round((hand / learned) * 10) / 10 : null;
  const [lo, hi] = record.ci;
  return {
    accuracy: percent(record.accuracy),
    accuracyVs: `95% interval ${percent(lo!)} to ${percent(hi!)}, n=${record.n.toLocaleString("en-US")}`,
    cost: !counted ? (learned !== null ? level(learned) : "Not counted") : times === null ? level(learned) : times >= 1 ? `${times}x cheaper` : `${Math.round((learned / hand) * 10) / 10}x the cost`,
    costVs: counted ? `${level(learned)} a task vs ${level(hand)} by hand` : learned !== null ? `${level(learned)} a task; by hand not counted` : "The test did not count the cost a task.",
  };
}

export function HeldOutTest({ v2, agentId, quiet = false }: { v2: Client; agentId: string; quiet?: boolean }) {
  const [data, setData] = useState<LearningEvals | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [asked, setAsked] = useState(0);
  useEffect(() => {
    let live = true;
    setError(null);
    Promise.resolve().then(() => v2.learningEvals(agentId)).then((r) => { if (live) setData(r); }, (e) => { if (live) setError(e ?? new Error("unknown")); });
    return () => { live = false; };
  }, [v2, agentId, asked]);
  if (quiet && !data?.latest) return null;
  if (error && !data) return <ProblemCard problem={problem(error, "the held-out test")} onRetry={() => setAsked((n) => n + 1)} className="" />;
  if (!data) return <Bone className="h-[116px] w-full" />;
  return <HeldOutCard result={data.latest} />;
}

export function HeldOutCard({ result }: { result: LearningEval | null }) {
  return (
    <section className="min-w-0 border" aria-label="Held-out test" data-testid="held-out-test">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b px-4 py-3">
        <h3 className="caps text-small font-semibold">Held-out test</h3>
        {result && <p className="font-mono text-small text-muted-foreground">{result.n.toLocaleString("en-US")} jobs it never learned from · {result.name} · {when(result.recorded_at)}{result.learned_revision ? ` · revision ${result.learned_revision.slice(0, 7)}` : ""}</p>}
      </div>
      {result ? <Figures result={result} /> : (
        <div className="px-4 py-4" role="status">
          <p className="font-mono text-body">Not measured yet.</p>
          <p className="mt-1 max-w-prose text-body text-muted-foreground">{RECORD_HOW}</p>
        </div>
      )}
    </section>
  );
}

function Figures({ result }: { result: LearningEval }) {
  const f = headlineOf(result);
  const tiles = [
    { label: "Held-out accuracy", value: f.accuracy, lines: [f.accuracyVs] },
    { label: "Cost a task", value: f.cost, lines: [f.costVs] },
  ];
  return (
    <>
    <dl className="grid grid-cols-1 sm:grid-cols-2">
      {tiles.map((t, i) => (
        <div key={t.label} className={i ? "border-t px-4 py-3 sm:border-l sm:border-t-0" : "px-4 py-3"}>
          <dt className="caps text-label text-muted-foreground">{t.label}</dt>
          <dd className="mt-1 font-mono text-figure font-semibold tabular-nums">{t.value}</dd>
          {t.lines.map((l) => <dd key={l} className="mt-0.5 font-mono text-small text-muted-foreground">{l}</dd>)}
        </div>
      ))}
    </dl>
    {result.label_source && <p className="border-t px-4 py-2 font-mono text-label text-muted-foreground">Labels: {result.label_source}</p>}
    </>
  );
}
