import { useEffect, useState } from "react";
import { ProblemCard } from "@/components/Problem";
import { ListSkeleton } from "@/components/Skeleton";
import { Button, Checkbox } from "@/components/ui";
import { pageTitleClass, pageToolbarClass } from "@/components/ui/toolbar";
import { wrappedCards } from "@/components/WrappedCards";
import { harnessLabel } from "@/lib/agentForm";
import { type Client, ClientError } from "@/lib/client";
import { compact, dollars } from "@/lib/format";
import { type Problem, problem } from "@/lib/problem";
import { cn } from "@/lib/utils";
import type { Wrapped } from "@/lib/v2";
import { type CardRenderer, WRAPPED_CARDS } from "@/lib/wrappedCards";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const card = "border bg-card p-4";
const heading = "caps text-small font-semibold text-muted-foreground";

/** Bars for a row of counts: each as tall as its share of the largest, its label under it. The bars are for the eye;
 *  the same counts are a list for a screen reader (and the hover text is no one's only way to a figure). */
function Bars({ values, labels, label }: { values: readonly number[]; labels: readonly string[]; label: string }) {
  const top = Math.max(1, ...values);
  return (
    <>
      <div className="flex h-24 items-end gap-1" aria-hidden="true">
        {values.map((n, i) => (
          <div key={labels[i]} className="flex h-full min-w-0 flex-1 flex-col justify-end gap-1" title={`${labels[i]}: ${n.toLocaleString("en-US")}`}>
            <div className={cn("w-full", n > 0 ? "bg-primary" : "bg-muted")} style={{ height: `${n > 0 ? Math.max(4, (n / top) * 100) : 2}%` }} />
          </div>
        ))}
      </div>
      <ul className="sr-only" aria-label={label}>
        {values.map((n, i) => <li key={labels[i]}>{labels[i]}: {n.toLocaleString("en-US")}</li>)}
      </ul>
    </>
  );
}

/** One share of a total: a name, its figure and a bar. */
function Share({ name, figure, part, of, children }: { name: string; figure: string; part: number; of: number; children?: React.ReactNode }) {
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1">
      <span className="truncate font-mono text-body">{name}</span>
      <span className="font-mono text-body tabular-nums text-muted-foreground">{figure}</span>
      <div className="col-span-2 h-1 bg-muted"><div className="h-full bg-primary" style={{ width: `${of > 0 ? Math.max(1, (part / of) * 100) : 0}%` }} /></div>
      {children}
    </li>
  );
}

/** problem()'s words, with a refusal's own: the server names why it will not read this machine's files (a public URL, more
 *  than one caller, a Postgres store, the API-only profile), and no sign-in changes that. */
function wrappedProblem(e: unknown): Problem {
  const said = problem(e, "your year");
  if (!(e instanceof ClientError) || e.status !== 403) return said;
  return { ...said, why: e.message, next: "Wrapped reads this machine's own session files, so it opens only on one owner's server started here, at the address it printed.", said: undefined };
}

/** A model's price, by its own requests: whole, the priced part of them, or none known. */
const priceOf = (m: Wrapped["models"][number]) => (m.unpriced_requests >= m.requests && m.requests > 0 ? "no known price" : `${dollars(m.cost_usd)}${m.unpriced_requests > 0 ? " priced only" : ""}`);
/** Whether none of a year's (or a row's) requests had its tokens recorded: its tokens are unknown, never 0. */
/** The harnesses whose sessions never record tokens (Cursor's chat store keeps none). */
const NO_TOKENS: ReadonlySet<string> = new Set(["cursor"]);
const unrecorded = (r: { requests: number; tokens_unknown_requests: number }) => r.requests > 0 && r.tokens_unknown_requests >= r.requests;
/** A harness's or model's tokens: compact, or not recorded when none of its requests' were. */
const tokensOf = (r: { requests: number; tokens: number; tokens_unknown_requests: number }) => (unrecorded(r) ? "tokens not recorded" : compact(r.tokens));
const hours = (ms: number) => `${(ms / 3_600_000).toFixed(1)} h`;
const monthOf = (day: string) => Number(day.slice(5, 7)) - 1;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Wrapped: a year of the work under this machine's session files, as the server counted it (GET /v2/wrapped). Numbers
 *  and names only; each section is plain, and a year with nothing in it says so. */
export function WrappedPage({ v2, year, go, cards = wrappedCards }: { v2: Client; year?: number; go: (hash: string) => void; cards?: CardRenderer }) {
  const now = new Date().getFullYear();
  const shown = year ?? now;
  const [data, setData] = useState<Wrapped | null>(null);
  const [error, setError] = useState<Problem | null>(null);
  const [tries, setTries] = useState(0);
  const [leakShown, setLeakShown] = useState(false);
  useEffect(() => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    setData(null);
    setError(null);
    // The leak receipt is asked for again in each year: turned on for one, it is off in the next.
    setLeakShown(false);
    const ask = () => v2.wrapped(shown, abort.signal).then(setData, (e: unknown) => {
      if (abort.signal.aborted) return;
      // A long home: the server goes on reading and says when to ask again. The skeleton stays until the year comes.
      if (e instanceof ClientError && e.status === 503) return void (timer = setTimeout(ask, e.retryAfterMs ?? 5_000));
      setError(wrappedProblem(e));
    });
    void ask();
    return () => { abort.abort(); clearTimeout(timer); };
  }, [v2, shown, tries]);
  const to = (y: number) => go(`#/wrapped?year=${y}`);

  const total = data ? data.tokens.input + data.tokens.output + data.tokens.cache_read + data.tokens.cache_write : 0;
  const months = data ? MONTHS.map((_, m) => data.days.filter((d) => monthOf(d.day) === m).reduce((n, d) => n + d.tokens, 0)) : [];
  const noTokens = data ? unrecorded(data) : false;
  // The busiest day by tokens, or by requests in a year whose tokens were not recorded.
  const weight = (d: Wrapped["days"][number]) => (noTokens ? d.requests : d.tokens);
  const busiest = data?.days.reduce<Wrapped["days"][number] | null>((best, d) => (!best || weight(d) > weight(best) ? d : best), null) ?? null;
  // The harnesses none of whose requests' tokens were recorded, by name: one that never records them ("Cursor doesn't
  // record tokens"), and one that does but recorded none this year (only aborted requests), said apart.
  const silent = data ? data.harnesses.filter((h) => unrecorded(h) && NO_TOKENS.has(h.harness)).map((h) => harnessLabel(h.harness)) : [];
  const none = data ? data.harnesses.filter((h) => unrecorded(h) && !NO_TOKENS.has(h.harness)).map((h) => `${harnessLabel(h.harness)}'s`) : [];
  const modelTokens = data ? data.models.reduce((n, m) => n + m.tokens, 0) : 0;
  const harnessTokens = data ? data.harnesses.reduce((n, h) => n + h.tokens, 0) : 0;

  const drawn = data ? WRAPPED_CARDS.map((card) => ({ card, node: cards(card, data, leakShown) })).filter((c) => c.node !== null && c.node !== undefined && c.node !== false) : [];
  // The leak receipt is off until the person turns it on, and offered only for a year whose keys the import counted
  // (the store's count: a year whose session files are gone keeps it).
  const offersLeak = Boolean(data?.secrets);
  const shownCards = (drawn.length > 0 || offersLeak) && (
    <section className={card} aria-labelledby="w-cards" data-cards>
      <h2 id="w-cards" className={heading}>Cards</h2>
      {offersLeak && (
        <div className="mt-2" data-leak-opt-in>
          <Checkbox checked={leakShown} onChange={(e) => setLeakShown(e.target.checked)} label="Show the leak receipt" note="How many keys and tokens the import cut: counts only." />
        </div>
      )}
      <div className="mt-3 grid gap-4 md:grid-cols-2">{drawn.map(({ card: c, node }) => <div key={c.id}>{node}</div>)}</div>
    </section>
  );
  const unread = data && data.unread_files > 0 && (
    <p className="border border-warning bg-card p-3 font-sans text-small text-warning-text" role="status" data-unread>
      {data.unread_files.toLocaleString("en-US")} session {data.unread_files === 1 ? "file" : "files"} could not be read, so these numbers may be incomplete.
    </p>
  );
  // Every source seen on either side: a session file moved or deleted after its import leaves runs with no session read.
  const sources = data ? [...new Set([...data.sources.map((s) => s.source), ...data.imported.map((i) => i.source)])] : [];
  const importedSection = data && sources.length > 0 && (
    <section className={card} aria-labelledby="w-imported">
      <h2 id="w-imported" className={heading}>Imported</h2>
      <ul className="mt-3 grid gap-2">
        {sources.map((source) => {
          const read = data.sources.find((s) => s.source === source);
          const runs = data.imported.find((i) => i.source === source)?.runs ?? 0;
          return (
            <li key={source} className="flex flex-wrap items-baseline justify-between gap-2 font-mono text-body">
              <span>{source}: {read ? `${read.sessions.toLocaleString("en-US")} sessions read` : "no session files read in this year"}</span>
              {runs > 0
                ? <a className="underline underline-offset-2 hover:text-foreground" href={`#/runs?source=${encodeURIComponent(source)}`}>{runs.toLocaleString("en-US")} imported as runs</a>
                : <span className="text-muted-foreground">none imported as runs yet</span>}
            </li>
          );
        })}
      </ul>
      <p className="mt-3 font-sans text-small text-muted-foreground">To open sessions here as runs, import them with <span className="font-mono">agentrun-serve import</span> or from Setup.</p>
    </section>
  );

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
          : data.requests === 0 ? (
            <div className="mx-auto grid max-w-4xl gap-4 p-5 md:p-6">
              {unread}
              <p className="font-sans text-body text-muted-foreground" role="status">No {data.unread_files > 0 ? "readable " : ""}coding agent sessions under this machine's home in {shown}.</p>
              {importedSection}
              {shownCards}
            </div>
          )
          : (
            <div className="mx-auto grid max-w-4xl gap-4 p-5 md:p-6">
              {unread}
              <p className="font-sans text-small text-muted-foreground">Read on this machine from its own session files. Nothing leaves it: no prompt, title, path or project is in what the page shows.</p>
              <section className={card} aria-labelledby="w-year">
                <h2 id="w-year" className={heading}>Your year in tokens</h2>
                <p className="mt-2 font-mono text-figure font-semibold tabular-nums">{noTokens ? "Tokens not recorded" : `${compact(total)} tokens`}</p>
                {silent.length > 0 && <p className="mt-1 font-sans text-body text-muted-foreground">{silent.join(" and ")} {silent.length === 1 ? "doesn't" : "don't"} record tokens, so {silent.length === 1 ? "its" : "their"} requests count here without them.</p>}
                {none.length > 0 && <p className="mt-1 font-sans text-body text-muted-foreground">No tokens were recorded for {none.join(" and ")} requests this year, so they count here without them.</p>}
                <p className="mt-1 font-mono text-body text-muted-foreground">
                  {data.sessions.toLocaleString("en-US")} sessions · {data.turns.toLocaleString("en-US")} prompts · {data.requests.toLocaleString("en-US")} model requests · {data.unpriced_requests >= data.requests && data.requests > 0 ? "no known price" : dollars(data.cost_usd)}
                  {data.unpriced_requests > 0 && data.unpriced_requests < data.requests ? ` + ${data.unpriced_requests.toLocaleString("en-US")} requests with no known price` : ""}
                </p>
                {!noTokens && (
                  <>
                    <p className="mt-1 font-mono text-body text-muted-foreground">
                      {compact(data.tokens.input)} in · {compact(data.tokens.output)} out · {compact(data.tokens.cache_read)} cache read · {compact(data.tokens.cache_write)} cache write
                      {data.tokens_unknown_requests > 0 ? ` + ${data.tokens_unknown_requests.toLocaleString("en-US")} requests with no recorded tokens` : ""}
                    </p>
                    <div className="mt-4"><Bars values={months} labels={MONTHS} label="Tokens by month" /></div>
                    <div className="mt-1 flex gap-1 font-mono text-micro text-muted-foreground">{MONTHS.map((m) => <span key={m} className="flex-1 text-center">{m}</span>)}</div>
                  </>
                )}
                {busiest && <p className="mt-3 font-mono text-body text-muted-foreground">Busiest day: {busiest.day}, {noTokens ? `${busiest.requests.toLocaleString("en-US")} requests` : `${compact(busiest.tokens)} tokens`} across {data.days.length} days at work.</p>}
              </section>
              <section className={card} aria-labelledby="w-who">
                <h2 id="w-who" className={heading}>Harnesses and models</h2>
                <div className="mt-3 grid gap-6 md:grid-cols-2">
                  <ul className="grid content-start gap-3" aria-label="Harnesses">
                    {data.harnesses.map((h) => (
                      <Share key={h.harness} name={harnessLabel(h.harness)} figure={`${tokensOf(h)} · ${h.sessions} sessions`} part={h.tokens} of={harnessTokens}>
                        <p className="col-span-2 flex flex-wrap gap-x-3 font-mono text-small text-muted-foreground">
                          {h.sources.map((source) => {
                            const runs = data.imported.find((i) => i.source === source)?.runs ?? 0;
                            return runs > 0
                              ? <a key={source} className="underline underline-offset-2 hover:text-foreground" href={`#/runs?source=${encodeURIComponent(source)}`}>{source}: {runs.toLocaleString("en-US")} runs</a>
                              : <span key={source}>{source}: not imported yet · <span className="text-foreground">agentrun-serve import</span></span>;
                          })}
                        </p>
                      </Share>
                    ))}
                  </ul>
                  <ul className="grid content-start gap-3" aria-label="Models">
                    {data.models.map((m) => <Share key={m.model} name={m.model} figure={`${tokensOf(m)} · ${priceOf(m)}`} part={m.tokens} of={modelTokens} />)}
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
              {importedSection}
              {shownCards}
            </div>
          )}
      </div>
    </section>
  );
}
