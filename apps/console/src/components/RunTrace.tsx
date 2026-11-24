import { ArrowDown, ChevronLeft, ChevronRight, Download, Maximize2, Play, X, ZoomIn, ZoomOut } from "lucide-react";
import { type KeyboardEvent, type PointerEvent, type ReactNode, useEffect, useId, useMemo, useRef, useState } from "react";
import { Banner } from "@/components/ui/banner";
import { Button } from "@/components/ui/button";
import { Chip, type ChipTone } from "@/components/ui/chip";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input } from "@/components/ui/field";
import { ListFilter } from "@/components/ListFilter";
import { Segmented } from "@/components/ui/segmented";
import { Spinner } from "@/components/ui/spinner";
import { tabPanelProps, Tabs } from "@/components/ui/tabs";
import { bytes, capDollars, compact, isEstimate, runEnded, soFar } from "@/lib/format";
import { attemptWords, BASIS_WORDS, type Bar, between, bookedWords, budgetStop, byModel, byTool, cacheShare, costSplit, duration, findings, inputTokens, keeps, lane, lineName, lineNotes, offset, ordered, panned, percent, place, quantityWords, redoOf, redoWords, since, type SpanKind, type SpanSort, type Spend, spanMs, type StretchBar, stretches, stretchLane, ticks, timing, traceTotals, traceWindow, usd as dollars, type View, vitals, WHOLE, zoomed } from "@/lib/trace";
import { compareHref, runIdOf } from "@/lib/traceCompare";
import { cn } from "@/lib/utils";
import type { Run, RunTrace as Trace, RunUsage, TraceSpan, UsageLine } from "@/lib/v2";

/** A run's trace (GET /v2/runs/{id}/trace), read when its tab opens and again each time `version` moves (the run's
 *  rows, its status, its end). One read is out at a time and none is dropped: a move while one is out, or within half a
 *  second of the last, is one more read half a second after, so a run that moves faster than a read answers still shows
 *  each read as it lands. A read that fails is the tab's error only while there is nothing to show; `retry` reads at once. */
export function useRunTrace(read: (() => Promise<Trace>) | undefined, version: string): { trace: Trace | null; error: unknown; retry: () => void } {
  const { got, error, retry } = useReread(read, version);
  return { trace: got, error, retry };
}

/** What `read` answers, read at once and again each time `version` moves, as `useRunTrace` says: the trace, or the run's
 *  usage lines beside it. */
function useReread<T>(read: (() => Promise<T>) | undefined, version: string): { got: T | null; error: unknown; retry: () => void } {
  const [trace, setTrace] = useState<T | null>(null);
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
  return { got: trace, error: trace ? null : error, retry: () => go.current() };
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
/** A part drawn light with an edge of its own, which keeps its shape where the tint alone is too faint on the card. */
const TINT = "border border-trace-model bg-trace-model/30";
/** Stripes through a fill (styles.css): a mark told from its neighbours by more than its hue. */
const HATCH = "trace-hatch";
/** A request's tokens by kind, each with its mark: told apart by fill, stripes and edge as well as by hue. */
const TOKEN_TONE = { fresh: "bg-muted-foreground", read: TINT, write: `bg-trace-model ${HATCH}`, output: "bg-trace-model" } as const;
/** A span's mark: its kind's colour, unless how it ended says more (failed, still going, waiting, never ran). One that
 *  failed is striped as well as red. */
const mark = (span: TraceSpan) =>
  span.status === "failed" ? `bg-destructive ${HATCH}` : span.status === "running" ? "bg-run-active" : span.status === "waiting" ? WAITING
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
/** A cell with no figure: a dash to the eye, a word to a screen reader. */
const NONE = <><span aria-hidden>–</span><span className="sr-only">None</span></>;
const orNone = (words: string | null) => (words === null || words === "–" ? NONE : words);
const clockMs = (iso: string) => new Date(iso).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit", fractionalSecondDigits: 3 });
const said = (error: unknown) => (error instanceof Error && error.message ? error.message : "The server gave no reason.");

/** One figure of the run's summary: its name, the figure, and a line under it. In a <dl>. */
function Tile({ label, value, note, tone }: { label: string; value: string | number; note: ReactNode; tone?: "bad" }) {
  return (
    <div className="min-w-0 border-b border-r px-3 py-2.5">
      <dt className="caps text-label text-muted-foreground">{label}</dt>
      {/* A figure in words (a cost known so far) is longer than a number: a step smaller, so it fits its tile. */}
      <dd className={cn("mt-0.5 break-words font-mono font-semibold leading-7", String(value).length > 11 ? "text-lg" : "text-figure", tone === "bad" && "text-destructive-text")}>{typeof value === "string" ? orNone(value) : value}</dd>
      <dd className="mt-0.5 text-small text-muted-foreground">{note}</dd>
    </div>
  );
}

/** A part's heading: a view's own (h2, in the Breakdown) or one inside the open call's panel (h3, under its name). */
const Heading = ({ children, aside, level: Level = "h3" }: { children: ReactNode; aside?: ReactNode; level?: "h2" | "h3" }) => (
  <div className="mb-2 flex items-baseline justify-between gap-3">
    <Level className="caps text-small font-semibold">{children}</Level>
    {aside && <span className="font-mono text-small text-muted-foreground">{aside}</span>}
  </div>
);
const Swatch = ({ className }: { className: string }) => <span aria-hidden className={cn("trace-mark inline-block size-2 shrink-0", className)} />;

/** One lane of the overview: its spans as thin bars, on as many rows as overlap. A press on a bar opens its span. The
 *  overview is a picture to a screen reader and no stop for the keyboard: the table under it lists the same spans, and
 *  is where both read and open them. */
function Lane({ title, swatch, bars, rows, selected, dimmed, onPick, at }: {
  title: string; swatch: string; bars: Bar[]; rows: number; selected: string | null; dimmed: (span: TraceSpan) => boolean; onPick: (id: string) => void; at: (span: TraceSpan) => string;
}) {
  return (
    <div className="mt-2.5 first:mt-0">
      <p className="caps flex items-center gap-1.5 text-label text-muted-foreground"><Swatch className={swatch} />{title}</p>
      <div className="relative mt-1.5" style={{ height: rows * 12 - 4 }}>
        {bars.map(({ span, left, width, row }) => (
          <span key={span.id} data-span={span.id} data-open={span.id === selected ? "" : undefined} title={at(span)} onClick={() => onPick(span.id)}
            style={{ left: `${left}%`, width: `${width}%`, top: row * 12 }}
            className={cn("trace-mark absolute h-2 min-w-0.5 cursor-pointer hover:opacity-80", mark(span), dimmed(span) && "opacity-25", span.id === selected && "ring-2 ring-foreground ring-offset-1 ring-offset-card")} />
        ))}
      </div>
    </div>
  );
}

/** A lane of the overview for what was up beside the run's calls: its computers, or its browser sessions. A bar opens
 *  nothing (it is no call) and says what it is where the pointer rests; the Breakdown lists each. One that began before
 *  the first request or outlasted the last has no edge on that side. */
function StretchLane({ title, swatch, bars, rows, now, from }: { title: string; swatch: string; bars: StretchBar[]; rows: number; now: number; from: number }) {
  return (
    <div className="mt-2.5 first:mt-0" data-stretches>
      <p className="caps flex items-center gap-1.5 text-label text-muted-foreground"><Swatch className={swatch} />{title}</p>
      <div className="relative mt-1.5" style={{ height: rows * 12 - 4 }}>
        {bars.map(({ stretch, left, width, row, before, after }) => (
          <span key={stretch.key} data-stretch={stretch.key} title={`${stretch.name}, ${stretch.to === null ? "no end recorded" : `up ${duration(stretch.to - stretch.from!)}`}, from ${since(stretch.from! - from)}`}
            style={{ left: `${left}%`, width: `${width}%`, top: row * 12 }} className={cn("trace-mark absolute h-2 min-w-0.5", swatch, before && "border-l-0", after && "border-r-0", stretch.to === null && now > stretch.from! && "border-r-0")} />
        ))}
      </div>
    </div>
  );
}

/** The overview's lanes over the axis's marks, with the part the table's time axis shows framed on it. A drag across
 *  picks that part, as on a browser's performance overview; the zoom buttons beside the legend do the same from the
 *  keyboard. */
function Overview({ marks, view, onView, children }: { marks: { left: number; label: string }[]; view: View; onView: (view: View) => void; children: ReactNode }) {
  const track = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ from: number; to: number } | null>(null);
  // A drag that moved: the press that ends it opens no bar.
  const moved = useRef(false);
  const share = (e: PointerEvent) => {
    const box = track.current?.getBoundingClientRect();
    return box && box.width > 0 ? Math.min(1, Math.max(0, (e.clientX - box.left) / box.width)) : 0;
  };
  const end = (to: number) => {
    if (!drag) return;
    setDrag(null);
    if (moved.current && Math.abs(to - drag.from) > 0.01) onView(between(drag.from, to));
  };
  const picked = drag && moved.current ? { from: Math.min(drag.from, drag.to), to: Math.max(drag.from, drag.to) } : null;
  return (
    <div ref={track} data-overview className="relative cursor-crosshair touch-pan-y select-none"
      onPointerDown={(e) => { if (e.button !== 0) return; moved.current = false; const at = share(e); setDrag({ from: at, to: at }); }}
      onPointerMove={(e) => { if (!drag) return; const at = share(e); if (Math.abs(at - drag.from) > 0.01) moved.current = true; setDrag({ from: drag.from, to: at }); }}
      onPointerUp={(e) => end(share(e))} onPointerLeave={() => { if (drag) end(drag.to); }} onPointerCancel={() => setDrag(null)}
      onClickCapture={(e) => { if (moved.current) { e.stopPropagation(); moved.current = false; } }}>
      {marks.map((m) => <span key={m.left} className="absolute inset-y-0 w-px bg-border" style={{ left: `${m.left}%` }} />)}
      {children}
      {picked ? <span data-band className="pointer-events-none absolute inset-y-0 border-x border-foreground bg-foreground/10" style={{ left: `${picked.from * 100}%`, width: `${(picked.to - picked.from) * 100}%` }} />
        : view !== WHOLE && (
          <>
            <span className="pointer-events-none absolute inset-y-0 left-0 bg-background/70" style={{ width: `${view.from * 100}%` }} />
            <span className="pointer-events-none absolute inset-y-0 right-0 bg-background/70" style={{ width: `${(1 - view.to) * 100}%` }} />
            <span data-band className="pointer-events-none absolute inset-y-0 border-x-2 border-foreground" style={{ left: `${view.from * 100}%`, width: `${(view.to - view.from) * 100}%` }} />
          </>
        )}
    </div>
  );
}

/** A span's time in three parts (lib/trace `timing`): what it waited before it started, how long it ran, and how long
 *  what came next took to start. Shown where the trace carries a part beside the span's own time. */
function Timing({ span, trace, now, onPick }: { span: TraceSpan; trace: Trace; now: number; onPick: (id: string) => void }) {
  const t = useMemo(() => timing(span, trace, now), [span, trace, now]);
  if (!t.before && !t.then) return null;
  const model = span.kind === "model";
  const parts: { id: string; word: string; ms: number; tone: string; about?: string; to?: TraceSpan }[] = [
    ...(t.before ? [{ id: "before", word: "Waited to start", ms: t.before.ms, tone: "bg-border-strong", about: model ? "since the end of" : "since the answer of", to: t.before.since }] : []),
    ...(t.ran !== null ? [{ id: "ran", word: !span.ended_at ? (span.status === "waiting" ? "Waiting so far" : "Running so far") : model ? "Answered in" : "Ran for", ms: t.ran, tone: mark(span) }] : []),
    ...(t.then ? [{ id: "then", word: model ? "Until its first call started" : "Until the next request started", ms: t.then.ms, tone: `bg-border-strong ${HATCH}`, about: "", to: t.then.until }] : []),
  ];
  const all = parts.reduce((sum, part) => sum + part.ms, 0);
  return (
    <section className="mt-5" aria-label="Timing">
      <Heading aside={duration(all)}>Timing</Heading>
      <div className="flex h-2.5 gap-px bg-accent" role="img" aria-label={parts.map((part) => `${part.word} ${duration(part.ms)}`).join(", ")}>
        {parts.filter((part) => part.ms > 0).map((part) => <span key={part.id} className={cn("trace-mark min-w-0.5", part.tone)} style={{ width: `${all > 0 ? (part.ms / all) * 100 : 0}%` }} />)}
      </div>
      <dl className="mt-2">
        {parts.map((part) => (
          <div key={part.id} className="flex items-baseline justify-between gap-4 border-b py-1.5">
            <dt className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-body"><span className="flex items-center gap-2"><Swatch className={part.tone} />{part.word}</span>
              {part.to && <button type="button" className="min-h-6 max-w-full truncate font-mono text-small text-muted-foreground underline underline-offset-2 hover:text-primary-text" onClick={() => onPick(part.to!.id)}>{part.about ? `${part.about} ` : ""}{part.to.name}</button>}
            </dt>
            <dd className="shrink-0 font-mono text-small">{duration(part.ms)}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/** The panel of one span: what it cost and used, when it ran, what called it and what it called, and a call's arguments
 *  and the head of its output. */
function SpanPanel({ span, trace, run, from, now, reveal, onPick, onClose, onRecording }: { span: TraceSpan; trace: Trace; run: Run; from: number; now: number; reveal: boolean; onPick: (id: string) => void; onClose: () => void; onRecording?: () => void }) {
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
  const lines = t ? ([["Input, not cached", t.input, TOKEN_TONE.fresh], ["Cache read", t.cache_read, TOKEN_TONE.read], ["Cache write", t.cache_write, TOKEN_TONE.write], ["Output", t.output, TOKEN_TONE.output]] as const) : [];
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
            <dt className="caps text-label text-muted-foreground">{label}</dt>
            <dd className="mt-0.5 break-words font-mono text-base font-semibold">{orNone(value)}</dd>
            {note && <dd className="text-label text-muted-foreground">{note}</dd>}
          </div>
        ))}
      </dl>

      {/* The run's screen was recorded while this call ran: the Screen tab plays the recording from the call's time. */}
      {onRecording && <p className="mt-3"><Button size="xs" onClick={onRecording}><Play aria-hidden />Show on the recording</Button></p>}

      <Timing span={span} trace={trace} now={now} onPick={onPick} />

      {span.kind === "model" && (
        <section className="mt-5" aria-label="Tokens">
          <Heading aside={share !== null ? `${percent(share)} of input from cache` : undefined}>Tokens</Heading>
          {t ? (
            <>
              <div className="flex h-2.5 gap-px bg-accent" role="img" aria-label={lines.map(([label, n]) => `${label}: ${n.toLocaleString("en-US")} tokens`).join(", ")}>
                {lines.filter(([, n]) => n > 0).map(([label, n, tone]) => <span key={label} title={`${label}: ${n.toLocaleString("en-US")}`} className={cn("trace-mark min-w-0.5", tone)} style={{ width: `${(n / all) * 100}%` }} />)}
              </div>
              <table className="mt-2 w-full text-small">
                <thead><tr className="caps border-b text-label text-muted-foreground"><th scope="col" className="py-1.5 text-left font-normal">Line</th><th scope="col" className="py-1.5 text-right font-normal">Tokens</th><th scope="col" className="py-1.5 pl-3 text-right font-normal">Of input</th></tr></thead>
                <tbody>
                  {lines.map(([label, n, tone]) => (
                    <tr key={label} className="border-b">
                      <th scope="row" className="whitespace-nowrap py-1.5 text-left text-body font-normal"><span className="flex items-center gap-2"><Swatch className={tone} />{label}</span></th>
                      <td className="py-1.5 text-right font-mono">{n.toLocaleString("en-US")}</td>
                      <td className="py-1.5 pl-3 text-right font-mono text-muted-foreground">{label !== "Output" && inputTokens(t) > 0 ? percent(n / inputTokens(t)) : NONE}</td>
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
              <dd className="min-w-0"><button type="button" className="-my-1 min-h-6 max-w-full truncate py-1 font-mono text-small underline underline-offset-2 hover:text-primary-text" onClick={() => onPick(parent.id)}>{parent.name} · {offset(Date.parse(parent.started_at) - from)}</button></dd>
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
                <button type="button" className="flex min-h-6 w-full items-center gap-2 py-1.5 text-left font-mono text-small hover:bg-accent" onClick={() => onPick(child.id)}>
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

/** Asks which run to compare this one with, and opens the two side by side (#/compare, lib/traceCompare.ts): this run
 *  first, the other second. The other is named by its id or by its page's address, as a person copies either. */
function CompareWith({ runId, onClose }: { runId: string; onClose: () => void }) {
  const [pasted, setPasted] = useState("");
  const [refused, setRefused] = useState<string | null>(null);
  const field = useRef<HTMLInputElement>(null);
  const go = () => {
    const other = runIdOf(pasted);
    if (!other) { setRefused(pasted.trim() ? "That is not a run's id or its page's address." : "Paste the other run's id, or its page's address."); return; }
    if (other === runId) { setRefused("That is this run. Name another one."); return; }
    onClose();
    location.hash = compareHref([runId, other]);
  };
  return (
    <Dialog open onClose={onClose} title="Compare with another run" initialFocus={field}
      description="This run's requests, calls, tokens, cost and time beside another run's, with the difference."
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={go}>Compare</Button></>}>
      <form onSubmit={(e) => { e.preventDefault(); go(); }}>
        <Field label="The other run" hint="Its id, or the address of its page. It is the second run; this one is the first." error={refused}>
          <Input ref={field} value={pasted} onChange={(e) => { setPasted(e.target.value); setRefused(null); }} placeholder="run id or address" className="font-mono" />
        </Field>
      </form>
    </Dialog>
  );
}

/** A model's mark where the cost is split by model: the first the full colour, the next striped, the rest light with an edge. */
const MODEL_TONES = ["bg-trace-model", `bg-trace-model ${HATCH}`, TINT];

/** A tool vendor's mark where the cost is split by line: the first the full colour, the next striped, the rest light. */
const TOOL_TONES = ["bg-trace-tool", `bg-trace-tool ${HATCH}`, "border border-trace-tool bg-trace-tool/30"];
/** Browser and computer time's mark: its own colour, hollow, told from a tool vendor's by more than its hue. */
const BROWSER_TONE = "border border-trace-tool bg-card";
/** A computer's stretch on the time axis: light with an edge, so one that spans the whole run still reads as a band. A
 *  browser session's: hollow, as its time's line is. Each has a lane of its own, named. */
const COMPUTER_TONE = "border border-trace-tool bg-trace-tool/30";
const SESSION_TONE = BROWSER_TONE;

/** Each usage line as a part of the split, with its mark: a model's tones in turn, a tool vendor's, browser time's. A line
 *  whose cost is not known counts what is known of it, and says so. */
function lineParts(lines: readonly UsageLine[]) {
  const seen = { tokens: 0, tools: 0 };
  return lines.map((line) => {
    const tone = line.meter === "browser_time" || line.meter === "compute_time" ? BROWSER_TONE
      : line.meter === "tokens" ? MODEL_TONES[Math.min(seen.tokens++, MODEL_TONES.length - 1)]! : TOOL_TONES[Math.min(seen.tools++, TOOL_TONES.length - 1)]!;
    // Two lines of one name differ by the attempt they were made in, and two of one attempt by whether their requests
    // were sent again: the part says both, where the run's lines differ by either.
    const attempt = attemptWords(line, lines) === null ? "" : `${line.attempt !== null ? ` · attempt ${line.attempt}` : ""}${line.billable ? "" : " · sent again"}`;
    return { word: `${lineName(line)}${attempt}`, tone, n: line.usd ?? line.so_far_usd ?? 0, says: bookedWords(line) };
  });
}

/** Why a run has no usage lines, in one sentence. */
const NO_LINES: Record<NonNullable<RunUsage["reason"]>, string> = {
  running: "Cost by line appears when the run ends.",
  not_booked: "This run's cost is its harness's own figure, so it can't be split by line.",
  reopened: "A follow-up reopened this learning run, so its cost can't be split by round.",
};

/** The run's cost line by line, from the server's booking: a row a line, with its quantity, its cost and how the cost
 *  was reached. */
function CostLines({ lines }: { lines: readonly UsageLine[] }) {
  const th = "caps whitespace-nowrap py-1.5 pl-3 text-right text-label font-normal text-muted-foreground first:pl-0 first:text-left";
  const id = useId();
  return (
    <div className="mt-4">
      <p className="caps mb-1 text-label font-semibold text-muted-foreground" id={id}>Cost by line</p>
      <div className="overflow-x-auto" tabIndex={0} role="region" aria-labelledby={id}>
        <table className="w-full text-small">
          <thead><tr className="border-b">{["Line", "Quantity", "Cost", "Basis"].map((h) => <th key={h} scope="col" className={th}>{h}</th>)}</tr></thead>
          <tbody>
            {lines.map((line, i) => {
              // The attempt a line was made in goes first: it says which of two lines of one name this is.
              const notes = [attemptWords(line, lines), ...lineNotes(line)].filter((note): note is string => note !== null);
              const kind = line.meter === "tokens" ? `Tokens${line.provider ? ` · sent to ${line.provider}` : ""}` : line.meter === "tools" ? "Tool charges" : line.meter === "compute_time" ? "Computer time" : "Browser time";
              return (
                <tr key={i} className="border-b last:border-b-0">
                  <th scope="row" className="py-1.5 text-left font-normal">
                    <span className="block font-mono">{lineName(line)}</span>
                    <span className="block text-muted-foreground">{kind}</span>
                    {notes.map((note) => <span key={note} className="block text-muted-foreground">{note}</span>)}
                  </th>
                  <td className="whitespace-nowrap py-1.5 pl-3 text-right align-top font-mono">{orNone(quantityWords(line))}</td>
                  <td className="whitespace-nowrap py-1.5 pl-3 text-right align-top font-mono">{bookedWords(line)}</td>
                  <td className="whitespace-nowrap py-1.5 pl-3 text-right align-top text-muted-foreground">{BASIS_WORDS[line.basis]}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** A stacked bar of parts that add up to a whole, with each part named under it: its word, its figure and its share. */
/** A part's `says` is its figure in words where `say(n)` would not tell the whole of it (a cost known only in part). */
function Split({ label, parts, whole, say }: { label: string; parts: readonly { word: string; tone: string; n: number; says?: string }[]; whole: number; say: (n: number) => string }) {
  const some = parts.filter((part) => part.n > 0);
  const words = (part: (typeof some)[number]) => part.says ?? say(part.n);
  return (
    <>
      <div className="flex h-3 gap-px bg-accent" role="img" aria-label={`${label}: ${some.map((part) => `${part.word} ${words(part)}`).join(", ")}`}>
        {some.map((part, i) => <span key={`${i}:${part.word}`} className={cn("trace-mark min-w-0.5", part.tone)} style={{ width: `${(part.n / Math.max(whole, Number.MIN_VALUE)) * 100}%` }} />)}
      </div>
      <ul className="mt-3 flex flex-wrap gap-x-6 gap-y-1.5 text-small">
        {some.map((part, i) => <li key={`${i}:${part.word}`} className="flex items-center gap-2"><Swatch className={part.tone} />{part.word}<span className="font-mono text-muted-foreground">{words(part)} · {percent(whole > 0 ? part.n / whole : 0)}</span></li>)}
      </ul>
    </>
  );
}

/** Where the cost went, from the run's usage lines: one part a line, the run's total beside the heading, and the lines
 *  in a table under the split. */
function CostByLine({ usage, lines }: { usage: RunUsage; lines: readonly UsageLine[] }) {
  const parts = lineParts(lines);
  const whole = parts.reduce((sum, part) => sum + part.n, 0);
  const free = lines.length > 0 && lines.every((line) => line.usd === 0);
  const redo = redoOf(usage);
  return (
    <>
      <Heading level="h2" aside={usage.total ? bookedWords(usage.total) : undefined}>Where the cost went</Heading>
      {lines.length === 0 ? <p className="text-body text-muted-foreground">This run booked no cost.</p>
        : whole > 0 ? <Split label="Where the cost went" whole={whole} say={dollars} parts={parts} />
        : <p className="text-body text-muted-foreground">{free ? "Every line of this run's cost was $0." : "No line of this run's cost is known yet."}</p>}
      <p className="mt-2 max-w-prose text-small text-muted-foreground">The run's cost as the server booked it: a line for each model, each vendor that charged for a tool, and each browser provider.</p>
      {redo && (
        <p className="mt-3 max-w-prose text-small" data-redo>
          <span className="font-semibold">Requests sent twice: {redoWords(redo)}{redo.share !== null ? ` · ${percent(redo.share)}` : ""}.</span>{" "}
          <span className="text-muted-foreground">An attempt at a turn was cut (its runner drained, crashed or lost its lease, or the turn was tried again) and another took over. Model requests it had sent and not finished were sent again; its answered requests and finished paid calls were reused. The repeated requests' lines say so, and their cost is in the run's.</span>
        </p>
      )}
      {lines.length > 0 && <CostLines lines={lines} />}
    </>
  );
}

/** The run's computers and browser sessions, a row each: when it started against the first request (`anchor`: against
 *  the run's start, for a run with no request), how long it was up, and how much of that is in the run's cost. The
 *  overview draws the same on its time axis. A session whose start is not recorded has a row too, with what was charged. */
function Stretches({ usage, from, anchor }: { usage: RunUsage; from: number; anchor?: string }) {
  const { computers, browsers } = useMemo(() => stretches(usage), [usage]);
  const all = [...computers, ...browsers];
  if (!all.length) return null;
  // One with no end recorded (a computer whose delete failed, a session whose release was never told) may be up still:
  // how long it had been up is said as of the run's end, the moment the usage covers, never as its age now.
  const ended = usage.ended_at ? Date.parse(usage.ended_at) : Number.NaN;
  const upAtEnd = (began: number) => (ended > began ? `No end recorded · up ${duration(ended - began)} when the run ended` : "No end recorded");
  const th = "caps whitespace-nowrap px-3 py-2 text-right text-label font-normal text-muted-foreground first:text-left last:text-left";
  const td = "whitespace-nowrap px-3 py-2 text-right align-top font-mono";
  return (
    <section aria-label="Computers and browser sessions">
      <Heading level="h2" aside="up beside the run's calls">Computers and browser sessions</Heading>
      <div className="overflow-x-auto border bg-card" tabIndex={0} role="region" aria-label="The run's computers and browser sessions">
        <table className="w-full text-small">
          <thead><tr className="border-b">{["What", "Started", "Up for", "In the run's cost", "Note"].map((h) => <th key={h} scope="col" className={th}>{h}</th>)}</tr></thead>
          <tbody>
            {all.map((stretch) => (
              <tr key={stretch.key} className="border-b last:border-b-0">
                <th scope="row" className="px-3 py-2 text-left font-normal">
                  <span className="flex items-center gap-2 font-mono"><Swatch className={stretch.kind === "computer" ? COMPUTER_TONE : SESSION_TONE} />{stretch.name}</span>
                  {stretch.about && <span className="block break-all pl-4 text-muted-foreground">{stretch.about}</span>}
                </th>
                <td className={td}>{stretch.from !== null ? since(stretch.from - from, anchor) : "Not recorded"}</td>
                <td className={td}>{stretch.from === null ? "Not recorded" : stretch.to !== null ? duration(stretch.to - stretch.from) : upAtEnd(stretch.from)}</td>
                <td className={td}>{stretch.counted !== null ? duration(stretch.counted * 1000) : "Unknown"}</td>
                <td className="px-3 py-2 text-left align-top text-muted-foreground">{stretch.notes.length ? stretch.notes.join(". ") : NONE}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 max-w-prose text-small text-muted-foreground">A computer's and a browser session's time is billed by its provider, apart from any call. What of it is in the run's cost is on its lines above: a computer's time while a claim of the run held it, a session's as it was charged.</p>
    </section>
  );
}

/** The run's requests and calls added up: what stands out, where the time and the cost went, each request's input and
 *  cost in the order they ran, and the same by model and by tool. */
function Breakdown({ trace, usage, run, now, onPick, selected }: { trace: Trace; usage: RunUsage | null; run: Run; now: number; onPick: (id: string) => void; selected: string | null }) {
  const totals = useMemo(() => traceTotals(trace, now), [trace, now]);
  const tools = useMemo(() => byTool(trace.spans, now), [trace, now]);
  const models = useMemo(() => byModel(trace.spans, trace.model_requests === "priced"), [trace]);
  const found = useMemo(() => findings(trace, now, { usage, run }), [trace, now, usage, run]);
  const split = useMemo(() => costSplit(trace.spans), [trace]);
  const vital = useMemo(() => vitals(trace.spans, now), [trace, now]);
  // The figures every run has, in one order: what a browser's vitals are to a page load.
  const cells: { label: string; value: string; note: string; span?: string }[] = [
    ...(vital.firstAnswer ? [{ label: "First answer", value: duration(vital.firstAnswer.ms), note: vital.firstAnswer.span.name, span: vital.firstAnswer.span.id }] : []),
    ...(vital.firstCall ? [{ label: "First tool call", value: duration(vital.firstCall.ms), note: vital.firstCall.span.name, span: vital.firstCall.span.id }] : []),
    ...(vital.largestInput ? [{ label: "Largest input", value: `${compact(vital.largestInput.tokens)} tokens`, note: `Request ${vital.largestInput.nth} of ${vital.largestInput.of}`, span: vital.largestInput.span.id }] : []),
    ...(vital.atOnce ? [{ label: "Most calls at once", value: String(vital.atOnce.calls), note: `First at ${offset(vital.atOnce.at)}` }] : []),
    ...(vital.longestPause ? [{ label: "Longest pause", value: duration(vital.longestPause.ms), note: `After ${vital.longestPause.after.name}`, span: vital.longestPause.after.id }] : []),
  ];
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
      {cells.length > 0 && (
        <section aria-label="Run vitals">
          <Heading level="h2" aside="from the start of the first request">Run vitals</Heading>
          <ul className={cn("grid grid-cols-2 border-l border-t sm:grid-cols-3", selected ? "2xl:grid-cols-5" : "xl:grid-cols-5")}>
            {cells.map((cell) => {
              const body = <><span className="caps block text-label text-muted-foreground">{cell.label}</span><span className="mt-0.5 block font-mono text-lg font-semibold">{cell.value}</span><span className="mt-0.5 block break-words text-small text-muted-foreground">{cell.note}</span></>;
              return (
                <li key={cell.label} className="min-w-0 border-b border-r bg-card">
                  {cell.span ? <button type="button" aria-pressed={cell.span === selected} onClick={() => onPick(cell.span!)} className={cn("block h-full w-full p-3 text-left -outline-offset-2 hover:bg-accent", cell.span === selected && "bg-accent")}>{body}</button> : <div className="p-3">{body}</div>}
                </li>
              );
            })}
          </ul>
          <p className="mt-2 max-w-prose text-small text-muted-foreground">A pause is a stretch with no model answering and no tool running: the run waiting for a person or its turn, or its harness working.</p>
        </section>
      )}

      {found.length > 0 && (
        <section aria-label="What stands out">
          <Heading level="h2">What stands out</Heading>
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
          <Heading level="h2" aside={duration(totals.time.wall)}>Where the time went</Heading>
          <Split label="Where the time went" whole={totals.time.wall} say={duration} parts={[{ word: "A model answering", tone: "bg-trace-model", n: totals.time.model }, { word: "A tool running", tone: "bg-trace-tool", n: totals.time.tools }, { word: "Neither", tone: "bg-border-strong", n: totals.time.other }]} />
          <p className="mt-2 max-w-prose text-small text-muted-foreground">Each moment is counted once. "Neither" is the time between calls: the run waiting for a person or its turn, or its harness working.</p>
        </section>
        <section aria-label="Where the cost went" className="border bg-card p-4">
          {usage?.lines ? <CostByLine usage={usage} lines={usage.lines} /> : (
          <>
          <Heading level="h2" aside={split ? dollars(split.total) : undefined}>Where the cost went</Heading>
          {split && split.total === 0 ? <p className="text-body text-muted-foreground">Everything this trace knows the cost of was $0.</p>
            : split ? <Split label="Where the cost went" whole={split.total} say={dollars} parts={split.parts.map((part, i) => ({ word: part.name, tone: part.kind === "tool" ? "bg-trace-tool" : MODEL_TONES[Math.min(i, MODEL_TONES.length - 1)]!, n: part.usd }))} />
            : <p className="text-body text-muted-foreground">{trace.model_requests === "priced" ? "Nothing in this trace has a known cost yet." : "This run's cost is booked for the run as a whole: its trace carries no cost for each request."}</p>}
          {split && split.total > 0 && <p className="mt-2 max-w-prose text-small text-muted-foreground">What the trace knows the cost of: each model's requests, and each charge under a call.{totals.cost.requests?.unknown ? ` ${totals.cost.requests.unknown} request${totals.cost.requests.unknown === 1 ? " has" : "s have"} no known cost and ${totals.cost.requests.unknown === 1 ? "is" : "are"} not in it.` : ""}</p>}
          {usage?.reason && <p className="mt-2 max-w-prose text-small text-muted-foreground">{NO_LINES[usage.reason]}</p>}
          </>
          )}
        </section>
      </div>

      {usage && <Stretches usage={usage} from={traceWindow(trace.spans, now).from} />}

      {requests.length > 0 && (
        <section aria-label="Each request" className="border bg-card p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <h2 className="caps text-small font-semibold">Each request, in the order they ran</h2>
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
                    {parts ? ([[parts.cache_read, TOKEN_TONE.read], [parts.cache_write, TOKEN_TONE.write], [parts.input, TOKEN_TONE.fresh]] as const).map(([tokens, tone]) => tokens > 0 && <span key={tone} className={cn("trace-mark", tone)} style={{ flexGrow: tokens }} />)
                      : <span className="trace-mark flex-1 bg-trace-model" />}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="mt-2 flex justify-between font-mono text-label text-muted-foreground"><span>first request</span><span>tallest: {shown === "cost" ? dollars(most) : `${compact(most)} tokens`}</span><span>last request</span></div>
          {shown === "input" && (
            <ul className="mt-3 flex flex-wrap gap-x-6 gap-y-1.5 text-small">
              <li className="flex items-center gap-2"><Swatch className={TOKEN_TONE.read} />Read from cache</li>
              <li className="flex items-center gap-2"><Swatch className={TOKEN_TONE.write} />Written to cache</li>
              <li className="flex items-center gap-2"><Swatch className={TOKEN_TONE.fresh} />Not cached</li>
            </ul>
          )}
          <p className="mt-2 max-w-prose text-small text-muted-foreground">{shown === "cost" ? "One bar a request: its height is what the run booked for it." : "One bar a request: its height is the input it sent. A run that caches well reads most of each request from cache and writes only what is new."}</p>
        </section>
      )}

      {models.length > 0 && (
        <section aria-label="By model">
          <Heading level="h2">By model</Heading>
          <div className="overflow-x-auto border bg-card" tabIndex={0} role="region" aria-label="Requests by model">
            <table className="w-full text-small">
              <thead><tr className="border-b">{["Model", "Requests", "Failed", "Input", "From cache", "Output", "Tokens/s", "Median time", "95th", "Total time", "Cost"].map((h) => <th key={h} scope="col" className={th}>{h}</th>)}</tr></thead>
              <tbody>
                {models.map((m) => (
                  <tr key={m.name} className="border-b last:border-b-0">
                    <th scope="row" className="px-3 py-2 text-left font-mono font-normal">{m.name}</th>
                    <td className={td}>{m.requests}</td><td className={cn(td, m.failed > 0 && "text-destructive-text")}>{m.failed}</td>
                    <td className={td}>{compact(m.tokens.input + m.tokens.cache_read + m.tokens.cache_write)}</td><td className={td}>{m.cache !== null ? percent(m.cache) : NONE}</td>
                    <td className={td}>{compact(m.tokens.output)}</td><td className={td}>{m.perSecond !== null ? Math.round(m.perSecond).toLocaleString("en-US") : NONE}</td>
                    <td className={td}>{m.p50 !== null ? duration(m.p50) : NONE}</td><td className={td}>{m.p95 !== null ? duration(m.p95) : NONE}</td><td className={td}>{duration(m.totalMs)}</td><td className={td}>{m.cost ? spendWords(m.cost) : NONE}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {tools.length > 0 && (
        <section aria-label="By tool">
          <Heading level="h2" aside="the tool that took the most time first">By tool</Heading>
          <div className="overflow-x-auto border bg-card" tabIndex={0} role="region" aria-label="Calls by tool">
            <table className="w-full text-small">
              <thead><tr className="border-b">{["Tool", "Calls", "Failed", "Total time", "Median", "95th", "Longest", "Charged", "Returned"].map((h) => <th key={h} scope="col" className={th}>{h}</th>)}</tr></thead>
              <tbody>
                {tools.map((row) => (
                  <tr key={row.name} className="border-b last:border-b-0">
                    <th scope="row" className="px-3 py-2 text-left font-mono font-normal">{row.name}</th>
                    <td className={td}>{row.calls}</td><td className={cn(td, row.failed > 0 && "text-destructive-text")}>{row.failed}</td>
                    <td className={td}><span className="inline-flex items-center gap-2"><span aria-hidden className="inline-block h-1.5 w-16 bg-accent"><span className="trace-mark block h-full bg-trace-tool" style={{ width: `${(row.totalMs / toolMs) * 100}%` }} /></span>{duration(row.totalMs)}</span></td>
                    <td className={td}>{row.p50 !== null ? duration(row.p50) : NONE}</td><td className={td}>{row.p95 !== null ? duration(row.p95) : NONE}</td>
                    <td className={td}>{row.maxMs !== null ? duration(row.maxMs) : NONE}</td><td className={td}>{row.charged > 0 ? spendWords(row.charges) : NONE}</td><td className={td}>{bytes(row.bytes)}</td>
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

/** The most rows the table draws until asked for the rest: a long run's first screenfuls, at once. */
const ROWS = 300;
const SORTS: { id: SpanSort; label: string; right?: boolean }[] = [{ id: "started", label: "Started" }, { id: "duration", label: "Duration", right: true }, { id: "tokens", label: "Size", right: true }, { id: "cost", label: "Cost", right: true }];
/** A table heading's cell. From `xl` the Trace pane scrolls, and the headings stay at its top (its top edge, above its
 *  own 24px of padding); the line under them is drawn by the cell itself, since a row's edge does not travel with a
 *  cell that stays. */
const TH = "relative bg-card px-3 py-2 after:absolute after:inset-x-0 after:bottom-0 after:h-px after:bg-border xl:sticky xl:-top-6 xl:z-raised";

/** The run page's Dev tools tab: every model request and tool call of the run in one table with its place on the time
 *  axis, each opening to what it used and cost; and the run's totals, by tool and by model. It reads as a browser's
 *  network panel does: an overview of the whole run, a row a call with its bar, and a panel for the open one.
 *  `version` moves when the run does (its rows, its status), so the trace is read again. `panel`: what ties the tab's
 *  body to its tab (tabPanelProps). For a story or a test: `now`, its own clock; `open`, the span open at first; `view`,
 *  the view shown at first. `openCall`: a tool call to open once the trace is read, by its span's id, asked for from the
 *  Screen tab's recording (`n` tells one ask from the next). `recorded`: for a call's span id, what shows the call on the
 *  run's recording, where one was made while it ran; a call's panel then offers it. */
export function RunTrace({ run, read, readUsage, version, live, panel, now: fixed, open = null, view: first = "calls", openCall, recorded }: { run: Run; read?: () => Promise<Trace>; readUsage?: () => Promise<RunUsage>; version: string; live: boolean; panel?: ReturnType<typeof tabPanelProps>; now?: number; open?: string | null; view?: "calls" | "breakdown"; openCall?: { span: string; n: number }; recorded?: (spanId: string) => (() => void) | undefined }) {
  const { trace, error, retry } = useRunTrace(read, version);
  // The run's cost line by line, read beside the trace and again as it moves. A read that fails leaves the trace's own split.
  // Lines are shown only as read at the run's version now: a follow-up reopens a run, and a reread that failed after it must
  // not leave an earlier end's lines on screen as this one's. (Not by `ended_at`: a run a person stopped reads no end on
  // the run, since a follow-up may take it on, while its lines cover the stop.)
  const readAt = readUsage && (() => readUsage().then((got) => ({ got, at: version })));
  const { got: usageRead } = useReread(readAt, version);
  const usage = usageRead && usageRead.at === version ? usageRead.got : null;
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
  // The part of the run the table's time axis shows: all of it, until a zoom or a drag across the overview.
  const [range, setRange] = useState<View>(WHOLE);
  const [whole, setWhole] = useState(false);
  const [comparing, setComparing] = useState(false);
  const [reveal, setReveal] = useState(false);
  // The row the keyboard was last on: the table's one stop for the Tab key.
  const [cursor, setCursor] = useState<string | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const rowRefs = useRef(new Map<string, HTMLTableRowElement>());
  const uid = useId();

  const spans = trace?.spans ?? [];
  // A call asked for from the recording: opened once, when the trace is read, as a call opened from the table is (on a
  // narrow screen its panel comes into view). One the trace does not hold (a read serves a run's first spans, and a
  // recording's step can be past them) is said, never passed over in silence.
  const asked = useRef<number | null>(null);
  const [missing, setMissing] = useState<number | null>(null);
  useEffect(() => {
    if (!openCall || !trace || asked.current === openCall.n) return;
    asked.current = openCall.n;
    const span = trace.spans.find((s) => s.id === openCall.span);
    if (!span) { setMissing(openCall.n); return; }
    setMissing(null);
    setView("calls");
    setReveal(true);
    setPicked(span.id);
    setCursor(span.id);
  }, [openCall, trace]);
  const window = useMemo(() => traceWindow(spans, now), [spans, now]);
  const totals = useMemo(() => (trace ? traceTotals(trace, now) : null), [trace, now]);
  const lanes = useMemo(() => ({ model: lane(spans.filter((s) => s.kind === "model"), window, now), tool: lane(spans.filter((s) => s.kind === "tool"), window, now) }), [spans, window, now]);
  // What was up beside the calls, once the run's usage says: its computers and its browser sessions, a lane each.
  const beside = useMemo(() => { const { computers, browsers } = stretches(usage); return { computers: stretchLane(computers, window, now), browsers: stretchLane(browsers, window, now) }; }, [usage, window, now]);
  const marks = useMemo(() => ticks(window.ms, 8), [window.ms]);
  // The table's own axis: what of the window shows, with a mark every quarter or so of it.
  const shownMs = (range.to - range.from) * window.ms;
  const rowMarks = useMemo(() => ticks(shownMs, 4, range.from * window.ms), [shownMs, range.from, window.ms]);
  // The table lists what the filter keeps and, once the axis is zoomed, what runs in the part that shows: a range picked
  // on the overview is a filter too, as on a browser's network panel.
  const shown = useMemo(() => ordered(spans.filter((s) => keeps(s, kind, query) && (range === WHOLE || place(s, window, range, now).off === null)), sort, now), [spans, kind, query, sort, now, range, window]);
  const depth = useMemo(() => {
    const byId = new Map(spans.map((s) => [s.id, s]));
    const of = (s: TraceSpan, seen = 0): number => (s.parent_id && byId.has(s.parent_id) && seen < 4 ? 1 + of(byId.get(s.parent_id)!, seen + 1) : 0);
    return new Map(spans.map((s) => [s.id, of(s)]));
  }, [spans]);

  if (!read) return null;
  if (!trace) {
    return (
      <div {...panel} className="px-5 py-8 md:px-8">
        {error ? <Banner tone="error" title="The trace could not be read" actions={<Button size="xs" onClick={retry}>Try again</Button>}><p className="font-mono text-small">{said(error)}</p></Banner>
          : <p className="flex items-center gap-3 font-mono text-body text-muted-foreground"><Spinner />Reading the trace</p>}
      </div>
    );
  }

  const selected = picked ? spans.find((s) => s.id === picked) ?? null : null;
  const listed = whole ? shown : shown.slice(0, ROWS);
  /** The row that takes the Tab key: where the keyboard last was, else the open span's, else the first. */
  const stop = (cursor !== null && listed.some((s) => s.id === cursor) ? cursor : selected && listed.some((s) => s.id === selected.id) ? selected.id : listed[0]?.id) ?? null;
  const rowButton = (id: string) => rowRefs.current.get(id)?.querySelector("button") ?? null;
  /** What had the keyboard when the panel opened (a row, a finding): it gets it back when the panel closes. One
   *  opened from inside the panel (the request that called it) keeps the first. */
  const from = () => { const active = document.activeElement; if (active instanceof HTMLElement && active !== document.body && !active.closest("aside")) opener.current = active; };
  /** A span opened from the table, the panel or the breakdown: on a narrow screen its panel comes into view. */
  const pick = (id: string) => { from(); setReveal(true); setPicked(id); };
  /** A span picked on the overview: its table row comes into view and is the keyboard's stop, and the view stays put. */
  const pickBar = (id: string) => { opener.current = rowButton(id) ?? opener.current; setReveal(false); setPicked(id); setCursor(id); rowRefs.current.get(id)?.scrollIntoView?.({ block: "nearest" }); };
  /** The panel closed: the keyboard goes back to what opened it, never to nowhere. */
  const close = () => {
    setPicked(null);
    if (opener.current?.isConnected) opener.current.focus();
  };
  const say = (span: TraceSpan) => `${KIND_WORD[span.kind]} ${span.name}, ${STATUS[span.status].word.toLowerCase()}, ${spanMs(span, now) !== null ? duration(spanMs(span, now)!) : "no duration"}, at ${offset(Date.parse(span.started_at) - window.from)}`;
  /** The table is one stop for the keyboard: the arrows, Page Up and Down, Home and End move from row to row. With a
   *  panel open, it follows the row the keyboard is on, as a browser's network panel does, and Escape closes it. */
  const moveRow = (e: KeyboardEvent<HTMLTableSectionElement>) => {
    // Escape closes the open panel from the table too: the keyboard is here while the panel follows it.
    if (e.key === "Escape" && selected) { e.preventDefault(); opener.current = rowButton(stop ?? "") ?? opener.current; close(); return; }
    const step = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : e.key === "PageDown" ? 10 : e.key === "PageUp" ? -10 : e.key === "Home" ? -listed.length : e.key === "End" ? listed.length : 0;
    if (!step || !listed.length) return;
    e.preventDefault();
    const at = Math.max(0, listed.findIndex((s) => s.id === stop));
    const next = listed[Math.min(listed.length - 1, Math.max(0, at + step))]!;
    setCursor(next.id);
    const button = rowButton(next.id);
    button?.focus();
    if (selected) { opener.current = button ?? opener.current; setReveal(false); setPicked(next.id); }
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
  // Beside an open panel (from `xl`) the table has what the panel leaves of the page, so two of its columns show by the
  // width of the pane the table is in, never the window's: the time axis (the overview draws it) once the rest fits
  // beside it, and Size (the panel says it) once all of them do. A window's width says nothing of the pane's: at 1536
  // wide the pane is 740, and the whole table needs some 920. Under `xl` the panel is under the table, which is as wide
  // as with none open.
  const axisShown = selected ? "md:max-xl:table-cell @4xl:table-cell" : "md:table-cell";
  const sizeShown = selected ? "hidden max-xl:table-cell @5xl:table-cell" : "";
  // The Call column takes what is left of the table; where the time axis shows beside it, the two share it.
  const callWidth = selected ? "w-full md:max-xl:w-[30%] @4xl:w-[30%]" : "w-full md:w-[30%]";
  const priced = totals!.cost.requests;
  // The run's spend cap, where it has one: how much of it the run's cost is, or the cap alone while the cost is not one
  // figure. A cost that is a ceiling (a request cut before its usage was known counts at what was held for it) is at most
  // that share of the cap.
  const cap = typeof run.cost?.cap_usd === "number" ? run.cost.cap_usd : null;
  const ofCap = cap === null ? null : typeof runUsd === "number" && cap > 0 ? `${run.cost?.upper_bound ? "at most " : ""}${percent(runUsd / cap)} of its ${capDollars(cap)} cap` : `cap ${capDollars(cap)}`;
  const costParts = priced ? `requests ${spendWords(priced)}${totals!.cost.charged ? ` · tools ${spendWords(totals!.cost.charges)}` : ""}` : totals!.cost.charged ? `tools ${spendWords(totals!.cost.charges)}` : "Booked for the run as a whole";
  const stopped = budgetStop(run);
  const besideWords = [[beside.computers.bars.length, "computer"], [beside.browsers.bars.length, "browser session"]].filter(([n]) => (n as number) > 0).map(([n, word]) => `${n} ${word}${n === 1 ? "" : "s"}`).join(" and ");
  const zoomedIn = range !== WHOLE;
  const filtered = kind !== "all" || query.trim() !== "" || zoomedIn;
  // A zoom goes in about the open span's middle, so it stays in view; with none open, about the middle of what shows.
  const about = selected && window.ms > 0 ? (Date.parse(selected.started_at) + (spanMs(selected, now) ?? 0) / 2 - window.from) / window.ms : undefined;

  return (
    // Each pane that scrolls is `relative`: what is placed out of the flow inside it (a Segmented's hidden radios, a
    // spinner's hidden words) is then placed against the pane and scrolls with it. Placed against the page instead, one
    // far down the pane's content made the whole page scroll, with nothing under it.
    <div {...panel} data-scroll-pane className="relative min-h-0 flex-1 overflow-auto xl:flex xl:overflow-hidden short:flex-none short:overflow-visible">
      <section aria-label="Trace" className="relative min-w-0 space-y-4 px-5 py-6 @container md:px-8 xl:min-h-0 xl:flex-1 xl:overflow-auto">
        {trace.model_requests === "not_recorded" && (
          <Banner tone="info" title="This run's harness keeps no record of each model request">The trace shows its tool calls. The run's cost and how many requests it made are on its Timeline's usage line.</Banner>
        )}
        {missing !== null && missing === openCall?.n && !selected && (
          <Banner tone="info" title="That step's call is not in this trace">{trace.dropped > 0 ? `The trace shows the run's first ${spans.length.toLocaleString("en-US")} requests and calls, and that call came after them.` : "The trace has no call for that step of the recording."}</Banner>
        )}
        {trace.dropped > 0 && <Banner tone="warning">This is the run's first {spans.length.toLocaleString("en-US")} requests and calls. {trace.dropped.toLocaleString("en-US")} later ones are not shown.</Banner>}

        {/* The run in six figures, on one line where there is room: the data under it starts as high as it can. */}
        <dl aria-label="The run in figures" className={cn("grid grid-cols-2 border-l border-t bg-card sm:grid-cols-3", selected ? "2xl:grid-cols-6" : "xl:grid-cols-6")}>
          <Tile label="Model requests" value={trace.model_requests === "not_recorded" ? "–" : totals!.requests} note={trace.model_requests === "not_recorded" ? "Not kept by this harness" : modelNames.length === 1 ? modelNames[0] : modelNames.length ? `${modelNames.length} models` : "None yet"} />
          <Tile label="Tool calls" value={totals!.calls} note={toolNames.size === 1 ? "1 tool" : `${toolNames.size} tools`} />
          <Tile label="Failed" value={totals!.failed} tone={totals!.failed > 0 ? "bad" : undefined} note={firstFailed ? `First: ${firstFailed.name}` : "Nothing failed"} />
          <Tile label="Tokens" value={totals!.tokens ? compact(inputTokens(totals!.tokens) + totals!.tokens.output) : "–"} note={!totals!.tokens ? "No request to count" : `${share !== null ? `${percent(share)} of input read from cache` : "No input reported"}${totals!.untold ? ` · ${totals!.untold} request${totals!.untold === 1 ? "" : "s"} reported none` : ""}`} />
          <Tile label={runUsd === null && known ? "Cost so far" : run.cost && isEstimate(run.cost) ? "Cost, estimated" : "Cost"} value={typeof runUsd === "number" ? dollars(runUsd) : known ? dollars(known.so_far_usd) : "Unknown"} note={ofCap ? `${ofCap} · ${costParts}` : costParts} />
          <Tile label="Time" value={duration(totals!.time.wall)} note={totals!.time.wall > 0 ? `model ${percent(totals!.time.model / totals!.time.wall)} · tools ${percent(totals!.time.tools / totals!.time.wall)}` : "Nothing ran yet"} />
        </dl>

        <div className="flex flex-wrap items-center gap-2">
          <Segmented name="trace-view" label="What the tab shows" size="sm" value={view} onChange={setView} options={[{ value: "calls", label: "Calls" }, { value: "breakdown", label: "Breakdown" }]} />
          {view === "calls" && spans.length > 0 && (
            <ListFilter value={query} onChange={setQuery} label="Filter calls" placeholder="Filter by tool, model or arguments" shown={shown.length} total={spans.length} active={filtered} className="flex-1 gap-2">
              <Segmented name="trace-kind" label="Kind of call" size="sm" value={kind} onChange={setKind}
                options={([["all", "All"], ["model", "Model"], ["tool", "Tools"], ["failed", "Failed"]] as const).map(([value, label]) => ({ value, label: <>{label} <span className="font-normal">{counts[value]}</span></> }))} />
            </ListFilter>
          )}
          <Button size="sm" className="ml-auto" onClick={() => setComparing(true)} title="This run's figures beside another run's">Compare</Button>
          <Button size="sm" onClick={exportJson} title="Save the trace as the server sent it"><Download aria-hidden />Export JSON</Button>
        </div>

        {spans.length === 0 ? (
          // A run whose record keeps no request (a CLI harness's) and called no tool has no span, yet its booking may
          // still have its cost by line.
          <>
            {/* A run can stop short for its budget with no span to show: a CLI harness's record keeps no request, and it may
                answer the wrap-up with no call. Why it stopped is said all the same. */}
            {stopped && (
              <section aria-label="What stands out">
                <Heading level="h2">What stands out</Heading>
                <ul className="grid border-l border-t"><li className="border-b border-r bg-card p-3"><span className="block text-body font-semibold text-destructive-text">{stopped.title}</span><span className="mt-0.5 block text-small text-muted-foreground">{stopped.detail}</span></li></ul>
              </section>
            )}
            {usage?.lines?.length ? <section aria-label="Where the cost went" className="border bg-card p-4"><CostByLine usage={usage} lines={usage.lines} /></section>
              : <p className="border bg-card p-4 font-mono text-body text-muted-foreground">{live ? "No model request has answered and no tool has been called yet." : "This run made no model request and called no tool."}</p>}
            {/* A run can make a computer and end before its first request, and a CLI run's record may keep no call: its
                computers and sessions are listed all the same, against the run's start. */}
            {usage && <Stretches usage={usage} from={Date.parse(run.created_at)} anchor="the run's start" />}
          </>
        ) : view === "breakdown" ? <Breakdown trace={trace} usage={usage} run={run} now={now} onPick={pick} selected={selected?.id ?? null} /> : (
          <>
            <section aria-label="Overview of the run" className="border bg-card">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b px-4 py-1.5">
                <ul className="flex flex-1 flex-wrap gap-x-4 gap-y-1 text-small text-muted-foreground" aria-label="What a bar's colour says">
                  {([["bg-trace-model", "Model request"], ["bg-trace-tool", "Tool call"], [`bg-destructive ${HATCH}`, "Failed"], ...(spans.some((s) => s.status === "running") ? [["bg-run-active", "Running"]] : []), ...(spans.some((s) => s.status === "waiting") ? [[WAITING, "Waiting for a person"]] : []), ...(spans.some((s) => s.status === "refused" || s.status === "interrupted") ? [["bg-muted-foreground", "Refused or interrupted"]] : [])] as [string, string][]).map(([tone, word]) => (
                    <li key={word} className="flex items-center gap-1.5"><Swatch className={tone} />{word}</li>
                  ))}
                </ul>
                <div role="group" aria-label="Zoom the table's time axis" className="flex items-center gap-1">
                  {/* What of the run shows, said as it changes. */}
                  <p role="status" className="mr-1 font-mono text-small text-muted-foreground">{zoomedIn ? `${offset(range.from * window.ms)} to ${offset(range.to * window.ms)}` : ""}</p>
                  {zoomedIn && (
                    <>
                      <Button size="icon" variant="ghost" aria-label="Earlier" title="Earlier" disabled={range.from <= 0} onClick={() => setRange((r) => panned(r, -0.5))}><ChevronLeft aria-hidden /></Button>
                      <Button size="icon" variant="ghost" aria-label="Later" title="Later" disabled={range.to >= 1} onClick={() => setRange((r) => panned(r, 0.5))}><ChevronRight aria-hidden /></Button>
                    </>
                  )}
                  <Button size="icon" variant="ghost" aria-label="Zoom out" title="Zoom out" disabled={!zoomedIn} onClick={() => setRange((r) => zoomed(r, 0.5))}><ZoomOut aria-hidden /></Button>
                  <Button size="icon" variant="ghost" aria-label="Zoom in" title="Zoom in" disabled={range.to - range.from <= 1 / 64} onClick={() => setRange((r) => zoomed(r, 2, about))}><ZoomIn aria-hidden /></Button>
                  <Button size="icon" variant="ghost" aria-label="Fit the whole run" title="Fit the whole run" disabled={!zoomedIn} onClick={() => setRange(WHOLE)}><Maximize2 aria-hidden /></Button>
                </div>
              </div>
              {/* A picture of the run for the eye and the mouse. The table lists every span it draws. */}
              <div className="px-4 pb-2 pt-3" role="img" aria-label={`The run on a time axis: ${totals!.requests} model request${totals!.requests === 1 ? "" : "s"} and ${totals!.calls} tool call${totals!.calls === 1 ? "" : "s"} over ${duration(window.ms)}. The table lists each.${besideWords ? ` Under them, ${besideWords}: the Breakdown lists each.` : ""}`}>
                <Overview marks={marks} view={range} onView={setRange}>
                  {trace.model_requests !== "not_recorded" && <Lane title={`Model requests (${totals!.requests})`} swatch="bg-trace-model" {...lanes.model} selected={selected?.id ?? null} dimmed={(s) => !keeps(s, kind, query)} onPick={pickBar} at={say} />}
                  <Lane title={`Tool calls (${totals!.calls})`} swatch="bg-trace-tool" {...lanes.tool} selected={selected?.id ?? null} dimmed={(s) => !keeps(s, kind, query)} onPick={pickBar} at={say} />
                  {beside.computers.bars.length > 0 && <StretchLane title={`Computers (${beside.computers.bars.length})`} swatch={COMPUTER_TONE} {...beside.computers} now={now} from={window.from} />}
                  {beside.browsers.bars.length > 0 && <StretchLane title={`Browser sessions (${beside.browsers.bars.length})`} swatch={SESSION_TONE} {...beside.browsers} now={now} from={window.from} />}
                </Overview>
                <div className="relative mt-1.5 h-5 border-t">
                  {/* A mark near the right edge writes its label to its left, inside the panel. */}
                  {marks.map((m) => <span key={m.left} className={cn("absolute top-1 whitespace-nowrap font-mono text-label text-muted-foreground", m.left > 94 ? "-translate-x-full pr-1" : "pl-1")} style={{ left: `${m.left}%` }}>{m.label}</span>)}
                </div>
              </div>
            </section>

            {/* `relative`: a cell's hidden words ("None" for a dash) are placed out of the flow, and placed against this box
                they scroll with the table. Placed against the pane, the ones scrolled out of view made the pane itself
                scroll sideways under `xl`, over nothing. */}
            <div className="relative overflow-x-auto border bg-card xl:overflow-visible">
              <table className="w-full text-small">
                <caption className="sr-only">The run's model requests and tool calls. The arrow keys move from row to row; Enter opens a row's details.</caption>
                <thead>
                  <tr>
                    <th scope="col" className={cn(TH, "caps text-left text-label font-normal text-muted-foreground")}>Call</th>
                    {SORTS.map((s) => (
                      <th key={s.id} scope="col" aria-sort={sort === s.id ? (s.id === "started" ? "ascending" : "descending") : "none"} className={cn(TH, "whitespace-nowrap", s.right ? "text-right" : "text-left", s.id === "tokens" && sizeShown)}>
                        <button type="button" onClick={() => setSort(sort === s.id ? "started" : s.id)} title={s.id === "started" ? "In the order they started" : `Sort by ${s.label.toLowerCase()}, most first`}
                          className={cn("caps -my-1.5 inline-flex min-h-6 items-center gap-1 py-1.5 text-label hover:text-foreground", sort === s.id ? "text-foreground" : "text-muted-foreground")}>
                          {s.label}{sort === s.id && s.id !== "started" && <ArrowDown className="size-3" aria-hidden />}
                        </button>
                      </th>
                    )).flatMap((cell, i) => (i === 0 ? [cell, (
                      // Each row's bar on the part of the run that shows: the Started and Duration cells beside it say the same in figures.
                      <th key="axis" scope="col" data-axis className={cn(TH, "hidden w-[30%] min-w-56", axisShown)}>
                        <span className="sr-only">On the time axis</span>
                        <span aria-hidden className="relative block h-4 overflow-hidden">
                          {rowMarks.map((m) => <span key={m.left} className={cn("absolute top-0 whitespace-nowrap font-mono text-label font-normal text-muted-foreground", m.left > 85 ? "-translate-x-full pr-1" : "pl-1")} style={{ left: `${m.left}%` }}>{m.label}</span>)}
                        </span>
                      </th>
                    )] : [cell]))}
                    <th scope="col" className={cn(TH, "caps text-left text-label font-normal text-muted-foreground")}>Status</th>
                  </tr>
                </thead>
                <tbody onKeyDown={moveRow}>
                  {listed.map((span, i) => {
                    const ms = spanMs(span, now);
                    const nested = sort === "started" ? Math.min(2, depth.get(span.id) ?? 0) : 0;
                    const where = place(span, window, range, now);
                    return (
                      <tr key={span.id} ref={(el) => { if (el) rowRefs.current.set(span.id, el); else rowRefs.current.delete(span.id); }} onClick={() => pick(span.id)} className={cn("cursor-pointer border-b last:border-b-0 hover:bg-accent", span.id === selected?.id && "bg-accent")}>
                        <td className={cn("min-w-48 max-w-0 overflow-hidden py-0 pl-1 pr-3", callWidth)}>
                          {/* Its name is what it shows; its time and how it ended, in the cells beside it, describe it. */}
                          <button type="button" tabIndex={span.id === stop ? 0 : -1} aria-pressed={span.id === selected?.id} aria-describedby={`${uid}-d${i} ${uid}-s${i}`} onFocus={() => setCursor(span.id)}
                            className={cn("flex h-control-sm w-full min-w-0 items-center gap-2 text-left font-mono -outline-offset-2", nested === 1 && "pl-4", nested === 2 && "pl-8")}>
                            <span aria-hidden className={cn("trace-mark h-4 w-1 shrink-0", mark(span))} />
                            <span className="caps w-10 shrink-0 text-label text-muted-foreground">{KIND_WORD[span.kind]}</span>
                            <span className="max-w-64 shrink-0 truncate" title={span.name}>{span.name}</span>
                            {(span.input_preview || span.agent_label) && <span className="min-w-0 flex-1 truncate text-muted-foreground">{span.agent_label ? `${span.agent_label} ` : ""}{span.input_preview ?? ""}</span>}
                          </button>
                        </td>
                        <td className="whitespace-nowrap px-3 font-mono text-muted-foreground">{offset(Date.parse(span.started_at) - window.from)}</td>
                        <td aria-hidden data-axis className={cn("hidden px-3 py-0", axisShown)}>
                          <span className="relative block h-control-sm overflow-hidden">
                            {rowMarks.map((m) => <span key={m.left} className="absolute inset-y-0 w-px bg-border" style={{ left: `${m.left}%` }} />)}
                            {where.off === null && <span data-bar className={cn("trace-mark absolute top-1/2 h-2.5 min-w-0.5 -translate-y-1/2", mark(span))} style={{ left: `${where.left}%`, width: `${where.width}%` }} />}
                          </span>
                        </td>
                        <td id={`${uid}-d${i}`} className="whitespace-nowrap px-3 text-right font-mono">{ms !== null ? duration(ms) : NONE}</td>
                        <td className={cn("whitespace-nowrap px-3 text-right font-mono text-muted-foreground", sizeShown)}>{orNone(sizeWords(span))}</td>
                        <td className="whitespace-nowrap px-3 text-right font-mono">{orNone(costWords(span, trace))}</td>
                        <td id={`${uid}-s${i}`} className="px-3"><Chip tone={STATUS[span.status].tone}>{STATUS[span.status].word}</Chip></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {shown.length === 0 && <p className="p-4 text-body text-muted-foreground">{zoomedIn && kind === "all" && query.trim() === "" ? `No call ran in this part of the run. Fit the whole run to see all ${spans.length}.` : `No call matches. Clear the filter to see all ${spans.length}.`}</p>}
              {!whole && shown.length > ROWS && (
                <p className="flex flex-wrap items-center gap-3 border-t p-3 text-body text-muted-foreground">The first {ROWS} of {shown.length.toLocaleString("en-US")} are listed. <Button size="xs" onClick={() => setWhole(true)}>Show all {shown.length.toLocaleString("en-US")}</Button></p>
              )}
            </div>
          </>
        )}
        {comparing && <CompareWith runId={run.run_id} onClose={() => setComparing(false)} />}
        {/* The panel opens beside or under the table, away from where the keyboard is: a screen reader is told. */}
        <p role="status" className="sr-only">{selected ? `Details shown for ${selected.name}. Escape closes them.` : ""}</p>
      </section>
      {selected && <SpanPanel key={selected.id} span={selected} trace={trace} run={run} from={window.from} now={now} reveal={reveal} onPick={pick} onClose={close} onRecording={selected.kind === "tool" ? recorded?.(selected.id) : undefined} />}
    </div>
  );
}
