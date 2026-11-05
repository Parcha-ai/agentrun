import { useEffect, useState } from "react";
import { ApprovalCard } from "@/components/ApprovalCard";
import { Button } from "@/components/ui/button";
import { cost, soFar } from "@/lib/format";
import { ago, choicesOf, failureCount, failureGroups } from "@/lib/needs";
import { elapsed } from "@/lib/runGraph";
import { NO_MESSAGES, runState } from "@/lib/runState";
import { cn } from "@/lib/utils";
import { pausedWords } from "@/components/NeedsYou";
import type { BudgetPending, PendingApproval, Run } from "@/lib/v2";

export type NeedsYouProps = {
  /** Runs waiting on a person's answer (`input_required`, with their `pending`: a question, or a tool call's approval). */
  asking: readonly Run[];
  /** The failed runs of the last 24 h; imported history is left out, and identical failures are said once. */
  failed: readonly Run[];
  /** How many runs failed in all (GET /v2/stats `runs.failed`), for the link to every one of them. */
  failedAll?: number;
  /** Runs at work now. */
  live: readonly Run[];
  agentName: (id: string) => string;
  /** Sends an answer to the run; resolves with the refusal to show, or null once it went. */
  onAnswer: (runId: string, text: string) => Promise<string | null>;
  /** Answers a run's tool call that waits for the owner's approval (`pending.id`); resolves with the refusal to show, in
   *  words, or null once it went. Without it, an approval links to its run. */
  onApprove?: (runId: string, approvalId: string, decision: "allow" | "deny", note?: string) => Promise<string | null>;
  /** Starts each run again with its own first message; resolves with the runs it started, and the refusal to show
   *  for one it couldn't (null when all started). */
  onRunAgain: (runs: readonly Run[]) => Promise<{ started: string[]; problem: string | null }>;
  onStop: (runId: string) => Promise<string | null>;
  /** What could not be read, when a read failed: the sections that read are still shown. */
  problem?: string | null;
  now?: () => number;
};

const runHref = (id: string) => `#/runs/${encodeURIComponent(id)}`;

/** Mission Control's first section: what needs a person now (each question answered in place, each failure said once
 *  with a way to run it again) and the runs at work, each with its clock. Nothing at all when nothing waits or works. */
export function NeedsYouStrip({ asking, failed, failedAll, live, agentName, onAnswer, onApprove, onRunAgain, onStop, problem, now = Date.now }: NeedsYouProps) {
  const groups = failureGroups(failed);
  // The live runs' clocks move on their own, once a second.
  const [, tick] = useState(0);
  useEffect(() => {
    if (!live.length) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [live.length]);
  // A refused answer to an approval, in words, by run: the strip reads again after it, and when another answer, a stop or
  // a cancel came first the run no longer waits, so its card goes; the words stay here until dismissed.
  const [refused, setRefused] = useState<{ runId: string; approvalId: string; title: string; text: string }[]>([]);
  const approve = onApprove && (async (runId: string, approvalId: string, decision: "allow" | "deny", note?: string) => {
    const said = await onApprove(runId, approvalId, decision, note);
    const title = asking.find((r) => r.run_id === runId)?.title ?? runId;
    setRefused((held) => [...held.filter((x) => x.runId !== runId), ...(said ? [{ runId, approvalId, title, text: said }] : [])]);
    return said;
  });
  const failures = failureCount(failed);
  const needs = asking.length + failures;
  if (!needs && !live.length && !problem && !refused.length) return null;
  const at = now();
  return (
    <section aria-label="Needs you" className="space-y-3">
      {needs > 0 && <h2 className="caps text-[12px] font-semibold">Needs you <span className="text-warning-text">· {needs}</span></h2>}
      {problem && <p className="border border-destructive/50 px-4 py-2.5 font-mono text-[12px] text-destructive-text" role="alert">{problem}</p>}
      {/* Said apart from the card unless that same approval's card still shows: the run may wait on its next call now. */}
      {refused.filter((x) => !asking.some((r) => r.run_id === x.runId && r.pending?.kind === "approval" && r.pending.id === x.approvalId)).map((x) => (
        <p key={x.runId} className="flex items-start gap-3 border border-destructive/50 px-4 py-2.5 font-mono text-[12px] text-destructive-text" role="alert">
          <span className="min-w-0 flex-1"><a href={runHref(x.runId)} className="underline-offset-4 hover:underline">{x.title}</a>: your answer wasn't taken. {x.text}</span>
          <button type="button" className="caps shrink-0 text-[11px] text-muted-foreground hover:text-foreground" onClick={() => setRefused((held) => held.filter((y) => y.runId !== x.runId))}>Dismiss</button>
        </p>
      ))}
      {asking.length > 0 && (
        <ul className="grid grid-cols-1 gap-3 xl:grid-cols-2">
          {asking.map((r) => r.pending?.kind === "approval"
            ? <Approval key={`${r.run_id}:${r.pending.id}`} run={r} pending={r.pending} agentName={agentName(r.agent_id)} at={at} onApprove={approve} />
            : <Question key={`${r.run_id}:${r.pending?.kind === "question" ? r.pending.asked_at : r.pending?.kind === "budget" ? (r.pending.at ?? "") : ""}`} run={r} agentName={agentName(r.agent_id)} at={at} onAnswer={onAnswer} />)}
        </ul>
      )}
      {groups.length > 0 && (
        <div className="border">
          <p className="caps flex items-center justify-between border-b px-4 py-2.5 text-[11px] text-muted-foreground">
            <span>Failed in the last 24 h · {failures}</span>
            <a href="#/runs?status=failed" className="normal-case tracking-normal hover:text-foreground">{failedAll === undefined ? "All failed runs →" : `All ${failedAll} failed ${failedAll === 1 ? "run" : "runs"} →`}</a>
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

/** A run's tool call waiting on the owner's approval, answered in place: the run page's card, compact, under the agent,
 *  the run and when it asked. */
function Approval({ run, pending, agentName, at, onApprove }: { run: Run; pending: PendingApproval; agentName: string; at: number; onApprove: NeedsYouProps["onApprove"] }) {
  return (
    <li data-run={run.run_id} className="min-w-0">
      <ApprovalCard compact pending={pending}
        heading={<Head run={run} agentName={agentName} since={`asked ${ago(pending.requested_at, at)} ago`} />}
        onAnswer={(decision, note) => (onApprove ? onApprove(run.run_id, pending.id, decision, note) : Promise.resolve("Open the run to answer it."))} />
    </li>
  );
}

function Question(props: { run: Run; agentName: string; at: number; onAnswer: NeedsYouProps["onAnswer"] }) {
  // A run paused at its spend cap is no question: it says why, and takes no answer until its cap is raised.
  return props.run.pending?.kind === "budget" ? <Paused run={props.run} pending={props.run.pending} agentName={props.agentName} /> : <Asked {...props} />;
}

function Paused({ run, pending, agentName }: { run: Run; pending: BudgetPending; agentName: string }) {
  return (
    <li data-run={run.run_id} className="min-w-0 border border-warning/50 bg-warning/5 p-4">
      <p className="flex min-w-0 items-center gap-2 text-[13px]">
        <span className="size-2 shrink-0 rounded-full bg-warning" aria-hidden />
        <span className="shrink-0 font-mono text-[12px]">{agentName}</span>
        <a href={runHref(run.run_id)} className="min-w-0 truncate text-muted-foreground hover:text-foreground">{run.title}</a>
      </p>
      <p className="caps mt-2 text-[11px] text-warning-text">{pausedWords(pending)}</p>
      {typeof pending.said === "string" && <p className="mt-1 text-[15px] leading-snug">{pending.said}</p>}
      <p className="mt-3 font-mono text-[12px] text-muted-foreground"><a href={runHref(run.run_id)} className="underline-offset-4 hover:underline">open the run</a></p>
    </li>
  );
}

/** A waiting run's line: its agent, its title (a link to the run) and when it asked. */
function Head({ run, agentName, since }: { run: Run; agentName: string; since?: string }) {
  return (
    <p className="flex min-w-0 items-center gap-2 text-[13px]">
      <span className="size-2 shrink-0 rounded-full bg-warning" aria-hidden />
      <span className="shrink-0 font-mono text-[12px]">{agentName}</span>
      <a href={runHref(run.run_id)} className="min-w-0 truncate text-muted-foreground hover:text-foreground">{run.title}</a>
      {since && <span className="ml-auto shrink-0 font-mono text-[12px] text-muted-foreground">{since}</span>}
    </p>
  );
}

function Asked({ run, agentName, at, onAnswer }: { run: Run; agentName: string; at: number; onAnswer: NeedsYouProps["onAnswer"] }) {
  const pending = run.pending?.kind === "question" ? run.pending : null;
  const question = pending?.question ?? "";
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
      <Head run={run} agentName={agentName} since={pending?.asked_at ? `asked ${ago(pending.asked_at, at)} ago` : undefined} />
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

function Failure({ message, runs: all, agentName, at, onRunAgain }: { message: string; runs: Run[]; agentName: (id: string) => string; at: number; onRunAgain: NeedsYouProps["onRunAgain"] }) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // The runs started again, by id: never offered again, while a new failure with the same error is.
  const [startedIds, setStartedIds] = useState<ReadonlySet<string>>(new Set());
  const runs = all.filter((r) => !startedIds.has(r.run_id));
  const startedCount = all.length - runs.length;
  const again = async () => {
    setBusy(true); setProblem(null);
    const { started, problem: p } = await onRunAgain(runs);
    setBusy(false); setProblem(p);
    setStartedIds((held) => new Set([...held, ...started]));
  };
  const startedNote = startedCount > 0 && <span className="font-mono text-[12px] text-success-text">Started again: {startedCount === 1 ? "1 run" : `${startedCount} runs`}</span>;
  if (!runs.length) return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b px-4 py-3 last:border-b-0">
      <span className="size-2 shrink-0 rounded-full bg-border-strong" aria-hidden />
      <p className="min-w-0 flex-1 truncate font-mono text-[12px] text-muted-foreground">{message}</p>
      {startedNote}
    </li>
  );
  const first = runs[0]!;
  const one = runs.length === 1;
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
      {startedNote}
      <Button type="button" size="sm" disabled={busy} onClick={() => void again()}>{one ? "Run again" : "Run all again"}</Button>
    </li>
  );
}

function Live({ run, agentName, at, onStop }: { run: Run; agentName: string; at: number; onStop: NeedsYouProps["onStop"] }) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const usd = run.cost?.usd;
  // A cost not known whole says what is known so far, when the server says it (costsofar/1): cost() reads "so far …".
  const spent = usd === 0 ? "nothing spent yet" : typeof usd === "number" ? `${cost(run.cost)} so far` : soFar(run.cost) ? cost(run.cost) : "cost not known yet";
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b px-4 py-3 last:border-b-0">
      <span className="size-2 shrink-0 rounded-full bg-[hsl(var(--run-active))] shadow-[0_0_0_4px_hsl(var(--run-active)/0.18)]" aria-hidden />
      <span className="shrink-0 font-mono text-[12px]">{agentName}</span>
      <a href={runHref(run.run_id)} className="min-w-0 flex-1 truncate text-[14px] hover:underline">{run.title}</a>
      <span className="font-mono text-[13px] text-[hsl(var(--run-active))]">working · {elapsed(at - Date.parse(run.created_at))}</span>
      <span className="font-mono text-[12px] text-muted-foreground">{spent}</span>
      <a href={runHref(run.run_id)} className="caps inline-flex h-8 items-center border px-3 text-[12px] hover:bg-accent">Steer</a>
      {/* Stop ends an agentic run's turn (runState's rule, as the run page offers it). A workflow run, or one not in a
          turn, doesn't stop: its page has Cancel. */}
      {runState(run.status, run.state, run.kind, NO_MESSAGES, true, run.error, run.review).canStop
        ? <Button type="button" size="sm" disabled={busy} onClick={async () => { setBusy(true); setProblem(await onStop(run.run_id)); setBusy(false); }}>Stop</Button>
        : <a href={runHref(run.run_id)} className="caps inline-flex h-8 items-center border px-3 text-[12px] hover:bg-accent">Open to cancel</a>}
      {problem && <p className="w-full font-mono text-[12px] text-destructive-text" role="alert">{problem}</p>}
    </li>
  );
}
