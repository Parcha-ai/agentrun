import { useEffect, useState } from "react";
import { ApprovalCard } from "@/components/ApprovalCard";
import { Button } from "@/components/ui/button";
import { cost, soFar, runTitle } from "@/lib/format";
import { waitingWords } from "@/lib/learning";
import { ago, choicesOf, failureGroups } from "@/lib/needs";
import { elapsed } from "@/lib/runGraph";
import { NO_MESSAGES, runState } from "@/lib/runState";
import { cn } from "@/lib/utils";
import { pausedWords } from "@/components/NeedsYou";
import { ComputerAskCard } from "@/components/ComputerAskCard";
import { Input } from "@/components/ui/field";
import { askOf } from "@/lib/computerAsk";
import type { BudgetPending, ComputerAsk, HandBackOutcome, PendingApproval, Run } from "@/lib/v2";

export type NeedsYouProps = {
  /** Runs waiting on a person's answer (`input_required`, with their `pending`: a question, or a tool call's approval). */
  asking: readonly Run[];
  /** Failed runs; imported history is left out, and identical failures are said once. */
  failed: readonly Run[];
  /** Runs at work now. */
  live: readonly Run[];
  /** The active agents whose learned items wait for the owner's OK (GET /v2/agents, each one's `learning.pending` above
   *  0), each with how many: approved on its Learning tab. */
  learning?: readonly { agent_id: string; name: string; pending: number }[];
  agentName: (id: string) => string;
  /** Sends an answer to the run; resolves with the refusal to show, or null once it went. */
  onAnswer: (runId: string, text: string) => Promise<string | null>;
  /** Answers a run's tool call that waits for the owner's approval (`pending.id`); resolves with the refusal to show, in
   *  words, or null once it went. Without it, an approval links to its run. */
  onApprove?: (runId: string, approvalId: string, decision: "allow" | "deny", note?: string) => Promise<string | null>;
  /** Answers a run's ask for the person at its computer (`pending.kind` "browser" or "computer"): done or cancelled;
   *  resolves with the refusal to show, in words, or null once taken. Without it, the ask links to its run's screen alone. */
  onHandBack?: (runId: string, outcome: HandBackOutcome) => Promise<string | null>;
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
export function NeedsYouStrip({ asking, failed, live, learning = [], agentName, onAnswer, onApprove, onHandBack, onRunAgain, onStop, problem, now = Date.now }: NeedsYouProps) {
  const groups = failureGroups(failed);
  // The live runs' clocks move on their own, once a second.
  const [, tick] = useState(0);
  useEffect(() => {
    if (!live.length) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [live.length]);
  // A refused answer, in words, by run: to an approval (`what`, its id) or to an ask at its computer (`ask:` its asked_at).
  // The strip reads again after it, and when another answer, a stop, a cancel or the ask's expiry came first the run no
  // longer waits on it, so its card goes; the words stay here until dismissed.
  const [refused, setRefused] = useState<{ runId: string; what: string; title: string; text: string }[]>([]);
  const hold = (runId: string, what: string, said: string | null) => {
    const asked = asking.find((r) => r.run_id === runId);
    const title = asked ? runTitle(asked) : runId;
    setRefused((held) => [...held.filter((x) => x.runId !== runId), ...(said ? [{ runId, what, title, text: said }] : [])]);
  };
  const approve = onApprove && (async (runId: string, approvalId: string, decision: "allow" | "deny", note?: string) => {
    const said = await onApprove(runId, approvalId, decision, note);
    hold(runId, approvalId, said);
    return said;
  });
  const handBack = onHandBack && (async (runId: string, ask: ComputerAsk, outcome: HandBackOutcome) => {
    const said = await onHandBack(runId, outcome);
    hold(runId, `ask:${ask.asked_at}`, said);
    return said;
  });
  // What a run waits on now, as `what` names it: its card shows the words itself while it waits on the same thing.
  const waitsOn = (r: Run) => { const ask = askOf(r); return r.pending?.kind === "approval" ? r.pending.id : ask ? `ask:${ask.asked_at}` : null; };
  const failures = groups.reduce((n, g) => n + g.runs.length, 0);
  const waiting = learning.filter((a) => a.pending > 0);
  const learned = waiting.reduce((n, a) => n + a.pending, 0);
  const needs = asking.length + failures + learned;
  if (!needs && !live.length && !problem && !refused.length) return null;
  const at = now();
  return (
    <section aria-label="Needs you" className="space-y-3">
      {needs > 0 && <h2 className="caps text-small font-semibold">Needs you <span className="text-warning-text">· {needs}</span></h2>}
      {problem && <p className="border border-destructive/50 px-4 py-2.5 font-mono text-small text-destructive-text" role="alert">{problem}</p>}
      {/* Said apart from the card unless that same approval's card still shows: the run may wait on its next call now. */}
      {refused.filter((x) => !asking.some((r) => r.run_id === x.runId && waitsOn(r) === x.what)).map((x) => (
        <p key={x.runId} className="flex items-start gap-3 border border-destructive/50 px-4 py-2.5 font-mono text-small text-destructive-text" role="alert">
          <span className="min-w-0 flex-1"><a href={runHref(x.runId)} className="underline-offset-4 hover:underline">{x.title}</a>: your answer wasn't taken. {x.text}</span>
          <button type="button" className="caps shrink-0 text-label text-muted-foreground hover:text-foreground" onClick={() => setRefused((held) => held.filter((y) => y.runId !== x.runId))}>Dismiss</button>
        </p>
      ))}
      {asking.length > 0 && (
        <ul className="grid grid-cols-1 gap-3 xl:grid-cols-2">
          {asking.map((r) => r.pending?.kind === "approval"
            ? <Approval key={`${r.run_id}:${r.pending.id}`} run={r} pending={r.pending} agentName={agentName(r.agent_id)} at={at} onApprove={approve} />
            : askOf(r)
            ? <Asking key={`${r.run_id}:${askOf(r)!.asked_at}`} run={r} ask={askOf(r)!} agentName={agentName(r.agent_id)} at={at} onHandBack={handBack} />
            : <Question key={`${r.run_id}:${r.pending?.kind === "question" ? r.pending.asked_at : r.pending?.kind === "budget" ? (r.pending.at ?? "") : ""}`} run={r} agentName={agentName(r.agent_id)} at={at} onAnswer={onAnswer} />)}
        </ul>
      )}
      {groups.length > 0 && (
        <div className="border">
          <p className="caps flex items-center justify-between border-b px-4 py-2.5 text-label text-muted-foreground">
            <span>Failed · {failures}</span>
            <a href="#/runs?status=failed" className="normal-case tracking-normal hover:text-foreground">All failed runs →</a>
          </p>
          <ul>{groups.map((g) => <Failure key={g.message} message={g.message} runs={g.runs} agentName={agentName} at={at} onRunAgain={onRunAgain} />)}</ul>
        </div>
      )}
      {waiting.length > 0 && (
        <div className="border">
          <p className="caps border-b px-4 py-2.5 text-label text-muted-foreground">Learned, waiting for your OK · {learned}</p>
          <ul>{waiting.map((a) => (
            <li key={a.agent_id} className="flex min-w-0 items-center gap-3 border-b px-4 py-3 last:border-b-0">
              <span className="size-2 shrink-0 bg-warning" aria-hidden />
              <span className="shrink-0 font-mono text-small">{a.name}</span>
              <span className="min-w-0 flex-1 truncate text-body text-muted-foreground">{waitingWords(a.pending)}</span>
              <a href={`#/agents/${encodeURIComponent(a.agent_id)}/learning`} className="caps shrink-0 text-label text-muted-foreground hover:text-foreground">Review →</a>
            </li>
          ))}</ul>
        </div>
      )}
      {live.length > 0 && (
        <div className="border">
          <p className="caps border-b px-4 py-2.5 text-label text-muted-foreground">Running now · {live.length}</p>
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

/** A run whose agent asks for the person at its computer: what to do, when it's done, when it expires, the way to its
 *  screen (the run page, which opens on its Screen tab), and Done or Cancel where the page can answer. */
function Asking({ run, ask, agentName, at, onHandBack }: { run: Run; ask: ComputerAsk; agentName: string; at: number; onHandBack?: (runId: string, ask: ComputerAsk, outcome: HandBackOutcome) => Promise<string | null> }) {
  return (
    <li data-run={run.run_id} className="min-w-0 border border-warning/50 bg-warning/5">
      <ComputerAskCard compact ask={ask}
        heading={<Head run={run} agentName={agentName} since={`asked ${ago(ask.asked_at, at)} ago`} />}
        open={<a href={runHref(run.run_id)} className="text-body underline underline-offset-2">Open its screen</a>}
        onAnswer={onHandBack && ((outcome) => onHandBack(run.run_id, ask, outcome))} />
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
      <p className="flex min-w-0 items-center gap-2 text-body">
        <span className="size-2 shrink-0 bg-warning" aria-hidden />
        <span className="shrink-0 font-mono text-small">{agentName}</span>
        <a href={runHref(run.run_id)} className="min-w-0 truncate text-muted-foreground hover:text-foreground">{runTitle(run)}</a>
      </p>
      <p className="caps mt-2 text-label text-warning-text">{pausedWords(pending)}</p>
      {typeof pending.said === "string" && <p className="mt-1 text-prose leading-snug">{pending.said}</p>}
      <p className="mt-3 font-mono text-small text-muted-foreground"><a href={runHref(run.run_id)} className="underline-offset-4 hover:underline">open the run</a></p>
    </li>
  );
}

/** A waiting run's line: its agent, its title (a link to the run) and when it asked. */
function Head({ run, agentName, since }: { run: Run; agentName: string; since?: string }) {
  return (
    <p className="flex min-w-0 items-center gap-2 text-body">
      <span className="size-2 shrink-0 bg-warning" aria-hidden />
      <span className="shrink-0 font-mono text-small">{agentName}</span>
      <a href={runHref(run.run_id)} className="min-w-0 truncate text-muted-foreground hover:text-foreground">{runTitle(run)}</a>
      {since && <span className="ml-auto shrink-0 font-mono text-small text-muted-foreground">{since}</span>}
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
      <p className="mt-2 text-base leading-snug">{question}</p>
      {sent ? (
        <p className="mt-3 font-mono text-body text-success-text">Answered: {sent} · <a href={runHref(run.run_id)} className="underline-offset-4 hover:underline">open the run</a></p>
      ) : (
        <form onSubmit={(e) => void send(e)} className="mt-3 flex flex-wrap items-center gap-2">
          {choices.map((c) => (
            <button key={c} type="button" onClick={() => setText(c)} className={cn("border px-3 py-1.5 text-body hover:border-border-strong", text === c ? "border-warning text-warning-text" : "border-border")}>{c}</button>
          ))}
          <Input value={text} onChange={(e) => setText(e.target.value)} aria-label={`Answer ${agentName}`} placeholder={choices.length ? "Or type an answer…" : "Type an answer…"}
            className="h-9 min-w-[9rem] flex-1 font-sans text-lead" />
          <Button type="submit" variant="solid" size="sm" disabled={busy || !text.trim()}>{busy ? "Sending…" : "Send"}</Button>
          {problem && <p className="w-full font-mono text-small text-destructive-text" role="alert">{problem}</p>}
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
  const startedNote = startedCount > 0 && <span className="font-mono text-small text-success-text">Started again: {startedCount === 1 ? "1 run" : `${startedCount} runs`}</span>;
  if (!runs.length) return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b px-4 py-3 last:border-b-0">
      <span className="size-2 shrink-0 bg-border-strong" aria-hidden />
      <p className="min-w-0 flex-1 truncate font-mono text-small text-muted-foreground">{message}</p>
      {startedNote}
    </li>
  );
  const first = runs[0]!;
  const one = runs.length === 1;
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b px-4 py-3 last:border-b-0">
      <span className="size-2 shrink-0 bg-destructive" aria-hidden />
      <div className="min-w-0 flex-1">
        {one
          ? <p className="flex min-w-0 gap-3 text-lead"><span className="shrink-0 font-mono text-small leading-5">{agentName(first.agent_id)}</span><a href={runHref(first.run_id)} className="min-w-0 truncate hover:underline">{runTitle(first)}</a></p>
          : <p className="text-lead">{runs.length} runs failed <span className="text-muted-foreground">· {[...new Set(runs.map((r) => agentName(r.agent_id)))].join(", ")}</span></p>}
        <p className="mt-0.5 truncate font-mono text-small text-destructive-text">{message}</p>
        {!one && (
          <details className="mt-1 text-body">
            <summary className="cursor-pointer font-mono text-small text-muted-foreground">The runs</summary>
            <ul className="mt-1 space-y-1">{runs.map((r) => <li key={r.run_id}><a href={runHref(r.run_id)} className="hover:underline">{runTitle(r)}</a> <span className="font-mono text-small text-muted-foreground">· {agentName(r.agent_id)}</span></li>)}</ul>
          </details>
        )}
        {problem && <p className="mt-1 font-mono text-small text-destructive-text" role="alert">{problem}</p>}
      </div>
      <span className="font-mono text-small text-muted-foreground">{ago(first.ended_at ?? first.created_at, at)} ago</span>
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
      <span className="size-2 shrink-0 bg-run-active ring-4 ring-run-active/[0.18]" aria-hidden />
      <span className="shrink-0 font-mono text-small">{agentName}</span>
      <a href={runHref(run.run_id)} className="min-w-0 flex-1 truncate text-lead hover:underline">{runTitle(run)}</a>
      <span className="font-mono text-body text-run-active">working · {elapsed(at - Date.parse(run.created_at))}</span>
      <span className="font-mono text-small text-muted-foreground">{spent}</span>
      <a href={runHref(run.run_id)} className="caps inline-flex h-8 items-center border px-3 text-small hover:bg-accent">Steer</a>
      {/* Stop ends an agentic run's turn (runState's rule, as the run page offers it). A workflow run, or one not in a
          turn, doesn't stop: its page has Cancel. */}
      {runState(run.status, run.state, run.kind, NO_MESSAGES, true, run.error, run.review).canStop
        ? <Button type="button" size="sm" disabled={busy} onClick={async () => { setBusy(true); setProblem(await onStop(run.run_id)); setBusy(false); }}>Stop</Button>
        : <a href={runHref(run.run_id)} className="caps inline-flex h-8 items-center border px-3 text-small hover:bg-accent">Open to cancel</a>}
      {problem && <p className="w-full font-mono text-small text-destructive-text" role="alert">{problem}</p>}
    </li>
  );
}
