// A run's trace (GET /v2/runs/{id}/trace) as the Dev tools tab reads it: where each span sits on the time axis, what the
// run's requests and calls add up to, and the same broken down by tool and by model. Every figure here is a sum, a share
// or a rank of what the server sent; a figure the trace does not carry stays unknown (null), never 0.
import type { RunTrace, TraceSpan } from "./v2";

export type SpanKind = "all" | "model" | "tool" | "failed";
export type SpanSort = "started" | "duration" | "cost" | "tokens";

const at = (iso: string) => Date.parse(iso);

/** How long a span took, in ms: null for one with no end the trace knows (a model request with no duration), unless
 *  `now` is given and it still runs or waits, when it is its time so far. */
export function spanMs(span: TraceSpan, now?: number): number | null {
  if (span.ended_at) return Math.max(0, at(span.ended_at) - at(span.started_at));
  return now !== undefined && (span.status === "running" || span.status === "waiting") ? Math.max(0, now - at(span.started_at)) : null;
}

/** A length of time as a person reads it: "27 ms", "3.5 s", "1m 02s", "2h 05m". */
export function duration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const s = Math.round(ms / 1000);
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
}

/** A time since the trace began, as the axis and the table say it: "+0:08.5", "+1:02:07". */
export function offset(ms: number): string {
  const t = Math.max(0, ms);
  if (t >= 3_600_000) {
    const s = Math.floor(t / 1000);
    return `+${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  }
  const tenths = Math.floor(t / 100);
  return `+${Math.floor(tenths / 600)}:${String(Math.floor((tenths % 600) / 10)).padStart(2, "0")}.${tenths % 10}`;
}

/** A model request's input: what it read fresh, read from cache and wrote to cache. */
export const inputTokens = (t: NonNullable<TraceSpan["tokens"]>) => t.input + t.cache_read + t.cache_write;
/** The share of an input that was read from cache, 0 to 1; null for no input. */
export const cacheShare = (t: Pick<NonNullable<TraceSpan["tokens"]>, "input" | "cache_read" | "cache_write">) => {
  const all = t.input + t.cache_read + t.cache_write;
  return all > 0 ? t.cache_read / all : null;
};
/** A share as a whole percent; one too small or too near the whole to round says so ("<1%", "99%"), never 0% or 100%. */
export const percent = (share: number) => (share > 0 && share < 0.005 ? "<1%" : `${share >= 0.995 && share < 1 ? "99" : Math.round(share * 100)}%`);

/** The time the trace covers: from its first span's start to its last span's end (`now` for one still going). */
export function traceWindow(spans: readonly TraceSpan[], now: number): { from: number; to: number; ms: number } {
  if (!spans.length) return { from: now, to: now, ms: 0 };
  let [from, to] = [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];
  for (const span of spans) {
    const start = at(span.started_at);
    from = Math.min(from, start);
    to = Math.max(to, start + (spanMs(span, now) ?? 0));
  }
  return { from, to, ms: Math.max(0, to - from) };
}

export type Bar = { span: TraceSpan; left: number; width: number; row: number };
/** Each span's place on its lane, in percent of the window: spans that overlap in time go on rows of their own, the
 *  earliest on the first row that is free. `gap`: the least space between two bars on one row, in percent. */
export function lane(spans: readonly TraceSpan[], window: { from: number; ms: number }, now: number, gap = 0.2): { bars: Bar[]; rows: number } {
  const ends: number[] = [];
  const bars = [...spans].sort((a, b) => at(a.started_at) - at(b.started_at)).map((span) => {
    const left = window.ms > 0 ? ((at(span.started_at) - window.from) / window.ms) * 100 : 0;
    const width = window.ms > 0 ? ((spanMs(span, now) ?? 0) / window.ms) * 100 : 100;
    let row = ends.findIndex((end) => end + gap <= left);
    if (row < 0) row = ends.push(0) - 1;
    ends[row] = left + width;
    return { span, left, width, row };
  });
  return { bars, rows: Math.max(1, ends.length) };
}

const STEPS = [100, 200, 500, 1000, 2000, 5000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000, 600_000, 900_000, 1_800_000, 3_600_000, 7_200_000, 14_400_000, 28_800_000, 86_400_000];
/** The axis's marks for a window of `ms`: at most `most`, at a round step, each with its place in percent and its label
 *  (seconds with a decimal under a second's step, else minutes and seconds, or hours). */
export function ticks(ms: number, most = 8): { left: number; label: string }[] {
  if (ms <= 0) return [{ left: 0, label: "0:00" }];
  const step = STEPS.find((s) => ms / s <= most) ?? Math.ceil(ms / most / 86_400_000) * 86_400_000;
  const label = (t: number) => {
    if (step < 1000) return `${(t / 1000).toFixed(1)}s`;
    const s = Math.round(t / 1000);
    return s >= 3600 ? `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };
  const out: { left: number; label: string }[] = [];
  for (let t = 0; t <= ms; t += step) out.push({ left: (t / ms) * 100, label: label(t) });
  return out;
}

/** How long a set of spans covers, each moment counted once however many spans hold it. */
function covered(spans: readonly TraceSpan[], now: number): number {
  const ranges = spans.map((span) => [at(span.started_at), at(span.started_at) + (spanMs(span, now) ?? 0)] as const).sort((a, b) => a[0] - b[0]);
  let [total, end] = [0, Number.NEGATIVE_INFINITY];
  for (const [from, to] of ranges) {
    if (to <= end) continue;
    total += to - Math.max(from, end);
    end = to;
  }
  return total;
}

/** A sum of dollars where some may be unknown: what is known, and how many are not. */
export type Spend = { usd: number; unknown: number };
const spend = (values: readonly (number | null)[]): Spend => ({ usd: values.reduce<number>((sum, v) => sum + (v ?? 0), 0), unknown: values.filter((v) => v === null).length });

export type TokenSum = { input: number; cache_read: number; cache_write: number; output: number; reasoning: number };
const tokenSum = (spans: readonly TraceSpan[]): TokenSum => spans.reduce((sum, { tokens: t }) => (t ? {
  input: sum.input + t.input, cache_read: sum.cache_read + t.cache_read, cache_write: sum.cache_write + t.cache_write, output: sum.output + t.output, reasoning: sum.reasoning + (t.reasoning ?? 0),
} : sum), { input: 0, cache_read: 0, cache_write: 0, output: 0, reasoning: 0 });

export type TraceTotals = {
  requests: number; calls: number; failed: number;
  /** The requests' tokens, and how many requests reported none. Null when the trace has no request. */
  tokens: TokenSum | null; untold: number;
  /** What the requests cost and what was charged under the calls. `requests` is null when no request has a cost of its
   *  own (a CLI harness's, a workflow's model nodes': the run's cost is its booking's). A workflow's decisions have
   *  theirs: their sum, a decision with no known cost counted unknown, and nothing counted for the model nodes'
   *  requests, which carry none by design. */
  cost: { requests: Spend | null; charges: Spend; charged: number; notMetered: number };
  /** Where the time went: a model answering, a tool running with no model answering, and neither. */
  time: { wall: number; model: number; tools: number; other: number };
};

export function traceTotals(trace: Pick<RunTrace, "spans" | "model_requests">, now: number): TraceTotals {
  const models = trace.spans.filter((s) => s.kind === "model");
  const tools = trace.spans.filter((s) => s.kind === "tool");
  const window = traceWindow(trace.spans, now);
  const [all, model] = [covered(trace.spans, now), covered(models, now)];
  const charged = tools.filter((s) => s.charged);
  return {
    requests: models.length, calls: tools.length, failed: trace.spans.filter((s) => s.status === "failed").length,
    tokens: models.length ? tokenSum(models) : null, untold: models.filter((s) => !s.tokens).length,
    cost: { requests: !models.length ? null : trace.model_requests === "priced" ? spend(models.map((s) => s.usd)) : models.some((s) => s.decision) ? spend(models.filter((s) => s.decision).map((s) => s.usd)) : null, charges: spend(charged.map((s) => s.usd)), charged: charged.length, notMetered: tools.filter((s) => s.not_metered).length },
    time: { wall: window.ms, model, tools: Math.max(0, all - model), other: Math.max(0, window.ms - all) },
  };
}

/** The value `p` (0 to 1) of the way through `sorted` (ascending): the nearest rank. */
export const percentile = (sorted: readonly number[], p: number): number | null => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))]! : null);

export type ToolRow = { name: string; calls: number; failed: number; totalMs: number; p50: number | null; p95: number | null; maxMs: number | null; charges: Spend; charged: number; bytes: number };
/** The run's tool calls by tool: how many, how many failed, the time they took together and at the middle, the 95th
 *  percentile and the most, what was charged, and what they returned. The tool that took the most time first. */
export function byTool(spans: readonly TraceSpan[], now: number): ToolRow[] {
  const groups = new Map<string, TraceSpan[]>();
  for (const span of spans) if (span.kind === "tool") groups.set(span.name, [...(groups.get(span.name) ?? []), span]);
  return [...groups].map(([name, group]) => {
    const took = group.map((s) => spanMs(s, now)).filter((ms): ms is number => ms !== null).sort((a, b) => a - b);
    const charged = group.filter((s) => s.charged);
    return {
      name, calls: group.length, failed: group.filter((s) => s.status === "failed").length, totalMs: took.reduce((a, b) => a + b, 0),
      p50: percentile(took, 0.5), p95: percentile(took, 0.95), maxMs: took.at(-1) ?? null,
      charges: spend(charged.map((s) => s.usd)), charged: charged.length, bytes: group.reduce((sum, s) => sum + (s.result_size_bytes ?? 0), 0),
    };
  }).sort((a, b) => b.totalMs - a.totalMs || b.calls - a.calls || a.name.localeCompare(b.name));
}

export type ModelRow = { name: string; requests: number; failed: number; tokens: TokenSum; cache: number | null; cost: Spend | null; totalMs: number; p50: number | null; p95: number | null; perSecond: number | null };
/** The run's model requests by model: how many, their tokens and the share read from cache, their cost, the time they
 *  took (together, at the middle and at the 95th percentile), their cost where they have one of their own (`priced`:
 *  every request of the run does; else a workflow's decisions alone, and `cost` is null for a model with none), and how
 *  fast each wrote (output tokens a second, over the requests whose time is known). */
export function byModel(spans: readonly TraceSpan[], priced = true): ModelRow[] {
  const groups = new Map<string, TraceSpan[]>();
  for (const span of spans) if (span.kind === "model") groups.set(span.name, [...(groups.get(span.name) ?? []), span]);
  return [...groups].map(([name, group]) => {
    const tokens = tokenSum(group);
    // The requests that have a cost of their own: all of a priced run's, a workflow's decisions alone.
    const costed = priced ? group : group.filter((s) => s.decision);
    const timed = group.filter((s) => s.tokens && (spanMs(s) ?? 0) > 0);
    const took = group.map((s) => spanMs(s)).filter((ms): ms is number => ms !== null).sort((a, b) => a - b);
    const ms = timed.reduce((sum, s) => sum + spanMs(s)!, 0);
    return {
      name, requests: group.length, failed: group.filter((s) => s.status === "failed").length, tokens, cache: cacheShare(tokens), cost: costed.length ? spend(costed.map((s) => s.usd)) : null,
      totalMs: took.reduce((a, b) => a + b, 0), p50: percentile(took, 0.5), p95: percentile(took, 0.95), perSecond: ms > 0 ? timed.reduce((sum, s) => sum + s.tokens!.output, 0) / (ms / 1000) : null,
    };
  }).sort((a, b) => b.requests - a.requests || a.name.localeCompare(b.name));
}

/** Whether a span is one the filter and the words typed keep: by its kind (`failed`: one that failed), and by its name,
 *  its subagent or its arguments holding every word typed. */
export function keeps(span: TraceSpan, kind: SpanKind, query: string): boolean {
  if (kind === "failed" ? span.status !== "failed" : kind !== "all" && span.kind !== kind) return false;
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const text = `${span.name} ${span.agent_label ?? ""} ${span.input_preview ?? ""} ${span.status}`.toLowerCase();
  return words.every((word) => text.includes(word));
}

/** `spans` in the table's order: as they started, or the longest, the dearest or the largest first (one with no such
 *  figure last, in the order it started). A request's size is its tokens and a call's is its result's bytes, which no
 *  one order compares: by size, the requests come first, largest first, then the calls, largest first. */
export function ordered(spans: readonly TraceSpan[], sort: SpanSort, now: number): TraceSpan[] {
  const started = [...spans].sort((a, b) => at(a.started_at) - at(b.started_at));
  if (sort === "started") return started;
  const size = (s: TraceSpan): number | null => (s.tokens ? inputTokens(s.tokens) + s.tokens.output : s.kind === "tool" ? s.result_size_bytes : null);
  const figure = (s: TraceSpan): number | null => (sort === "duration" ? spanMs(s, now) : sort === "cost" ? s.usd : size(s));
  // Requests before calls only where the figures are of two kinds (size); else one order for all.
  const group = (s: TraceSpan) => (sort === "tokens" && s.kind === "tool" ? 1 : 0);
  // A stable sort: spans with the same figure, and those with none, keep the order they started in.
  return started.map((span) => ({ span, n: figure(span) })).sort((a, b) => group(a.span) - group(b.span) || (b.n ?? -1) - (a.n ?? -1)).map(({ span }) => span);
}

/** A span's dollars to the ten-thousandth, as a person who tunes a run reads them: "$0", "<$0.0001", "$0.0884", "$1.25". */
export const usd = (n: number) => (n === 0 ? "$0" : n < 0.0001 ? "<$0.0001" : n < 1 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);

/** Where the run's known cost went: each model's requests, then what was charged under its calls, the largest first.
 *  Null when nothing in the trace has a known cost; a total of $0 when everything it knows the cost of was free. */
export function costSplit(spans: readonly TraceSpan[]): { parts: { name: string; kind: TraceSpan["kind"]; usd: number }[]; total: number } | null {
  const models = new Map<string, number>();
  let [tools, known] = [0, false];
  for (const span of spans) {
    if (span.usd === null) continue;
    known = true;
    if (span.kind === "tool") tools += span.usd;
    else models.set(span.name, (models.get(span.name) ?? 0) + span.usd);
  }
  const parts = [...[...models].map(([name, usd]) => ({ name, kind: "model" as const, usd })).sort((a, b) => b.usd - a.usd), ...(tools > 0 ? [{ name: "Tool charges", kind: "tool" as const, usd: tools }] : [])];
  const total = parts.reduce((all, part) => all + part.usd, 0);
  return known ? { parts, total } : null;
}

/** One thing about the run worth a look, with the span it is about. */
export type Finding = { id: string; title: string; detail: string; span?: string; bad?: boolean };
/** What stands out in a trace, most pressing first: what failed, the call and the request that took the longest, the
 *  request that cost the most, how much input came from cache, the largest result (it becomes input
 *  to every request after it), and time spent between calls. Each is a figure of the trace, never advice. */
export function findings(trace: Pick<RunTrace, "spans" | "model_requests">, now: number): Finding[] {
  const { spans } = trace;
  const totals = traceTotals(trace, now);
  const out: Finding[] = [];
  const longest = (kind: TraceSpan["kind"]) => spans.filter((s) => s.kind === kind && spanMs(s, now) !== null).sort((a, b) => spanMs(b, now)! - spanMs(a, now)!)[0];
  const ofWall = (ms: number) => (totals.time.wall > 0 ? ` · ${percent(ms / totals.time.wall)} of the run's time` : "");
  const failed = spans.filter((s) => s.status === "failed");
  if (failed.length) {
    const names = [...new Set(failed.map((s) => s.name))];
    out.push({ id: "failed", bad: true, span: failed[0]!.id, title: failed.length === 1 ? `1 call failed: ${failed[0]!.name}` : `${failed.length} calls failed`, detail: failed.length === 1 ? `At ${offset(at(failed[0]!.started_at) - traceWindow(spans, now).from)}.${spans.some((s) => at(s.started_at) > at(failed[0]!.started_at)) ? " The run went on after it." : " Nothing ran after it."}` : names.slice(0, 4).join(", ") + (names.length > 4 ? ` and ${names.length - 4} more` : "") });
  }
  const call = longest("tool");
  if (call) out.push({ id: "slowest-call", span: call.id, title: `Slowest call: ${call.name}`, detail: `${duration(spanMs(call, now)!)}${ofWall(spanMs(call, now)!)}${call.status === "waiting" ? " · waiting for a person" : ""}` });
  const request = longest("model");
  if (request) out.push({ id: "slowest-request", span: request.id, title: `Longest request: ${duration(spanMs(request, now)!)}`, detail: `${request.name}${request.tokens ? ` · wrote ${request.tokens.output.toLocaleString("en-US")} tokens` : ""}${ofWall(spanMs(request, now)!)}` });
  const priced = spans.filter((s) => s.kind === "model" && s.usd !== null);
  const dearest = [...priced].sort((a, b) => b.usd! - a.usd!)[0];
  const requestsUsd = priced.reduce((sum, s) => sum + s.usd!, 0);
  if (dearest && priced.length > 1 && dearest.usd! > 0) out.push({ id: "dearest", span: dearest.id, title: `Most expensive request: ${usd(dearest.usd!)}`, detail: `${percent(dearest.usd! / requestsUsd)} of what the requests cost${dearest.tokens ? ` · ${inputTokens(dearest.tokens).toLocaleString("en-US")} tokens in, ${dearest.tokens.output.toLocaleString("en-US")} out` : ""}` });
  const share = totals.tokens ? cacheShare(totals.tokens) : null;
  if (share !== null) {
    const cold = spans.filter((s) => s.kind === "model" && s.tokens && s.tokens.cache_read === 0).length;
    out.push({ id: "cache", title: `${percent(share)} of input was read from cache`, detail: `${totals.tokens!.cache_read.toLocaleString("en-US")} of ${inputTokens(totals.tokens!).toLocaleString("en-US")} input tokens. ${cold === 0 ? "Every request read from cache." : `${cold} of ${totals.requests} request${totals.requests === 1 ? "" : "s"} read nothing from cache.`}` });
  }
  const largest = spans.filter((s) => s.kind === "tool" && (s.result_size_bytes ?? 0) >= 8 * 1024).sort((a, b) => b.result_size_bytes! - a.result_size_bytes!)[0];
  if (largest) out.push({ id: "largest", span: largest.id, title: `Largest result: ${largest.name}`, detail: `${Math.round(largest.result_size_bytes! / 1024).toLocaleString("en-US")} KB, which is input to every request after it.` });
  if (totals.time.wall > 0 && totals.time.other / totals.time.wall >= 0.25) out.push({ id: "between", title: `${percent(totals.time.other / totals.time.wall)} of the run was between calls`, detail: `${duration(totals.time.other)} with no model answering and no tool running: waiting for a person or its turn, or the harness working.` });
  if (totals.cost.charges.unknown > 0) out.push({ id: "unknown-charges", title: `${totals.cost.charges.unknown} charge${totals.cost.charges.unknown === 1 ? "" : "s"} of an unknown amount`, detail: "The run's cost is unknown until each is priced." });
  return out;
}
