import { useEffect, useState } from "react";
import { ProblemCard } from "@/components/Problem";
import { ListSkeleton } from "@/components/Skeleton";
import { Button } from "@/components/ui";
import { pageTitleClass, pageToolbarClass } from "@/components/ui/toolbar";
import type { Client } from "@/lib/client";
import { compact, dollars } from "@/lib/format";
import { type Problem, problem } from "@/lib/problem";
import { cn } from "@/lib/utils";
import type { Wrapped } from "@/lib/v2";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const card = "border bg-card p-4";
const heading = "caps text-small font-semibold text-muted-foreground";

/** Bars for a row of counts: each as tall as its share of the largest, its label under it. */
function Bars({ values, labels, label }: { values: readonly number[]; labels: readonly string[]; label: string }) {
  const top = Math.max(1, ...values);
  return (
    <div className="flex h-24 items-end gap-1" role="img" aria-label={label}>
      {values.map((n, i) => (
        <div key={labels[i]} className="flex h-full min-w-0 flex-1 flex-col justify-end gap-1" title={`${labels[i]}: ${n.toLocaleString("en-US")}`}>
          <div className={cn("w-full", n > 0 ? "bg-primary" : "bg-muted")} style={{ height: `${n > 0 ? Math.max(4, (n / top) * 100) : 2}%` }} />
        </div>
      ))}
    </div>
  );
}

/** One share of a total: a name, its figure and a bar. */
function Share({ name, figure, part, of }: { name: string; figure: string; part: number; of: number }) {
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1">
      <span className="truncate font-mono text-body">{name}</span>
      <span className="font-mono text-body tabular-nums text-muted-foreground">{figure}</span>
      <div className="col-span-2 h-1 bg-muted"><div className="h-full bg-primary" style={{ width: `${of > 0 ? Math.max(1, (part / of) * 100) : 0}%` }} /></div>
    </li>
  );
}

const hours = (ms: number) => `${(ms / 3_600_000).toFixed(1)} h`;
const monthOf = (day: string) => Number(day.slice(5, 7)) - 1;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Wrapped: a year of the work under this machine's session files, as the server counted it (GET /v2/wrapped). Numbers
 *  and names only; each section is plain, and a year with nothing in it says so. */
export function WrappedPage({ v2, year, go }: { v2: Client; year?: number; go: (hash: string) => void }) {
  const now = new Date().getFullYear();
  const shown = year ?? now;
  const [data, setData] = useState<Wrapped | null>(null);
  const [error, setError] = useState<Problem | null>(null);
  const [tries, setTries] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    setData(null);
    setError(null);
    v2.wrapped(shown, abort.signal).then(setData, (e: unknown) => { if (!abort.signal.aborted) setError(problem(e, "your year")); });
    return () => abort.abort();
  }, [v2, shown, tries]);
  const to = (y: number) => go(`#/wrapped?year=${y}`);

  const total = data ? data.tokens.input + data.tokens.output + data.tokens.cache_read + data.tokens.cache_write : 0;
  const months = data ? MONTHS.map((_, m) => data.days.filter((d) => monthOf(d.day) === m).reduce((n, d) => n + d.tokens, 0)) : [];
  const busiest = data?.days.reduce<Wrapped["days"][number] | null>((best, d) => (!best || d.tokens > best.tokens ? d : best), null) ?? null;
  const modelTokens = data ? data.models.reduce((n, m) => n + m.tokens, 0) : 0;
  const harnessTokens = data ? data.harnesses.reduce((n, h) => n + h.tokens, 0) : 0;

  return (
    <section className="flex h-full min-h-0 flex-col">
      <header className={cn(pageToolbarClass, "flex-wrap justify-between gap-2 px-5 md:px-6")}>
        <h1 className={pageTitleClass}>Wrapped {shown}</h1>
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={() => to(shown - 1)}>Previous year</Button>
          <Button size="sm" disabled={shown >= now} onClick={() => to(shown + 1)}>Next year</Button>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-auto">
        {error ? <ProblemCard problem={error} onRetry={() => setTries((n) => n + 1)} />
          : !data ? <ListSkeleton label="Reading your year" rows={5} />
          : data.requests === 0 ? <p className="p-6 font-sans text-body text-muted-foreground" role="status">No coding agent sessions under this machine's home in {shown}.</p>
          : (
            <div className="mx-auto grid max-w-4xl gap-4 p-5 md:p-6">
              <p className="font-sans text-small text-muted-foreground">Read on this machine from its own session files. Nothing leaves it: no prompt, title, path or project is in what the page shows.</p>
              <section className={card} aria-labelledby="w-year">
                <h2 id="w-year" className={heading}>Your year in tokens</h2>
                <p className="mt-2 font-mono text-figure font-semibold tabular-nums">{compact(total)} tokens</p>
                <p className="mt-1 font-mono text-body text-muted-foreground">
                  {data.sessions.toLocaleString("en-US")} sessions · {data.turns.toLocaleString("en-US")} prompts · {data.requests.toLocaleString("en-US")} model requests · {dollars(data.cost_usd)}
                  {data.unpriced_requests > 0 ? ` + ${data.unpriced_requests.toLocaleString("en-US")} requests with no known price` : ""}
                </p>
                <p className="mt-1 font-mono text-body text-muted-foreground">
                  {compact(data.tokens.input)} in · {compact(data.tokens.output)} out · {compact(data.tokens.cache_read)} cache read · {compact(data.tokens.cache_write)} cache write
                </p>
                <div className="mt-4"><Bars values={months} labels={MONTHS} label="Tokens by month" /></div>
                <div className="mt-1 flex gap-1 font-mono text-micro text-muted-foreground">{MONTHS.map((m) => <span key={m} className="flex-1 text-center">{m}</span>)}</div>
                {busiest && <p className="mt-3 font-mono text-body text-muted-foreground">Busiest day: {busiest.day}, {compact(busiest.tokens)} tokens across {data.days.length} days at work.</p>}
              </section>
              <section className={card} aria-labelledby="w-who">
                <h2 id="w-who" className={heading}>Harnesses and models</h2>
                <div className="mt-3 grid gap-6 md:grid-cols-2">
                  <ul className="grid content-start gap-3" aria-label="Harnesses">
                    {data.harnesses.map((h) => <Share key={h.harness} name={h.harness} figure={`${compact(h.tokens)} · ${h.sessions} sessions`} part={h.tokens} of={harnessTokens} />)}
                  </ul>
                  <ul className="grid content-start gap-3" aria-label="Models">
                    {data.models.map((m) => <Share key={m.model} name={m.model} figure={`${compact(m.tokens)} · ${dollars(m.cost_usd)}`} part={m.tokens} of={modelTokens} />)}
                  </ul>
                </div>
              </section>
              <section className={card} aria-labelledby="w-when">
                <h2 id="w-when" className={heading}>When you work</h2>
                <p className="mt-2 font-mono text-body text-muted-foreground">{hours(data.active_ms)} at work, in this machine's time zone.</p>
                <div className="mt-3 grid gap-6 md:grid-cols-2">
                  <div>
                    <Bars values={data.hours} labels={data.hours.map((_, h) => `${h}:00`)} label="Requests by hour of the day" />
                    <div className="mt-1 flex justify-between font-mono text-micro text-muted-foreground"><span>0h</span><span>12h</span><span>23h</span></div>
                  </div>
                  <div>
                    <Bars values={data.weekdays} labels={WEEKDAYS} label="Requests by day of the week" />
                    <div className="mt-1 flex gap-1 font-mono text-micro text-muted-foreground">{WEEKDAYS.map((d) => <span key={d} className="flex-1 text-center">{d}</span>)}</div>
                  </div>
                </div>
              </section>
              <section className={card} aria-labelledby="w-imported">
                <h2 id="w-imported" className={heading}>Imported</h2>
                <ul className="mt-3 grid gap-2">
                  {data.sources.map((s) => {
                    const runs = data.imported.find((i) => i.source === s.source)?.runs ?? 0;
                    return (
                      <li key={s.source} className="flex flex-wrap items-baseline justify-between gap-2 font-mono text-body">
                        <span>{s.source}: {s.sessions.toLocaleString("en-US")} sessions read</span>
                        {runs > 0
                          ? <a className="underline underline-offset-2 hover:text-foreground" href={`#/runs?source=${encodeURIComponent(s.source)}`}>{runs.toLocaleString("en-US")} imported as runs</a>
                          : <span className="text-muted-foreground">none imported as runs yet</span>}
                      </li>
                    );
                  })}
                </ul>
                <p className="mt-3 font-sans text-small text-muted-foreground">To open sessions here as runs, import them with <span className="font-mono">agentrun-serve import</span> or from Setup.</p>
              </section>
            </div>
          )}
      </div>
    </section>
  );
}
