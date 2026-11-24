import { type Fee, type Pay, PaidRefused } from "../fees.js";
import type { WebPage } from "../fetch.js";
import type { Page } from "../page.js";
import { QUERY_MAX, type Search } from "../search.js";
import { clip } from "../page.js";
import type { Cost, DecisionPay, Temperature, Tokens, Trimmed, Verdicts, WebDecider } from "./decider.js";
import { codeOf, costOf, unbilled } from "./failure.js";
import { passagesOf } from "./passages.js";

/** How sure a decider must be that an item is not needed before drop leaves it out: when 1 - p(needed) >= it. */
export const THRESHOLD = 0.8;
/** Under rerank+label, the score at least one result must reach for the search not to be called a miss. */
export const LOW_RELEVANCE = 0.3;

/** How a search's results reach the model. "drop": those scored below THRESHOLD are left out, the rest in the
 *  provider's order. "rerank+label": every one is kept, the most relevant first, each with its `relevance`. */
export type DecidePolicy = "drop" | "rerank+label";
const POLICIES: readonly DecidePolicy[] = ["drop", "rerank+label"];
/** `policy`, "drop" when none is given; any other value throws. */
export function policyOf(policy: unknown = "drop"): DecidePolicy {
  if (!POLICIES.includes(policy as DecidePolicy)) throw new RangeError(`the classifier's policy must be "drop" or "rerank+label" (it was ${JSON.stringify(policy)})`);
  return policy as DecidePolicy;
}

/** One item's score as the decider gave it (null: refused): a result by its URL, a passage by its id and its place in
 *  the page. */
export type Scored = { id: string; score: number | null; at?: [number, number] };

/** What one call's classifier step did. `ran` false: the items passed unsifted, and `error` or `skipped` says why.
 *  `scored`: every item asked about, in order, kept or not; none when the step did not run. */
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
  /** The requests sent: 0 when none was (the cap refused it, or nothing was asked). */
  requests: number;
  /** One per request answered, in order. */
  questions_sha256: string[];
  /** The snippets cut so a search's state fits STATE_BUDGET_BYTES; the model still reads them whole. */
  trimmed?: Trimmed;
  error?: { code: string; message: string };
  skipped?: "no results" | "no page" | "no task";
  scored: Scored[];
};

export const DECIDE_MS = 30_000;
/** What stands in the text of a fetched part for each run of passages left out. */
export const LEFT_OUT = "\n…\n";
export type StepOptions = { task?: string | undefined; signal?: AbortSignal | undefined; ms?: number | undefined; pay?: DecisionPay | undefined; policy?: DecidePolicy | undefined };

type Sifted<A> = { answer: A; classifier: DecisionRecord };
type Failure = { code: string; message: string; cost: Cost };

/** `pay` as a decider's: each request's fee goes on `lines` once it is sent, and one refused unbilled settles at $0
 *  (answered as a 4xx, which a cap books at nothing) with a $0 line. */
export const decisionPay = (pay: Pay, lines: Fee[]): DecisionPay => async <T>(fee: Fee, send: () => Promise<T>): Promise<T> => {
  let done: { value: T } | undefined;
  let failed: { error: unknown } | undefined;
  await pay(fee, async () => {
    const at = lines.push(fee) - 1;
    try {
      done = { value: await send() };
      return new Response(null, { status: 200 });
    } catch (error) {
      if (!unbilled(error)) throw error;
      failed = { error };
      lines[at] = { ...fee, usd: 0, basis: `not billed (${codeOf(error)})` };
      return new Response(null, { status: 400 });
    }
  });
  if (done) return done.value;
  throw failed ? failed.error : new PaidRefused(`${fee.name} was not sent`);
};

/** `ask` under the step's deadline and the caller's signal, cut at either whether or not the decider heeds its signal. */
async function bounded(ask: (ctx: { signal: AbortSignal; deadlineMs: number; pay?: DecisionPay }) => Promise<Verdicts>, options: StepOptions): Promise<{ got: Verdicts | Failure; requests: number }> {
  const ms = options.ms ?? DECIDE_MS;
  let requests = 0;
  const pay = options.pay;
  const counted: DecisionPay = (fee, send) => (pay ?? ((_, go) => go()))(fee, () => (requests++, send()));
  const deadline = AbortSignal.timeout(ms);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  let stop!: (reason: unknown) => void;
  const stopped = new Promise<never>((_, reject) => (stop = reject));
  const onAbort = () => stop(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    if (signal.aborted) throw signal.reason;
    return { got: await Promise.race([ask({ signal, deadlineMs: ms, pay: counted }), stopped]), requests };
  } catch (thrown) {
    const code = options.signal?.aborted ? "aborted" : deadline.aborted ? "timeout" : codeOf(thrown);
    const message = String(thrown instanceof Error ? thrown.message : thrown).slice(0, 500);
    const cost = code === "aborted" || code === "timeout" ? { usd: null, basis: "unknown" as const } : costOf(thrown);
    return { got: { code, message, cost }, requests };
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

const skipped = (decider: WebDecider, op: DecisionRecord["op"], why: NonNullable<DecisionRecord["skipped"]>, n = 0): DecisionRecord => ({
  provider: decider.id, op, ran: false, items: { in: n, kept: n }, dropped: [], model: null, temperature_sent: null, temperature_applied: false, tokens: null, latency_ms: 0, cost: { usd: 0, basis: "none" }, requests: 0, questions_sha256: [], skipped: why, scored: [],
});

function failed(decider: WebDecider, op: DecisionRecord["op"], n: number, ms: number, requests: number, failure: Failure): DecisionRecord {
  const { code, message, cost } = failure;
  return { provider: decider.id, op, ran: false, items: { in: n, kept: n }, dropped: [], model: null, temperature_sent: null, temperature_applied: "unknown", tokens: null, latency_ms: ms, cost, requests, questions_sha256: [], error: { code, message }, scored: [] };
}

function ran(decider: WebDecider, op: DecisionRecord["op"], got: Verdicts, ms: number, requests: number, scored: Scored[], dropped: DecisionRecord["dropped"]): DecisionRecord {
  const n = got.verdicts.length;
  const record: Omit<DecisionRecord, "scored"> = { provider: decider.id, op, ran: true, items: { in: n, kept: n - dropped.length }, dropped, model: got.model, temperature_sent: got.temperature_sent, temperature_applied: got.temperature_applied, tokens: got.tokens, latency_ms: ms, cost: got.cost, requests, questions_sha256: got.questions_sha256 };
  if (got.trimmed) record.trimmed = got.trimmed;
  return { ...record, scored };
}

const since = (start: number) => Math.round(performance.now() - start);
const shown = (p: number) => String(Math.round(p * 1000) / 1000);
/** Whether drop leaves out an item scored `score`: never a refused one. */
const drops = (score: number | null) => score !== null && 1 - score >= THRESHOLD;
/** The scored items drop leaves out, as the record names them. */
const droppedOf = (scored: Scored[]): DecisionRecord["dropped"] =>
  scored.flatMap((item) => (drops(item.score) ? [{ id: item.id, score: item.score, reason: `needed p=${shown(item.score!)} <= ${shown(1 - THRESHOLD)}`, ...(item.at ? { at: item.at } : {}) }] : []));

/** A search's results sifted by `decider` under `options.policy` (DecidePolicy), and `sift` telling the model what was
 *  done. The need judged is the task when one is given, else the query (siftRequest). */
export async function siftSearch(decider: WebDecider, answer: Search, options: StepOptions): Promise<Sifted<Search & { sift?: string }>> {
  const policy = policyOf(options.policy);
  if ("error" in answer || !answer.results.length) return { answer, classifier: skipped(decider, "search", "no results") };
  const start = performance.now();
  const { got, requests } = await bounded((ctx) => decider.sift(answer.query, answer.results, options.task, ctx), options);
  const n = answer.results.length;
  if ("code" in got) return { answer: { ...answer, sift: `not run (${got.code}); these results are unsifted` }, classifier: failed(decider, "search", n, since(start), requests, got) };
  const scored: Scored[] = answer.results.map((hit, i) => ({ id: hit.url, score: got.verdicts[i]!.score }));
  if (policy === "rerank+label") return { answer: ranked(decider.id, answer, scored, options.task), classifier: ran(decider, "search", got, since(start), requests, scored, []) };
  const results = answer.results.filter((_, i) => !drops(scored[i]!.score));
  return { answer: { ...answer, results, sift: `${decider.id} kept ${results.length} of ${n} results` }, classifier: ran(decider, "search", got, since(start), requests, scored, droppedOf(scored)) };
}

/** `answer`'s results, every one, the most relevant first (a stable sort: ties in the provider's order, a refused one
 *  last), each scored one with `relevance`, its score to two places; the sift line says so, and that nothing looks
 *  relevant to the need when no result reaches LOW_RELEVANCE. */
function ranked(id: string, answer: Extract<Search, { results: unknown }>, scored: Scored[], task: string | undefined): Search & { sift: string } {
  const results = answer.results
    .map((hit, i) => ({ hit, score: scored[i]!.score }))
    .sort((a, b) => (b.score ?? -1) - (a.score ?? -1))
    .map(({ hit, score }) => (score === null ? hit : { ...hit, relevance: Math.round(score * 100) / 100 }));
  const best = Math.max(...scored.map((item) => item.score ?? 0));
  const miss = best < LOW_RELEVANCE ? `; nothing here looks relevant to ${JSON.stringify(clip(task ?? answer.query, QUERY_MAX))}; consider rephrasing` : "";
  return { ...answer, results, sift: `${id} ordered ${results.length} results by relevance, how likely each holds what the search asks for (0 to 1)${miss}` };
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
  const { got, requests } = await bounded((ctx) => decider.judge(url, task, passages, ctx), options);
  if ("code" in got) return { answer: { ...page, sift: `not run (${got.code}); this part is whole` }, classifier: failed(decider, "fetch", spans.length, since(start), requests, got) };
  const base = page.offset ?? 0;
  const scored: Scored[] = spans.map(([s, e], i) => ({ id: `p${i + 1}`, score: got.verdicts[i]!.score, at: [base + s, base + e] }));
  const dropped = droppedOf(scored);
  const kept = spans.length - dropped.length;
  let text = "";
  if (kept) passages.forEach((passage, i) => (text += !drops(scored[i]!.score) ? passage : i > 0 && drops(scored[i - 1]!.score) ? "" : LEFT_OUT));
  const sift = `${decider.id} kept ${kept} of ${spans.length} passages of this part; … marks a passage left out`;
  return { answer: { ...page, text, sift }, classifier: ran(decider, "fetch", got, since(start), requests, scored, dropped) };
}
