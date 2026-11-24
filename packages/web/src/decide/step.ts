import type { WebPage } from "../fetch.js";
import type { Page } from "../page.js";
import type { Search } from "../search.js";
import type { Cost, Temperature, Tokens, Verdicts, WebDecider } from "./decider.js";
import { passagesOf } from "./passages.js";

/** What one call's classifier step did. `ran` false: the items passed unsifted, and `error` or `skipped` says why. */
export type DecisionRecord = {
  provider: string;
  op: "search" | "fetch";
  ran: boolean;
  items: { in: number; kept: number };
  dropped: { id: string; score: number | null; reason: string; at?: [number, number] }[];
  model: string | null;
  temperature_sent: Temperature["temperature_sent"];
  /** Unknown after a failure: the request may have gone out with one. */
  temperature_applied: Temperature["temperature_applied"];
  tokens: Tokens | null;
  latency_ms: number;
  cost: Cost;
  questions_sha256: string | null;
  error?: { code: string; message: string };
  skipped?: "no results" | "no page" | "no task";
};

export const DECIDE_MS = 30_000;
/** What stands in the text of a fetched part for each run of passages left out. */
export const LEFT_OUT = "\n…\n";
export type StepOptions = { task?: string | undefined; signal?: AbortSignal | undefined; ms?: number | undefined };

type Sifted<A> = { answer: A; classifier: DecisionRecord };
type Failure = { code: string; message: string; cost: Cost };

// A request refused before it was billed: nothing to book. Any other failure may have been billed.
const UNBILLED = new Set(["configuration", "auth", "rate_limited", "invalid_request", "connection"]);

function costOf(error: Record<string, unknown>, code: string): Cost {
  if (typeof error.costUsd === "number") return { usd: error.costUsd, basis: typeof error.costBasis === "string" ? (error.costBasis as Cost["basis"]) : "estimate" };
  return UNBILLED.has(code) || error.unsent === true ? { usd: 0, basis: "none" } : { usd: null, basis: "unknown" };
}

/** `ask` under the step's deadline and the caller's signal, cut at either whether or not the decider heeds its signal. */
async function bounded(ask: (signal: AbortSignal, ms: number) => Promise<Verdicts>, options: StepOptions): Promise<Verdicts | Failure> {
  const ms = options.ms ?? DECIDE_MS;
  const deadline = AbortSignal.timeout(ms);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  let stop!: (reason: unknown) => void;
  const stopped = new Promise<never>((_, reject) => (stop = reject));
  const onAbort = () => stop(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    if (signal.aborted) throw signal.reason;
    return await Promise.race([ask(signal, ms), stopped]);
  } catch (thrown) {
    const error: Record<string, unknown> = thrown !== null && typeof thrown === "object" ? (thrown as Record<string, unknown>) : {};
    const code = options.signal?.aborted ? "aborted" : deadline.aborted ? "timeout" : typeof error.code === "string" ? error.code : "error";
    const message = String(thrown instanceof Error ? thrown.message : thrown).slice(0, 500);
    const cost = code === "aborted" || code === "timeout" ? { usd: null, basis: "unknown" as const } : costOf(error, code);
    return { code, message, cost };
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

const skipped = (decider: WebDecider, op: DecisionRecord["op"], why: NonNullable<DecisionRecord["skipped"]>, n = 0): DecisionRecord => ({
  provider: decider.id, op, ran: false, items: { in: n, kept: n }, dropped: [], model: null, temperature_sent: null, temperature_applied: false, tokens: null, latency_ms: 0, cost: { usd: 0, basis: "none" }, questions_sha256: null, skipped: why,
});

function failed(decider: WebDecider, op: DecisionRecord["op"], n: number, ms: number, failure: Failure): DecisionRecord {
  const { code, message, cost } = failure;
  return { provider: decider.id, op, ran: false, items: { in: n, kept: n }, dropped: [], model: null, temperature_sent: null, temperature_applied: "unknown", tokens: null, latency_ms: ms, cost, questions_sha256: null, error: { code, message } };
}

function ran(decider: WebDecider, op: DecisionRecord["op"], got: Verdicts, ms: number, dropped: DecisionRecord["dropped"]): DecisionRecord {
  const n = got.verdicts.length;
  return { provider: decider.id, op, ran: true, items: { in: n, kept: n - dropped.length }, dropped, model: got.model, temperature_sent: got.temperature_sent, temperature_applied: got.temperature_applied, tokens: got.tokens, latency_ms: ms, cost: got.cost, questions_sha256: got.questions_sha256 };
}

const since = (start: number) => Math.round(performance.now() - start);

/** A search's results sifted by `decider`: the kept ones in order, and `sift` telling the model what was done. */
export async function siftSearch(decider: WebDecider, answer: Search, options: StepOptions): Promise<Sifted<Search & { sift?: string }>> {
  if ("error" in answer || !answer.results.length) return { answer, classifier: skipped(decider, "search", "no results") };
  const start = performance.now();
  const got = await bounded((signal, ms) => decider.sift(answer.query, answer.results, options.task, { signal, deadlineMs: ms }), options);
  const n = answer.results.length;
  if ("code" in got) return { answer: { ...answer, sift: `not run (${got.code}); these results are unsifted` }, classifier: failed(decider, "search", n, since(start), got) };
  const dropped = answer.results.flatMap((hit, i) => (got.verdicts[i]!.keep ? [] : [{ id: hit.url, score: got.verdicts[i]!.score, reason: got.verdicts[i]!.reason }]));
  const results = answer.results.filter((_, i) => got.verdicts[i]!.keep);
  return { answer: { ...answer, results, sift: `${decider.id} kept ${results.length} of ${n} results` }, classifier: ran(decider, "search", got, since(start), dropped) };
}

/** A fetched part judged by `decider` in passages: the kept ones in order, LEFT_OUT for each run left out, the part's
 *  place in the page (chars, offset, next_offset) unchanged, and `sift` telling the model what was done. */
export async function judgePart(decider: WebDecider, url: string, page: WebPage | Page, options: StepOptions): Promise<Sifted<(WebPage | Page) & { sift?: string }>> {
  if (!page.ok || !page.text) return { answer: page, classifier: skipped(decider, "fetch", "no page") };
  const spans = passagesOf(page.text);
  if (!options.task) return { answer: { ...page, sift: "not run (no task given); this part is whole" }, classifier: skipped(decider, "fetch", "no task", spans.length) };
  const task = options.task;
  const passages = spans.map(([s, e]) => page.text.slice(s, e));
  const start = performance.now();
  const got = await bounded((signal, ms) => decider.judge(url, task, passages, { signal, deadlineMs: ms }), options);
  if ("code" in got) return { answer: { ...page, sift: `not run (${got.code}); this part is whole` }, classifier: failed(decider, "fetch", spans.length, since(start), got) };
  const base = page.offset ?? 0;
  const dropped = spans.flatMap(([s, e], i) => (got.verdicts[i]!.keep ? [] : [{ id: `p${i + 1}`, score: got.verdicts[i]!.score, reason: got.verdicts[i]!.reason, at: [base + s, base + e] as [number, number] }]));
  const kept = spans.length - dropped.length;
  let text = "";
  if (kept) passages.forEach((passage, i) => (text += got.verdicts[i]!.keep ? passage : got.verdicts[i - 1]?.keep === false ? "" : LEFT_OUT));
  const sift = `${decider.id} kept ${kept} of ${spans.length} passages of this part; … marks a passage left out`;
  return { answer: { ...page, text, sift }, classifier: ran(decider, "fetch", got, since(start), dropped) };
}
