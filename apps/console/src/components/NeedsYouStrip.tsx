import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { cost } from "@/lib/format";
import { ago, choicesOf, failureGroups } from "@/lib/needs";
import { elapsed } from "@/lib/runGraph";
import { cn } from "@/lib/utils";
import type { Run } from "@/lib/v2";

export type NeedsYouProps = {
  /** Runs waiting on a person's answer (`input_required`, with their `pending` question). */
  asking: readonly Run[];
  /** Failed runs; imported history is left out, and identical failures are said once. */
  failed: readonly Run[];
  /** Runs at work now. */
  live: readonly Run[];
  agentName: (id: string) => string;
  /** Sends an answer to the run; resolves with the refusal to show, or null once it went. */
  onAnswer: (runId: string, text: string) => Promise<string | null>;
  /** Starts each run again with its own first message; resolves with the refusal to show, or null. */
  onRunAgain: (runs: readonly Run[]) => Promise<string | null>;
  onStop: (runId: string) => Promise<string | null>;
  now?: () => number;
};

const runHref = (id: string) => `#/runs/${encodeURIComponent(id)}`;

/** Mission Control's first section: what needs a person now (each question answered in place, each failure said once
 *  with a way to run it again) and the runs at work, each with its clock. Nothing at all when nothing waits or works. */
export function NeedsYouStrip({ asking, failed, live, agentName, onAnswer, onRunAgain, onStop, now = Date.now }: NeedsYouProps) {
  const groups = failureGroups(failed);
  // The live runs' clocks move on their own, once a second.
  const [, tick] = useState(0);
  useEffect(() => {
    if (!live.length) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [live.length]);
  const failures = groups.reduce((n, g) => n + g.runs.length, 0);
  const needs = asking.length + failures;
  if (!needs && !live.length) return null;
  const at = now();
  return (
    <section aria-label="Needs you" className="space-y-3">
      {needs > 0 && <h2 className="caps text-[12px] font-semibold">Needs you <span className="text-warning-text">· {needs}</span></h2>}
      {asking.length > 0 && (
        <ul className="grid grid-cols-1 gap-3 xl:grid-cols-2">
          {asking.map((r) => <Question key={r.run_id} run={r} agentName={agentName(r.agent_id)} at={at} onAnswer={onAnswer} />)}
        </ul>
      )}
      {groups.length > 0 && (
        <div className="border">
          <p className="caps flex items-center justify-between border-b px-4 py-2.5 text-[11px] text-muted-foreground">
            <span>Failed · {failures}</span>
            <a href="#/runs?status=failed" className="normal-case tracking-normal hover:text-foreground">All failed runs →</a>
          </p>
          <ul>{groups.map((g) => <Failure key={g.message} message={g.message} runs={g.runs} agentName={agentName} at={at} onRunAgain={onRunAgain} />)}</ul>
        </div>
      )}
      {live.length > 0 && (
        <div className="border">
          <p className="caps border-b px-4 py-2.5 text-[11px] text-muted-foreground">Running now · {live.length}</p>
          <ul>{live.map((r) => <Live key={r.run_id} run={r} agentName={agentName(r.agent_id)} at={at} onStop={onStop} />)}</ul>
        </div>
      )}
    </section>
  );
}

function Question({ run, agentName, at, onAnswer }: { run: Run; agentName: string; at: number; onAnswer: NeedsYouProps["onAnswer"] }) {
  const question = run.pending?.question ?? "";
  const choices = choicesOf(question);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    const answer = text.trim();
    if (!answer || busy) return;
    setBusy(true); setProblem(null);
    const p = await onAnswer(run.run_id, answer);
    setBusy(false);
    if (p) setProblem(p); else setSent(answer);
  };
  return (
    <li data-run={run.run_id} className="min-w-0 border border-warning/50 bg-warning/5 p-4">
      <p className="flex min-w-0 items-center gap-2 text-[13px]">
        <span className="size-2 shrink-0 rounded-full bg-warning" aria-hidden />
        <span className="shrink-0 font-mono text-[12px]">{agentName}</span>
        <a href={runHref(run.run_id)} className="min-w-0 truncate text-muted-foreground hover:text-foreground">{run.title}</a>
        {run.pending?.asked_at && <span className="ml-auto shrink-0 font-mono text-[12px] text-muted-foreground">asked {ago(run.pending.asked_at, at)} ago</span>}
      </p>
      <p className="mt-2 text-[16px] leading-snug">{question}</p>
      {sent ? (
        <p className="mt-3 font-mono text-[13px] text-success-text">Answered: {sent} · <a href={runHref(run.run_id)} className="underline-offset-4 hover:underline">open the run</a></p>
      ) : (
        <form onSubmit={(e) => void send(e)} className="mt-3 flex flex-wrap items-center gap-2">
          {choices.map((c) => (
            <button key={c} type="button" onClick={() => setText(c)} className={cn("rounded-full border px-3 py-1.5 text-[13px] hover:border-border-strong", text === c ? "border-warning text-warning-text" : "border-border")}>{c}</button>
          ))}
          <input value={text} onChange={(e) => setText(e.target.value)} aria-label={`Answer ${agentName}`} placeholder={choices.length ? "Or type an answer…" : "Type an answer…"}
            className="h-9 min-w-[9rem] flex-1 border bg-background px-3 text-[14px] outline-none focus:border-border-strong" />
          <Button type="submit" variant="solid" size="sm" disabled={busy || !text.trim()}>{busy ? "Sending…" : "Send"}</Button>
          {problem && <p className="w-full font-mono text-[12px] text-destructive-text" role="alert">{problem}</p>}
        </form>
      )}
    </li>
  );
}

function Failure({ message, runs, agentName, at, onRunAgain }: { message: string; runs: Run[]; agentName: (id: string) => string; at: number; onRunAgain: NeedsYouProps["onRunAgain"] }) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [started, setStarted] = useState(false);
  const first = runs[0]!;
  const one = runs.length === 1;
  const again = async () => {
    setBusy(true); setProblem(null);
    const p = await onRunAgain(runs);
    setBusy(false);
    if (p) setProblem(p); else setStarted(true);
  };
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b px-4 py-3 last:border-b-0">
      <span className="size-2 shrink-0 rounded-full bg-destructive" aria-hidden />
      <div className="min-w-0 flex-1">
        {one
          ? <p className="flex min-w-0 gap-3 text-[14px]"><span className="shrink-0 font-mono text-[12px] leading-5">{agentName(first.agent_id)}</span><a href={runHref(first.run_id)} className="min-w-0 truncate hover:underline">{first.title}</a></p>
          : <p className="text-[14px]">{runs.length} runs failed <span className="text-muted-foreground">· {[...new Set(runs.map((r) => agentName(r.agent_id)))].join(", ")}</span></p>}
        <p className="mt-0.5 truncate font-mono text-[12px] text-destructive-text">{message}</p>
        {!one && (
          <details className="mt-1 text-[13px]">
            <summary className="cursor-pointer font-mono text-[12px] text-muted-foreground">The runs</summary>
            <ul className="mt-1 space-y-1">{runs.map((r) => <li key={r.run_id}><a href={runHref(r.run_id)} className="hover:underline">{r.title}</a> <span className="font-mono text-[12px] text-muted-foreground">· {agentName(r.agent_id)}</span></li>)}</ul>
          </details>
        )}
        {problem && <p className="mt-1 font-mono text-[12px] text-destructive-text" role="alert">{problem}</p>}
      </div>
      <span className="font-mono text-[12px] text-muted-foreground">{ago(first.ended_at ?? first.created_at, at)} ago</span>
      {started
        ? <span className="font-mono text-[12px] text-success-text">Started again: {one ? "1 run" : `${runs.length} runs`}</span>
        : <Button type="button" size="sm" disabled={busy} onClick={() => void again()}>{one ? "Run again" : "Run all again"}</Button>}
    </li>
  );
}

function Live({ run, agentName, at, onStop }: { run: Run; agentName: string; at: number; onStop: NeedsYouProps["onStop"] }) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const spent = run.cost?.usd ? `${cost(run.cost)} so far` : "nothing spent yet";
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b px-4 py-3 last:border-b-0">
      <span className="size-2 shrink-0 rounded-full bg-[hsl(var(--run-active))] shadow-[0_0_0_4px_hsl(var(--run-active)/0.18)]" aria-hidden />
      <span className="shrink-0 font-mono text-[12px]">{agentName}</span>
      <a href={runHref(run.run_id)} className="min-w-0 flex-1 truncate text-[14px] hover:underline">{run.title}</a>
      <span className="font-mono text-[13px] text-[hsl(var(--run-active))]">working · {elapsed(at - Date.parse(run.created_at))}</span>
      <span className="font-mono text-[12px] text-muted-foreground">{spent}</span>
      <a href={runHref(run.run_id)} className="caps inline-flex h-8 items-center border px-3 text-[12px] hover:bg-accent">Steer</a>
      <Button type="button" size="sm" disabled={busy} onClick={async () => { setBusy(true); setProblem(await onStop(run.run_id)); setBusy(false); }}>Stop</Button>
      {problem && <p className="w-full font-mono text-[12px] text-destructive-text" role="alert">{problem}</p>}
    </li>
  );
}
