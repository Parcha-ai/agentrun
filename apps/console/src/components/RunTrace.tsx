import { ArrowDown, Download, Maximize2, Search, X, ZoomIn, ZoomOut } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Banner } from "@/components/ui/banner";
import { Button } from "@/components/ui/button";
import { Chip, type ChipTone } from "@/components/ui/chip";
import { fieldBoxClass, Input } from "@/components/ui/field";
import { Segmented } from "@/components/ui/segmented";
import { Spinner } from "@/components/ui/spinner";
import { tabPanelProps, Tabs } from "@/components/ui/tabs";
import { bytes, compact, isEstimate, runEnded, soFar } from "@/lib/format";
import { type Bar, byModel, byTool, cacheShare, costSplit, duration, findings, inputTokens, keeps, lane, offset, ordered, percent, type SpanKind, type SpanSort, type Spend, spanMs, ticks, traceTotals, traceWindow, usd as dollars } from "@/lib/trace";
import { cn } from "@/lib/utils";
import type { Run, RunTrace as Trace, TraceSpan } from "@/lib/v2";

/** A run's trace (GET /v2/runs/{id}/trace), read when its tab opens and again each time `version` moves (the run's
 *  rows, its status, its end). One read is out at a time and none is dropped: a move while one is out, or within half a
 *  second of the last, is one more read half a second after, so a run that moves faster than a read answers still shows
 *  each read as it lands. A read that fails is the tab's error only while there is nothing to show; `retry` reads at once. */
export function useRunTrace(read: (() => Promise<Trace>) | undefined, version: string): { trace: Trace | null; error: unknown; retry: () => void } {
  const [trace, setTrace] = useState<Trace | null>(null);
  const [error, setError] = useState<unknown>(null);
  const reader = useRef(read);
  reader.current = read;
  // `out`: a read is out. `again`: the run moved since that read began. `timer`: the next read, waiting its half second.
  const state = useRef<{ mounted: boolean; out: boolean; again: boolean; timer: ReturnType<typeof setTimeout> | undefined; seen: string | null }>({ mounted: false, out: false, again: false, timer: undefined, seen: null });
  const go = useRef(() => {});
  go.current = () => {
    const s = state.current;
    clearTimeout(s.timer);
    s.timer = undefined;
    if (!reader.current || !s.mounted) return;
    if (s.out) { s.again = true; return; }
    s.out = true;
    s.again = false;
    Promise.resolve().then(reader.current).then(
      (got) => { if (s.mounted) { setTrace(got); setError(null); } },
      (failed) => { if (s.mounted) setError(failed); },
    ).finally(() => {
      s.out = false;
      if (s.again && s.mounted) s.timer = setTimeout(() => go.current(), 500);
    });
  };
  useEffect(() => {
    const s = state.current;
    s.mounted = true;
    return () => { s.mounted = false; clearTimeout(s.timer); s.timer = undefined; };
  }, []);
  useEffect(() => {
    const s = state.current;
    // The first read goes at once; a move after it waits half a second, and one that finds a read waiting adds none.
    if (s.seen === null) go.current();
    else if (s.out) s.again = true;
    else if (s.timer === undefined) s.timer = setTimeout(() => go.current(), 500);
    s.seen = version;
  }, [version]);
  return { trace, error: trace ? null : error, retry: () => go.current() };
}

/** The time a span still going is drawn to: the clock, read each second while `ticking` (a span runs or waits, however
 *  the run's status reads: a run that waits on an approval is not working, and its held call still waits). `fixed`: a
 *  story's or a test's own moment. */
function useNow(ticking: boolean, fixed?: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking || fixed !== undefined) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ticking, fixed]);
  return fixed ?? now;
}

const STATUS: Record<TraceSpan["status"], { tone: ChipTone; word: string }> = {
  ok: { tone: "success", word: "OK" }, failed: { tone: "error", word: "Failed" }, refused: { tone: "muted", word: "Refused" },
  interrupted: { tone: "muted", word: "Interrupted" }, waiting: { tone: "warning", word: "Waiting" }, running: { tone: "active", word: "Running" },
};
/** A call that waits for a person: hollow, so it is told from one that runs by more than its hue. */
const WAITING = "border border-warning bg-warning/20";
/** A span's mark: its kind's colour, unless how it ended says more (failed, still going, waiting, never ran). */
const mark = (span: TraceSpan) =>
  span.status === "failed" ? "bg-destructive" : span.status === "running" ? "bg-run-active" : span.status === "waiting" ? WAITING
    : span.status !== "ok" ? "bg-muted-foreground" : span.kind === "model" ? "bg-trace-model" : "bg-trace-tool";
const KIND_WORD = { model: "Model", tool: "Tool" } as const;

/** A sum of dollars with what is not known said: "$0.0120", "$0.0120 + 2 unknown", "Unknown". */
const spendWords = (s: Spend) => (s.unknown === 0 ? dollars(s.usd) : s.usd > 0 ? `${dollars(s.usd)} + ${s.unknown} unknown` : "Unknown");
/** What a span cost, in the table's and the panel's words: a request's cost, a call's charges, or why there is none. */
function costWords(span: TraceSpan, trace: Pick<Trace, "model_requests">): string {
  // A workflow's model node's request carries no cost by design (the run's is its booking's); a decision's is its own.
  if (span.kind === "model") return span.usd !== null ? dollars(span.usd) : trace.model_requests === "tokens_only" && !span.decision ? "–" : "Unknown";
  if (span.charged) return span.usd !== null ? dollars(span.usd) : "Unknown";
  return span.not_metered ? "Not metered" : "–";
}
const sizeWords = (span: TraceSpan) =>
  span.tokens ? `${compact(inputTokens(span.tokens))} in · ${compact(span.tokens.output)} out` : span.result_size_bytes !== null ? bytes(span.result_size_bytes) : "–";
const clockMs = (iso: string) => new Date(iso).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit", fractionalSecondDigits: 3 });
const said = (error: unknown) => (error instanceof Error && error.message ? error.message : "The server gave no reason.");

function Tile({ label, value, note, tone }: { label: string; value: string | number; note: ReactNode; tone?: "bad" }) {
  return (
    <div className="min-w-0 border-b border-r p-3">
      <p className="caps text-label text-muted-foreground">{label}</p>
      {/* A figure in words (a cost known so far) is longer than a number: a step smaller, so it fits its tile. */}
      <p title={String(value)} className={cn("mt-0.5 truncate font-mono font-semibold", String(value).length > 11 ? "text-lg leading-8" : "text-figure", tone === "bad" && "text-destructive-text")}>{value}</p>
      <p className="mt-0.5 truncate text-small text-muted-foreground" title={typeof note === "string" ? note : undefined}>{note}</p>
    </div>
  );
}

const Heading = ({ children, aside }: { children: ReactNode; aside?: ReactNode }) => (
  <div className="mb-2 flex items-baseline justify-between gap-3">
    <h3 className="caps text-small font-semibold">{children}</h3>
    {aside && <span className="font-mono text-small text-muted-foreground">{aside}</span>}
  </div>
);
const Swatch = ({ className }: { className: string }) => <span aria-hidden className={cn("inline-block size-2 shrink-0", className)} />;

/** One lane of the time axis: its bars on as many rows as overlap, over the axis's marks. Each bar is pressed to open
 *  its span; the lanes are one stop for the keyboard, and the arrows move from span to span (`tab`: the one that takes
 *  the focus). */
function Lane({ title, swatch, bars, rows, marks, selected, dimmed, tab, refs, onPick, at }: {
  title: string; swatch: string; bars: Bar[]; rows: number; marks: { left: number }[]; selected: string | null; dimmed: (span: TraceSpan) => boolean;
  tab: string | null; refs: React.MutableRefObject<Map<string, HTMLButtonElement>>; onPick: (id: string) => void; at: (span: TraceSpan) => string;
}) {
  return (
    <div className="mt-3 first:mt-0">
      <p className="caps flex items-center gap-1.5 text-micro text-muted-foreground"><Swatch className={swatch} />{title}</p>
      <div className="relative mt-1.5" style={{ height: rows * 20 - 6 }}>
        {marks.map((m) => <span key={m.left} aria-hidden className="absolute inset-y-0 w-px bg-border" style={{ left: `${m.left}%` }} />)}
        {bars.map(({ span, left, width, row }) => (
          <button key={span.id} type="button" ref={(el) => { if (el) refs.current.set(span.id, el); else refs.current.delete(span.id); }}
            tabIndex={span.id === tab ? 0 : -1} aria-pressed={span.id === selected} aria-label={at(span)} title={at(span)} onClick={() => onPick(span.id)}
            style={{ left: `${left}%`, width: `${width}%`, top: row * 20 }}
            className={cn("absolute h-3.5 min-w-1 transition-opacity hover:opacity-80", mark(span), dimmed(span) && "opacity-25", span.id === selected && "ring-2 ring-foreground ring-offset-1 ring-offset-card")} />
        ))}
      </div>
    </div>
  );
}

/** The panel of one span: what it cost and used, when it ran, what called it and what it called, and a call's arguments
 *  and the head of its output. */
function SpanPanel({ span, trace, run, from, now, reveal, onPick, onClose }: { span: TraceSpan; trace: Trace; run: Run; from: number; now: number; reveal: boolean; onPick: (id: string) => void; onClose: () => void }) {
  const [text, setText] = useState<"input" | "output">("input");
  // The text shown, copied: the button says so for a moment. A browser that refuses the clipboard leaves it as it was.
  const [copied, setCopied] = useState(false);
  useEffect(() => { if (!copied) return; const timer = setTimeout(() => setCopied(false), 1500); return () => clearTimeout(timer); }, [copied]);
  const copy = (words: string) => { void navigator.clipboard?.writeText(words).then(() => setCopied(true), () => {}); };
  // Under the table on a narrow screen, the panel comes into view when a row opens it (`reveal`); beside the table on a
  // wide one it is there already. A span opened from the time axis stays where the keyboard is: the axis keeps the view.
  const panel = useRef<HTMLElement>(null);
  useEffect(() => { if (reveal && panel.current && panel.current.getBoundingClientRect().top > globalThis.innerHeight - 80) panel.current.scrollIntoView?.({ block: "start" }); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const ms = spanMs(span, now);
  const shownText = text === "input" ? span.input_preview : span.result_preview;
  const parent = span.parent_id ? trace.spans.find((s) => s.id === span.parent_id) : undefined;
  const made = trace.spans.filter((s) => s.parent_id === span.id);
  const t = span.tokens;
  const share = t ? cacheShare(t) : null;
  const runUsd = run.cost?.usd;
  const ofRun = span.usd !== null && typeof runUsd === "number" && runUsd > 0 ? `${percent(Math.min(1, span.usd / runUsd))} of the run` : null;
  const perSecond = t && span.ended_at && ms ? Math.round(t.output / (ms / 1000)) : null;
  const lines = t ? ([["Input, not cached", t.input, "bg-muted-foreground"], ["Cache read", t.cache_read, "bg-trace-model/40"], ["Cache write", t.cache_write, "bg-trace-model/70"], ["Output", t.output, "bg-trace-model"]] as const) : [];
  const all = t ? inputTokens(t) + t.output : 0;
  const facts: [string, ReactNode][] = [
    [span.kind === "model" ? "Model" : "Tool", span.name],
    ...(span.agent_label ? [["Subagent", span.agent_label] as [string, ReactNode]] : []),
    ...(span.stop_reason ? [["Stop reason", span.stop_reason] as [string, ReactNode]] : []),
    ["Started", `${clockMs(span.started_at)} · ${offset(Date.parse(span.started_at) - from)}`],
    ["Ended", span.ended_at ? clockMs(span.ended_at) : span.status === "running" ? "Still running" : span.status === "waiting" ? "Waiting for a person" : "Not recorded"],
    ...(perSecond !== null && t && t.output > 0 ? [["Output speed", `${perSecond.toLocaleString("en-US")} tokens/s`] as [string, ReactNode]] : []),
    ...(t?.reasoning !== undefined ? [["Thinking tokens", `${t.reasoning.toLocaleString("en-US")} of the output`] as [string, ReactNode]] : []),
    ...(span.tool_use_id ? [["Call id", span.tool_use_id] as [string, ReactNode]] : []),
    ["Span", span.id],
  ];
  return (
    <aside ref={panel} aria-label="Call details" onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } }} className="relative border-t bg-card p-5 xl:w-2/5 xl:max-w-lg xl:shrink-0 xl:overflow-auto xl:border-l xl:border-t-0">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Chip><Swatch className={span.kind === "model" ? "bg-trace-model" : "bg-trace-tool"} />{span.decision ? "Decision" : span.kind === "model" ? "Model request" : "Tool call"}</Chip>
            <Chip tone={STATUS[span.status].tone}>{STATUS[span.status].word}</Chip>
          </div>
          <h2 className="mt-2 break-words font-mono text-lead font-semibold">{span.name}</h2>
        </div>
        <Button size="icon" variant="ghost" aria-label="Close call details" onClick={onClose}><X aria-hidden /></Button>
      </div>

      <dl className="mt-4 grid grid-cols-3 border-l border-t">
        {([
          ["Duration", ms !== null ? duration(ms) : "–", span.ended_at ? null : ms !== null ? "so far" : "not recorded"],
          [span.kind === "model" ? "Cost" : "Charged", costWords(span, trace), ofRun],
          span.kind === "model" ? ["Tokens", t ? compact(all) : "–", t ? `${compact(inputTokens(t))} in · ${compact(t.output)} out` : "none reported"] : ["Result", span.result_size_bytes !== null ? bytes(span.result_size_bytes) : "–", null],
        ] as const).map(([label, value, note]) => (
          <div key={label} className="min-w-0 border-b border-r p-2.5">
            <dt className="caps text-micro text-muted-foreground">{label}</dt>
            <dd className="mt-0.5 truncate font-mono text-base font-semibold">{value}</dd>
            {note && <dd className="truncate text-label text-muted-foreground" title={note}>{note}</dd>}
          </div>
        ))}
      </dl>

      {span.kind === "model" && (
        <section className="mt-5" aria-label="Tokens">
          <Heading aside={share !== null ? `${percent(share)} of input from cache` : undefined}>Tokens</Heading>
          {t ? (
            <>
              <div className="flex h-2.5 bg-accent" role="img" aria-label={lines.map(([label, n]) => `${label}: ${n.toLocaleString("en-US")} tokens`).join(", ")}>
                {lines.filter(([, n]) => n > 0).map(([label, n, tone]) => <span key={label} title={`${label}: ${n.toLocaleString("en-US")}`} className={cn("min-w-0.5 border-r border-card last:border-r-0", tone)} style={{ width: `${(n / all) * 100}%` }} />)}
              </div>
              <table className="mt-2 w-full text-small">
                <thead><tr className="caps border-b text-micro text-muted-foreground"><th className="py-1.5 text-left font-normal">Line</th><th className="py-1.5 text-right font-normal">Tokens</th><th className="py-1.5 pl-3 text-right font-normal">Of input</th></tr></thead>
                <tbody>
                  {lines.map(([label, n, tone]) => (
                    <tr key={label} className="border-b">
                      <th scope="row" className="whitespace-nowrap py-1.5 text-left text-body font-normal"><span className="flex items-center gap-2"><Swatch className={tone} />{label}</span></th>
                      <td className="py-1.5 text-right font-mono">{n.toLocaleString("en-US")}</td>
                      <td className="py-1.5 pl-3 text-right font-mono text-muted-foreground">{label !== "Output" && inputTokens(t) > 0 ? percent(n / inputTokens(t)) : "–"}</td>
                    </tr>
                  ))}
                  <tr className="font-semibold"><th scope="row" className="py-1.5 text-left text-body font-semibold">This request</th><td className="py-1.5 text-right font-mono">{all.toLocaleString("en-US")}</td><td className="py-1.5 pl-3 text-right font-mono">{costWords(span, trace)}</td></tr>
                </tbody>
              </table>
            </>
          ) : <p className="text-body text-muted-foreground">This request reported no tokens{span.status === "interrupted" ? ": it was cut before its end" : ""}.</p>}
          <p className="mt-2 text-small text-muted-foreground">
            {span.usd !== null ? "The cost is what the run recorded for this request: one figure for all its tokens."
              : trace.model_requests === "tokens_only" && !span.decision ? "This run's cost is booked for the whole run, so this request carries tokens only."
              : span.decision ? "This decision's cost is unknown: its receipt keeps none."
              : "This request's cost is unknown: it was cut before its end, or its model has no price here."}
          </p>
        </section>
      )}

      {span.kind === "tool" && (
        <section className="mt-5" aria-label="Cost">
          <Heading>Cost</Heading>
          <p className="text-body text-muted-foreground">
            {span.charged ? `${span.usd !== null ? dollars(span.usd) : "An unknown amount"} was charged under this call, and is in the run's cost.`
              : span.not_metered ? "This tool has no price set, so the call ran outside the run's cost."
              : "Nothing was charged under this call."}
            {run.computer ? " Time on the run's computer is billed by its provider and is not metered here." : ""}
          </p>
        </section>
      )}

      <section className="mt-5" aria-label="Details">
        <Heading>Details</Heading>
        <dl>
          {parent && (
            <div className="flex items-center justify-between gap-4 border-b py-1.5">
              <dt className="shrink-0 text-body text-muted-foreground">{span.kind === "model" ? "Started by" : "Called by"}</dt>
              <dd className="min-w-0"><button type="button" className="-my-1 max-w-full truncate py-1 font-mono text-small underline underline-offset-2 hover:text-primary-text" onClick={() => onPick(parent.id)}>{parent.name} · {offset(Date.parse(parent.started_at) - from)}</button></dd>
            </div>
          )}
          {facts.map(([label, value]) => (
            <div key={label} className="flex justify-between gap-4 border-b py-1.5">
              <dt className="shrink-0 text-body text-muted-foreground">{label}</dt>
              <dd className="min-w-0 break-words text-right font-mono text-small">{value}</dd>
            </div>
          ))}
        </dl>
      </section>

      {made.length > 0 && (
        <section className="mt-5" aria-label={span.kind === "model" ? "Calls it made" : "What ran under it"}>
          <Heading aside={String(made.length)}>{span.kind === "model" ? "Calls it made" : "What ran under it"}</Heading>
          <ul>
            {made.slice(0, 12).map((child) => (
              <li key={child.id} className="border-b">
                <button type="button" className="flex w-full items-center gap-2 py-1.5 text-left font-mono text-small hover:bg-accent" onClick={() => onPick(child.id)}>
                  <Swatch className={mark(child)} /><span className="min-w-0 flex-1 truncate">{child.name}</span>
                  <span className="shrink-0 text-muted-foreground">{spanMs(child, now) !== null ? duration(spanMs(child, now)!) : STATUS[child.status].word}</span>
                </button>
              </li>
            ))}
          </ul>
          {made.length > 12 && <p className="mt-1.5 text-small text-muted-foreground">And {made.length - 12} more: filter the table by name to find them.</p>}
        </section>
      )}

      {span.kind === "tool" && (
        <section className="mt-5" aria-label="Arguments and result">
          <Tabs id="span-text" label="Arguments and result" className="px-0 md:px-0" value={text} onChange={setText} tabs={[{ id: "input", label: "Arguments" }, { id: "output", label: "Result" }]} />
          <div {...tabPanelProps("span-text", text)}>
            {shownText
              ? <pre tabIndex={0} role="region" aria-label={text === "input" ? "The call's arguments" : "The head of the call's result"} className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap break-words border bg-background p-3 font-mono text-small">{shownText}</pre>
              : <p className="mt-3 text-body text-muted-foreground">{text === "input" ? "The call took no arguments." : span.status === "running" || span.status === "waiting" ? "No result yet." : "The call returned nothing to show."}</p>}
            <div className="mt-2 flex items-start justify-between gap-3">
              <p className="text-small text-muted-foreground">The Timeline's own cut of the call: its head, with secrets removed.{text === "output" && span.result_size_bytes !== null ? ` The whole result was ${bytes(span.result_size_bytes)}.` : ""}</p>
              {shownText && <Button size="xs" variant="ghost" className="shrink-0" onClick={() => copy(shownText)}>{copied ? "Copied" : "Copy"}</Button>}
            </div>
          </div>
        </section>
      )}
    </aside>
  );
}

/** A model's mark where the cost is split by model: the first the full colour, each next one a step lighter. */
const MODEL_TONES = ["bg-trace-model", "bg-trace-model/70", "bg-trace-model/40"];

/** A stacked bar of parts that add up to a whole, with each part named under it: its word, its figure and its share. */
function Split({ label, parts, whole, say }: { label: string; parts: readonly { word: string; tone: string; n: number }[]; whole: number; say: (n: number) => string }) {
  const some = parts.filter((part) => part.n > 0);
  return (
    <>
      <div className="flex h-3 bg-accent" role="img" aria-label={`${label}: ${some.map((part) => `${part.word} ${say(part.n)}`).join(", ")}`}>
        {some.map((part) => <span key={part.word} className={cn("min-w-0.5 border-r border-card last:border-r-0", part.tone)} style={{ width: `${(part.n / Math.max(whole, Number.MIN_VALUE)) * 100}%` }} />)}
      </div>
      <ul className="mt-3 flex flex-wrap gap-x-6 gap-y-1.5 text-small">
        {some.map((part) => <li key={part.word} className="flex items-center gap-2"><Swatch className={part.tone} />{part.word}<span className="font-mono text-muted-foreground">{say(part.n)} · {percent(whole > 0 ? part.n / whole : 0)}</span></li>)}
      </ul>
    </>
  );
}

/** The run's requests and calls added up: what stands out, where the time and the cost went, each request's input and
 *  cost in the order they ran, and the same by model and by tool. */
function Breakdown({ trace, now, onPick, selected }: { trace: Trace; now: number; onPick: (id: string) => void; selected: string | null }) {
  const totals = useMemo(() => traceTotals(trace, now), [trace, now]);
  const tools = useMemo(() => byTool(trace.spans, now), [trace, now]);
  const models = useMemo(() => byModel(trace.spans, trace.model_requests === "priced"), [trace]);
  const found = useMemo(() => findings(trace, now), [trace, now]);
  const split = useMemo(() => costSplit(trace.spans), [trace]);
  const [chart, setChart] = useState<"input" | "cost">("input");
  const requests = trace.spans.filter((s) => s.kind === "model" && s.tokens);
  const priced = requests.some((s) => s.usd !== null);
  const shown = chart === "cost" && priced ? "cost" : "input";
  // The tallest bar's figure; 0 when every request's is (a free model's cost): the bars are then drawn at their least.
  const most = Math.max(0, ...requests.map((s) => (shown === "cost" ? s.usd ?? 0 : inputTokens(s.tokens!))));
  const toolMs = Math.max(1, ...tools.map((row) => row.totalMs));
  const th = "caps whitespace-nowrap px-3 py-2 text-right text-label font-normal text-muted-foreground first:text-left";
  const td = "whitespace-nowrap px-3 py-2 text-right font-mono";
  return (
    <div className="space-y-6">
      {found.length > 0 && (
        <section aria-label="What stands out">
          <Heading>What stands out</Heading>
          <ul className="grid border-l border-t sm:grid-cols-2 2xl:grid-cols-3">
            {found.map((f) => {
              const body = <><span className={cn("block text-body font-semibold", f.bad && "text-destructive-text")}>{f.title}</span><span className="mt-0.5 block text-small text-muted-foreground">{f.detail}</span></>;
              return (
                <li key={f.id} className="border-b border-r bg-card">
                  {f.span ? <button type="button" aria-pressed={f.span === selected} onClick={() => onPick(f.span!)} className={cn("block h-full w-full p-3 text-left -outline-offset-2 hover:bg-accent", f.span === selected && "bg-accent")}>{body}</button> : <div className="p-3">{body}</div>}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <div className="grid gap-6 2xl:grid-cols-2">
        <section aria-label="Where the time went" className="border bg-card p-4">
          <Heading aside={duration(totals.time.wall)}>Where the time went</Heading>
          <Split label="Where the time went" whole={totals.time.wall} say={duration} parts={[{ word: "A model answering", tone: "bg-trace-model", n: totals.time.model }, { word: "A tool running", tone: "bg-trace-tool", n: totals.time.tools }, { word: "Neither", tone: "bg-border-strong", n: totals.time.other }]} />
          <p className="mt-2 max-w-prose text-small text-muted-foreground">Each moment is counted once. "Neither" is the time between calls: the run waiting for a person or its turn, or its harness working.</p>
        </section>
        <section aria-label="Where the cost went" className="border bg-card p-4">
          <Heading aside={split ? dollars(split.total) : undefined}>Where the cost went</Heading>
          {split && split.total === 0 ? <p className="text-body text-muted-foreground">Everything this trace knows the cost of was $0.</p>
            : split ? <Split label="Where the cost went" whole={split.total} say={dollars} parts={split.parts.map((part, i) => ({ word: part.name, tone: part.kind === "tool" ? "bg-trace-tool" : MODEL_TONES[Math.min(i, MODEL_TONES.length - 1)]!, n: part.usd }))} />
            : <p className="text-body text-muted-foreground">{trace.model_requests === "priced" ? "Nothing in this trace has a known cost yet." : "This run's cost is booked for the run as a whole: its trace carries no cost for each request."}</p>}
          {split && split.total > 0 && <p className="mt-2 max-w-prose text-small text-muted-foreground">What the trace knows the cost of: each model's requests, and each charge under a call.{totals.cost.requests?.unknown ? ` ${totals.cost.requests.unknown} request${totals.cost.requests.unknown === 1 ? " has" : "s have"} no known cost and ${totals.cost.requests.unknown === 1 ? "is" : "are"} not in it.` : ""}</p>}
        </section>
      </div>

      {requests.length > 0 && (
        <section aria-label="Each request" className="border bg-card p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <h3 className="caps text-small font-semibold">Each request, in the order they ran</h3>
            {priced && <Segmented name="trace-chart" label="What a bar's height is" size="sm" value={shown} onChange={setChart} options={[{ value: "input", label: "Input tokens" }, { value: "cost", label: "Cost" }]} />}
          </div>
          <div className="overflow-x-auto">
            <div className="flex h-32 min-w-full items-end gap-px border-b" role="group" aria-label={shown === "cost" ? "Each request's cost" : "Each request's input tokens"}>
              {requests.map((s) => {
                const t = s.tokens!;
                const n = shown === "cost" ? s.usd ?? 0 : inputTokens(t);
                const parts = shown === "cost" ? null : t;
                const says = shown === "cost" ? `${s.name}: ${s.usd !== null ? dollars(s.usd) : "cost unknown"}` : `${s.name}: ${n.toLocaleString("en-US")} input tokens, ${percent(cacheShare(t) ?? 0)} from cache`;
                return (
                  <button key={s.id} type="button" aria-pressed={s.id === selected} onClick={() => onPick(s.id)} title={says} aria-label={says}
                    className={cn("flex min-w-1 max-w-24 flex-1 flex-col-reverse hover:opacity-80", s.id === selected && "ring-2 ring-foreground ring-offset-1 ring-offset-card")} style={{ height: `${most > 0 ? Math.max(2, (n / most) * 100) : 2}%` }}>
                    {parts ? <><span className="bg-trace-model/40" style={{ flexGrow: parts.cache_read }} /><span className="bg-trace-model/70" style={{ flexGrow: parts.cache_write }} /><span className="bg-muted-foreground" style={{ flexGrow: parts.input }} /></>
                      : <span className="flex-1 bg-trace-model" />}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="mt-2 flex justify-between font-mono text-micro text-muted-foreground"><span>first request</span><span>tallest: {shown === "cost" ? dollars(most) : `${compact(most)} tokens`}</span><span>last request</span></div>
          {shown === "input" && (
            <ul className="mt-3 flex flex-wrap gap-x-6 gap-y-1.5 text-small">
              <li className="flex items-center gap-2"><Swatch className="bg-trace-model/40" />Read from cache</li>
              <li className="flex items-center gap-2"><Swatch className="bg-trace-model/70" />Written to cache</li>
              <li className="flex items-center gap-2"><Swatch className="bg-muted-foreground" />Not cached</li>
            </ul>
          )}
          <p className="mt-2 max-w-prose text-small text-muted-foreground">{shown === "cost" ? "One bar a request: its height is what the run booked for it." : "One bar a request: its height is the input it sent. A run that caches well reads most of each request from cache and writes only what is new."}</p>
        </section>
      )}

      {models.length > 0 && (
        <section aria-label="By model">
          <Heading>By model</Heading>
          <div className="overflow-x-auto border bg-card" tabIndex={0} role="region" aria-label="Requests by model">
            <table className="w-full text-small">
              <thead><tr className="border-b">{["Model", "Requests", "Failed", "Input", "From cache", "Output", "Tokens/s", "Median time", "95th", "Total time", "Cost"].map((h) => <th key={h} scope="col" className={th}>{h}</th>)}</tr></thead>
              <tbody>
                {models.map((m) => (
                  <tr key={m.name} className="border-b last:border-b-0">
                    <th scope="row" className="px-3 py-2 text-left font-mono font-normal">{m.name}</th>
                    <td className={td}>{m.requests}</td><td className={cn(td, m.failed > 0 && "text-destructive-text")}>{m.failed}</td>
                    <td className={td}>{compact(m.tokens.input + m.tokens.cache_read + m.tokens.cache_write)}</td><td className={td}>{m.cache !== null ? percent(m.cache) : "–"}</td>
                    <td className={td}>{compact(m.tokens.output)}</td><td className={td}>{m.perSecond !== null ? Math.round(m.perSecond).toLocaleString("en-US") : "–"}</td>
                    <td className={td}>{m.p50 !== null ? duration(m.p50) : "–"}</td><td className={td}>{m.p95 !== null ? duration(m.p95) : "–"}</td><td className={td}>{duration(m.totalMs)}</td><td className={td}>{m.cost ? spendWords(m.cost) : "–"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {tools.length > 0 && (
        <section aria-label="By tool">
          <Heading aside="the tool that took the most time first">By tool</Heading>
          <div className="overflow-x-auto border bg-card" tabIndex={0} role="region" aria-label="Calls by tool">
            <table className="w-full text-small">
              <thead><tr className="border-b">{["Tool", "Calls", "Failed", "Total time", "Median", "95th", "Longest", "Charged", "Returned"].map((h) => <th key={h} scope="col" className={th}>{h}</th>)}</tr></thead>
              <tbody>
                {tools.map((row) => (
                  <tr key={row.name} className="border-b last:border-b-0">
                    <th scope="row" className="px-3 py-2 text-left font-mono font-normal">{row.name}</th>
                    <td className={td}>{row.calls}</td><td className={cn(td, row.failed > 0 && "text-destructive-text")}>{row.failed}</td>
                    <td className={td}><span className="inline-flex items-center gap-2"><span aria-hidden className="inline-block h-1.5 w-16 bg-accent"><span className="block h-full bg-trace-tool" style={{ width: `${(row.totalMs / toolMs) * 100}%` }} /></span>{duration(row.totalMs)}</span></td>
                    <td className={td}>{row.p50 !== null ? duration(row.p50) : "–"}</td><td className={td}>{row.p95 !== null ? duration(row.p95) : "–"}</td>
                    <td className={td}>{row.maxMs !== null ? duration(row.maxMs) : "–"}</td><td className={td}>{row.charged > 0 ? spendWords(row.charges) : "–"}</td><td className={td}>{bytes(row.bytes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}

const ZOOMS = [1, 2, 4, 8, 16];
/** The most rows the table draws until asked for the rest: a long run's first screenfuls, at once. */
const ROWS = 300;
const SORTS: { id: SpanSort; label: string; right?: boolean }[] = [{ id: "started", label: "Started" }, { id: "duration", label: "Duration", right: true }, { id: "tokens", label: "Size", right: true }, { id: "cost", label: "Cost", right: true }];

/** The run page's Dev tools tab: every model request and tool call of the run on one time axis and in one table, each
 *  opening to what it used and cost; and the run's totals, by tool and by model. `version` moves when the run does (its
 *  rows, its status), so the trace is read again. For a story or a test: `now`, its own clock; `open`, the span open at
 *  first; `view`, the view shown at first. */
export function RunTrace({ run, read, version, live, now: fixed, open = null, view: first = "calls" }: { run: Run; read?: () => Promise<Trace>; version: string; live: boolean; now?: number; open?: string | null; view?: "calls" | "breakdown" }) {
  const { trace, error, retry } = useRunTrace(read, version);
  // A span that still runs or waits is drawn to now, while the run has not ended; once it has, to its end (a span the
  // trace still reads as going on an ended run grows no further).
  const going = !runEnded(run.status) && !!trace?.spans.some((s) => s.status === "running" || s.status === "waiting");
  const clock = useNow(going, fixed);
  const now = fixed ?? (runEnded(run.status) && run.ended_at ? Date.parse(run.ended_at) : clock);
  const [picked, setPicked] = useState<string | null>(open);
  const [view, setView] = useState<"calls" | "breakdown">(first);
  const [kind, setKind] = useState<SpanKind>("all");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SpanSort>("started");
  const [zoom, setZoom] = useState(0);
  const [whole, setWhole] = useState(false);
  const [reveal, setReveal] = useState(false);
  const opener = useRef<HTMLElement | null>(null);
  const refs = useRef(new Map<string, HTMLButtonElement>());
  const rowRefs = useRef(new Map<string, HTMLTableRowElement>());

  const spans = trace?.spans ?? [];
  const window = useMemo(() => traceWindow(spans, now), [spans, now]);
  const totals = useMemo(() => (trace ? traceTotals(trace, now) : null), [trace, now]);
  const lanes = useMemo(() => ({ model: lane(spans.filter((s) => s.kind === "model"), window, now), tool: lane(spans.filter((s) => s.kind === "tool"), window, now) }), [spans, window, now]);
  const marks = useMemo(() => ticks(window.ms, 8 * ZOOMS[zoom]!), [window.ms, zoom]);
  const shown = useMemo(() => ordered(spans.filter((s) => keeps(s, kind, query)), sort, now), [spans, kind, query, sort, now]);
  const depth = useMemo(() => {
    const byId = new Map(spans.map((s) => [s.id, s]));
    const of = (s: TraceSpan, seen = 0): number => (s.parent_id && byId.has(s.parent_id) && seen < 4 ? 1 + of(byId.get(s.parent_id)!, seen + 1) : 0);
    return new Map(spans.map((s) => [s.id, of(s)]));
  }, [spans]);

  if (!read) return null;
  if (!trace) {
    return (
      <div className="px-5 py-8 md:px-8">
        {error ? <Banner tone="error" title="The trace could not be read" actions={<Button size="xs" onClick={retry}>Try again</Button>}><p className="font-mono text-small">{said(error)}</p></Banner>
          : <p className="flex items-center gap-3 font-mono text-body text-muted-foreground"><Spinner />Reading the trace</p>}
      </div>
    );
  }

  const selected = picked ? spans.find((s) => s.id === picked) ?? null : null;
  /** What had the keyboard when the panel opened (a row, a bar, a finding): it gets it back when the panel closes. One
   *  opened from inside the panel (the request that called it) keeps the first. */
  const from = () => { const active = document.activeElement; if (active instanceof HTMLElement && !active.closest("aside")) opener.current = active; };
  /** A span opened from the table, the panel or the breakdown: on a narrow screen its panel comes into view. */
  const pick = (id: string) => { from(); setReveal(true); setPicked(id); };
  /** A span picked on the time axis: its table row comes into view too, and the view stays with the axis. */
  const pickBar = (id: string) => { from(); setReveal(false); setPicked(id); rowRefs.current.get(id)?.scrollIntoView?.({ block: "nearest" }); };
  /** The panel closed: the keyboard goes back to what opened it, never to nowhere. */
  const close = () => {
    setPicked(null);
    if (opener.current?.isConnected) opener.current.focus();
  };
  const inOrder = [...spans].sort((a, b) => Date.parse(a.started_at) - Date.parse(b.started_at));
  const tab = selected?.id ?? inOrder[0]?.id ?? null;
  const say = (span: TraceSpan) => `${KIND_WORD[span.kind]} ${span.name}, ${STATUS[span.status].word.toLowerCase()}, ${spanMs(span, now) !== null ? duration(spanMs(span, now)!) : "no duration"}, at ${offset(Date.parse(span.started_at) - window.from)}`;
  const move = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : e.key === "Home" ? -inOrder.length : e.key === "End" ? inOrder.length : 0;
    if (!step || !inOrder.length) return;
    e.preventDefault();
    const from = Math.max(0, inOrder.findIndex((s) => s.id === tab));
    const next = inOrder[Math.min(inOrder.length - 1, Math.max(0, from + step))]!;
    pickBar(next.id);
    refs.current.get(next.id)?.focus();
    opener.current = refs.current.get(next.id) ?? opener.current;
  };
  const exportJson = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(trace, null, 2)], { type: "application/json" }));
    const link = Object.assign(document.createElement("a"), { href: url, download: `trace-${run.run_id}.json` });
    link.click();
    URL.revokeObjectURL(url);
  };
  // The run's own cost, as its header says it: the trace prices nothing itself. While it is not one figure, what is known so far.
  const runUsd = run.cost?.usd ?? null;
  const known = soFar(run.cost);
  const modelNames = [...new Set(spans.filter((s) => s.kind === "model").map((s) => s.name))];
  const toolNames = new Set(spans.filter((s) => s.kind === "tool").map((s) => s.name));
  const firstFailed = spans.find((s) => s.status === "failed");
  const counts: Record<SpanKind, number> = { all: spans.length, model: totals!.requests, tool: totals!.calls, failed: totals!.failed };
  const share = totals!.tokens ? cacheShare(totals!.tokens) : null;
  // Beside an open panel the table is half as wide: its Size column (the panel says it) shows from the widest screens on.
  const narrow = selected ? "xl:hidden 2xl:table-cell" : "";
  const priced = totals!.cost.requests;

  return (
    // Each pane that scrolls is `relative`: what is placed out of the flow inside it (a Segmented's hidden radios, a
    // spinner's hidden words) is then placed against the pane and scrolls with it. Placed against the page instead, one
    // far down the pane's content made the whole page scroll, with nothing under it.
    <div data-scroll-pane className="relative min-h-0 flex-1 overflow-auto xl:flex xl:overflow-hidden short:flex-none short:overflow-visible">
      <section aria-label="Trace" className="relative min-w-0 space-y-4 px-5 py-6 md:px-8 xl:min-h-0 xl:flex-1 xl:overflow-auto">
        {trace.model_requests === "not_recorded" && (
          <Banner tone="info" title="This run's harness keeps no record of each model request">The trace shows its tool calls. The run's cost and how many requests it made are on its Timeline's usage line.</Banner>
        )}
        {trace.dropped > 0 && <Banner tone="warning">This is the run's first {spans.length.toLocaleString("en-US")} requests and calls. {trace.dropped.toLocaleString("en-US")} later ones are not shown.</Banner>}

        <div className="grid grid-cols-2 border-l border-t bg-card sm:grid-cols-3 2xl:grid-cols-6">
          <Tile label="Model requests" value={trace.model_requests === "not_recorded" ? "–" : totals!.requests} note={trace.model_requests === "not_recorded" ? "Not kept by this harness" : modelNames.length === 1 ? modelNames[0] : modelNames.length ? `${modelNames.length} models` : "None yet"} />
          <Tile label="Tool calls" value={totals!.calls} note={toolNames.size === 1 ? "1 tool" : `${toolNames.size} tools`} />
          <Tile label="Failed" value={totals!.failed} tone={totals!.failed > 0 ? "bad" : undefined} note={firstFailed ? `First: ${firstFailed.name}` : "Nothing failed"} />
          <Tile label="Tokens" value={totals!.tokens ? compact(inputTokens(totals!.tokens) + totals!.tokens.output) : "–"} note={!totals!.tokens ? "No request to count" : `${share !== null ? `${percent(share)} of input read from cache` : "No input reported"}${totals!.untold ? ` · ${totals!.untold} request${totals!.untold === 1 ? "" : "s"} reported none` : ""}`} />
          <Tile label={runUsd === null && known ? "Cost so far" : run.cost && isEstimate(run.cost) ? "Cost, estimated" : "Cost"} value={typeof runUsd === "number" ? dollars(runUsd) : known ? dollars(known.so_far_usd) : "Unknown"} note={priced ? `requests ${spendWords(priced)}${totals!.cost.charged ? ` · tools ${spendWords(totals!.cost.charges)}` : ""}` : totals!.cost.charged ? `tools ${spendWords(totals!.cost.charges)}` : "Booked for the run as a whole"} />
          <Tile label="Time" value={duration(totals!.time.wall)} note={totals!.time.wall > 0 ? `model ${percent(totals!.time.model / totals!.time.wall)} · tools ${percent(totals!.time.tools / totals!.time.wall)}` : "Nothing ran yet"} />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Segmented name="trace-view" label="What the tab shows" size="sm" value={view} onChange={setView} options={[{ value: "calls", label: "Calls" }, { value: "breakdown", label: "Breakdown" }]} />
          {view === "calls" && spans.length > 0 && (
            <>
              <label className={cn(fieldBoxClass, "flex h-control-sm min-w-40 flex-1 items-center gap-2 px-2.5")}>
                <Search className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                <Input bare value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter by tool, model or arguments" aria-label="Filter calls" className="h-full flex-1 text-small" />
              </label>
              <Segmented name="trace-kind" label="Kind of call" size="sm" value={kind} onChange={setKind}
                options={([["all", "All"], ["model", "Model"], ["tool", "Tools"], ["failed", "Failed"]] as const).map(([value, label]) => ({ value, label: <>{label} <span className="font-normal">{counts[value]}</span></> }))} />
            </>
          )}
          <Button size="sm" className="ml-auto" onClick={exportJson} title="Save the trace as the server sent it"><Download aria-hidden />Export JSON</Button>
        </div>

        {spans.length === 0 ? (
          <p className="border bg-card p-4 font-mono text-body text-muted-foreground">{live ? "No model request has answered and no tool has been called yet." : "This run made no model request and called no tool."}</p>
        ) : view === "breakdown" ? <Breakdown trace={trace} now={now} onPick={pick} selected={selected?.id ?? null} /> : (
          <>
            <section aria-label="Calls on the time axis" className="border bg-card">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b px-4 py-2">
                <ul className="flex flex-1 flex-wrap gap-x-4 gap-y-1 text-small text-muted-foreground" aria-label="What a bar's colour says">
                  {([["bg-trace-model", "Model request"], ["bg-trace-tool", "Tool call"], ["bg-destructive", "Failed"], ...(spans.some((s) => s.status === "running") ? [["bg-run-active", "Running"]] : []), ...(spans.some((s) => s.status === "waiting") ? [[WAITING, "Waiting for a person"]] : []), ...(spans.some((s) => s.status === "refused" || s.status === "interrupted") ? [["bg-muted-foreground", "Refused or interrupted"]] : [])] as [string, string][]).map(([tone, word]) => (
                    <li key={word} className="flex items-center gap-1.5"><Swatch className={tone} />{word}</li>
                  ))}
                </ul>
                <div role="group" aria-label="Zoom the time axis" className="flex items-center gap-1">
                  {zoom > 0 && <span className="mr-1 font-mono text-small text-muted-foreground">{ZOOMS[zoom]}x</span>}
                  <Button size="icon" variant="ghost" aria-label="Zoom out" title="Zoom out" disabled={zoom === 0} onClick={() => setZoom((z) => Math.max(0, z - 1))}><ZoomOut aria-hidden /></Button>
                  <Button size="icon" variant="ghost" aria-label="Zoom in" title="Zoom in" disabled={zoom === ZOOMS.length - 1} onClick={() => setZoom((z) => Math.min(ZOOMS.length - 1, z + 1))}><ZoomIn aria-hidden /></Button>
                  <Button size="icon" variant="ghost" aria-label="Fit the whole run" title="Fit the whole run" disabled={zoom === 0} onClick={() => setZoom(0)}><Maximize2 aria-hidden /></Button>
                </div>
              </div>
              <div className="overflow-x-auto">
                <div className="p-4" style={{ width: `${ZOOMS[zoom]! * 100}%` }} role="group" aria-label="Calls on the time axis: the arrow keys move from call to call" onKeyDown={move}>
                  {trace.model_requests !== "not_recorded" && <Lane title={`Model requests (${totals!.requests})`} swatch="bg-trace-model" {...lanes.model} marks={marks} selected={selected?.id ?? null} dimmed={(s) => !keeps(s, kind, query)} tab={tab} refs={refs} onPick={pickBar} at={say} />}
                  <Lane title={`Tool calls (${totals!.calls})`} swatch="bg-trace-tool" {...lanes.tool} marks={marks} selected={selected?.id ?? null} dimmed={(s) => !keeps(s, kind, query)} tab={tab} refs={refs} onPick={pickBar} at={say} />
                  <div className="relative mt-2 h-4 border-t" aria-hidden>
                    {/* A mark near the right edge writes its label to its left, inside the panel. */}
                    {marks.map((m) => <span key={m.left} className={cn("absolute top-1 whitespace-nowrap font-mono text-micro text-muted-foreground", m.left > 94 ? "-translate-x-full pr-1" : "pl-1")} style={{ left: `${m.left}%` }}>{m.label}</span>)}
                  </div>
                </div>
              </div>
            </section>

            <div className="overflow-x-auto border bg-card">
              <table className="w-full text-small">
                <thead>
                  <tr className="border-b">
                    <th scope="col" className="caps px-3 py-2 text-left text-label font-normal text-muted-foreground">Call</th>
                    {SORTS.map((s) => (
                      <th key={s.id} scope="col" aria-sort={sort === s.id ? (s.id === "started" ? "ascending" : "descending") : "none"} className={cn("whitespace-nowrap px-3 py-2", s.right ? "text-right" : "text-left", s.id === "tokens" && narrow)}>
                        <button type="button" onClick={() => setSort(sort === s.id ? "started" : s.id)} title={s.id === "started" ? "In the order they started" : `Sort by ${s.label.toLowerCase()}, most first`}
                          className={cn("caps -my-1 inline-flex items-center gap-1 py-1 text-label hover:text-foreground", sort === s.id ? "text-foreground" : "text-muted-foreground")}>
                          {s.label}{sort === s.id && s.id !== "started" && <ArrowDown className="size-3" aria-hidden />}
                        </button>
                      </th>
                    ))}
                    <th scope="col" className="caps px-3 py-2 text-left text-label font-normal text-muted-foreground">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {(whole ? shown : shown.slice(0, ROWS)).map((span) => {
                    const ms = spanMs(span, now);
                    const nested = sort === "started" ? Math.min(2, depth.get(span.id) ?? 0) : 0;
                    return (
                      <tr key={span.id} ref={(el) => { if (el) rowRefs.current.set(span.id, el); else rowRefs.current.delete(span.id); }} onClick={() => pick(span.id)} className={cn("cursor-pointer border-b last:border-b-0 hover:bg-accent", span.id === selected?.id && "bg-accent")}>
                        <td className="w-full min-w-48 max-w-0 overflow-hidden py-0 pl-1 pr-3">
                          <button type="button" aria-pressed={span.id === selected?.id} aria-label={say(span)} className={cn("flex h-control-sm w-full min-w-0 items-center gap-2 text-left font-mono -outline-offset-2", nested === 1 && "pl-4", nested === 2 && "pl-8")}>
                            <span aria-hidden className={cn("h-4 w-0.5 shrink-0", mark(span))} />
                            <span className="caps w-9 shrink-0 text-micro text-muted-foreground">{KIND_WORD[span.kind]}</span>
                            <span className="max-w-64 shrink-0 truncate" title={span.name}>{span.name}</span>
                            {(span.input_preview || span.agent_label) && <span className="min-w-0 flex-1 truncate text-muted-foreground">{span.agent_label ? `${span.agent_label} ` : ""}{span.input_preview ?? ""}</span>}
                          </button>
                        </td>
                        <td className="whitespace-nowrap px-3 font-mono text-muted-foreground">{offset(Date.parse(span.started_at) - window.from)}</td>
                        <td className="whitespace-nowrap px-3 text-right font-mono">{ms !== null ? duration(ms) : "–"}</td>
                        <td className={cn("whitespace-nowrap px-3 text-right font-mono text-muted-foreground", narrow)}>{sizeWords(span)}</td>
                        <td className="whitespace-nowrap px-3 text-right font-mono">{costWords(span, trace)}</td>
                        <td className="px-3"><Chip tone={STATUS[span.status].tone}>{STATUS[span.status].word}</Chip></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {shown.length === 0 && <p role="status" className="p-4 text-body text-muted-foreground">No call matches. Clear the filter to see all {spans.length}.</p>}
              {!whole && shown.length > ROWS && (
                <p className="flex flex-wrap items-center gap-3 border-t p-3 text-body text-muted-foreground">The first {ROWS} of {shown.length.toLocaleString("en-US")} are listed. <Button size="xs" onClick={() => setWhole(true)}>Show all {shown.length.toLocaleString("en-US")}</Button></p>
              )}
            </div>
          </>
        )}
      </section>
      {selected && <SpanPanel key={selected.id} span={selected} trace={trace} run={run} from={window.from} now={now} reveal={reveal} onPick={pick} onClose={close} />}
    </div>
  );
}
