import { useEffect, useState } from "react";
import { Bone } from "@/components/Skeleton";
import { problem, ProblemCard } from "@/components/learningProblem";
import type { Client } from "@/lib/client";
import { level } from "@/lib/costPerRun";
import { when } from "@/lib/format";
import type { LearningEval, LearningEvals } from "@/lib/v2";

// The Learning tab's headline (GET /v2/agents/{id}/learning/evals): the latest held-out test recorded for the agent, how
// accurate and how cheap the agent with what it learned is against the agent by hand, on jobs it never learned from, with
// how many jobs and each side's 95% interval. Only ever a posted result: "Not measured yet" until one is, and never a
// figure from the agent's own runs (those are the jobs it learned from).

/** What a person does to get the headline. */
export const RECORD_HOW = "Run the agent on jobs it never learned from, with learning and by hand, and post the result: POST /v2/agents/{id}/learning/evals, or agentrun learning record-eval.";

const percent = (share: number) => `${Math.round(share * 1000) / 10}%`;
const interval = ([lo, hi]: [number, number] | number[]) => `${percent(lo!)} to ${percent(hi!)}`;

/** The figures a result says, as a person reads them. */
export function headlineOf(result: LearningEval) {
  const { learned, by_hand: hand } = result;
  const points = Math.round((learned.accuracy - hand.accuracy) * 1000) / 10;
  const costs = learned.usd_per_job !== null && hand.usd_per_job !== null ? { learned: learned.usd_per_job, hand: hand.usd_per_job } : null;
  const times = costs && costs.learned > 0 ? Math.round((costs.hand / costs.learned) * 10) / 10 : null;
  return {
    accuracy: percent(learned.accuracy),
    accuracyVs: `${percent(hand.accuracy)} by hand, ${points > 0 ? "+" : ""}${points} points`,
    accuracyCi: `95% interval ${interval(learned.ci)} (by hand ${interval(hand.ci)})`,
    cost: costs === null ? "Not counted" : times === null ? level(costs.learned) : times >= 1 ? `${times}x cheaper` : `${Math.round((costs.learned / costs.hand) * 10) / 10}x the cost`,
    costVs: costs === null ? "The test did not count the cost a job." : `${level(costs.learned)} a job, ${level(costs.hand)} by hand`,
  };
}

/** The card for an agent, read when it shows. `quiet`: under the Learning tab's own empty state, it shows only once a
 *  result is recorded (no "Not measured yet" beside "Nothing learned yet"). */
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
  if (quiet && !data?.evals.length) return null;
  if (error && !data) return <ProblemCard problem={problem(error, "the held-out test")} onRetry={() => setAsked((n) => n + 1)} className="" />;
  if (!data) return <Bone className="h-[116px] w-full" />;
  return <HeldOutCard result={data.evals[0] ?? null} />;
}

export function HeldOutCard({ result }: { result: LearningEval | null }) {
  return (
    <section className="min-w-0 border" aria-label="Held-out test" data-testid="held-out-test">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b px-4 py-3">
        <h3 className="caps text-small font-semibold">Held-out test</h3>
        {result && <p className="font-mono text-small text-muted-foreground">{result.n.toLocaleString("en-US")} jobs it never learned from · {result.source} · {when(result.measured_at)}{result.learned_revision ? ` · revision ${result.learned_revision.slice(0, 7)}` : ""}</p>}
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
    { label: "Accuracy, learned", value: f.accuracy, lines: [f.accuracyVs, f.accuracyCi] },
    { label: "Cost a job", value: f.cost, lines: [f.costVs] },
  ];
  return (
    <dl className="grid grid-cols-1 sm:grid-cols-2">
      {tiles.map((t, i) => (
        <div key={t.label} className={i ? "border-t px-4 py-3 sm:border-l sm:border-t-0" : "px-4 py-3"}>
          <dt className="caps text-label text-muted-foreground">{t.label}</dt>
          <dd className="mt-1 font-mono text-figure font-semibold tabular-nums">{t.value}</dd>
          {t.lines.map((l) => <dd key={l} className="mt-0.5 font-mono text-small text-muted-foreground">{l}</dd>)}
        </div>
      ))}
    </dl>
  );
}
