// What every step shares: its record, its bounds (deadline, signal, pay) and the scores' arithmetic.
import { type Fee, type Pay, PaidRefused } from "../fees.js";
import { type Cost, DecideError, type DecisionPay, type Temperature, type Tokens, type Trimmed, type Verdicts, type WebDecider } from "./decider.js";
import { codeOf, costOf, unbilled } from "./failure.js";

/** How sure a decider must be that an item is not needed before drop leaves it out: when 1 - p(needed) >= it. */
export const THRESHOLD = 0.8;
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
export type StepOptions = { task?: string | undefined; signal?: AbortSignal | undefined; ms?: number | undefined; pay?: DecisionPay | undefined };

export type Sifted<A> = { answer: A; classifier: DecisionRecord };
type Failure = { code: string; message: string; cost: Cost };

/** The line a request answered at `cost` (its provider's figure, reported or estimated) is charged on under `fee`: that
 *  cost, never above the hold, the line saying which; `fee`'s own line (the hold) when it gave none. */
const chargedLine = (fee: Fee, cost: Cost | undefined): Fee => {
  // An estimate is charged as a reported cost is, on purpose: it is nearer the real charge than the worst-case hold, and
  // it is never booked above the hold (the cap below).
  if (!cost || (cost.basis !== "reported" && cost.basis !== "estimate") || typeof cost.usd !== "number" || !Number.isFinite(cost.usd) || cost.usd < 0) return fee;
  const said = cost.basis === "reported" ? `the cost ${fee.by} reported` : `${fee.by}'s cost as estimated (it reported none)`;
  return cost.usd <= fee.usd ? { ...fee, usd: cost.usd, basis: said } : { ...fee, basis: `the hold; ${said} was $${cost.usd}` };
};

/** `pay` as a decider's: each request's fee goes on `lines` once it is sent; one answered is charged at the cost its
 *  answer reports (`costOf`), capped at its hold, or at the hold when it reports none, as Pay's `charged` tells the
 *  cap; one refused unbilled settles at $0 (answered as a 4xx, which a cap books at nothing). Its line becomes that
 *  charge (chargedLine; a $0 line) only once the cap's settle is written, so the receipt says what the cap booked: a
 *  settle that failed (Pay's `settled`) leaves the line at the hold, as the cap keeps it. */
export const decisionPay = (pay: Pay, lines: Fee[]): DecisionPay => async <T>(fee: Fee, send: () => Promise<T>, costOf?: (answer: T) => Cost): Promise<T> => {
  let done: { value: T } | undefined;
  let failed: { error: unknown } | undefined;
  let charge = fee.usd;
  let at = -1;
  let line: Fee | undefined;
  let booked = true;
  await pay(fee, async () => {
    at = lines.push(fee) - 1;
    try {
      done = { value: await send() };
      line = chargedLine(fee, costOf?.(done.value));
      charge = line.usd;
      return new Response(null, { status: 200 });
    } catch (error) {
      if (!unbilled(error)) throw error;
      failed = { error };
      line = { ...fee, usd: 0, basis: `not billed (${codeOf(error)})` };
      return new Response(null, { status: 400 });
    }
  }, () => charge, (landed) => { booked = landed; });
  if (line) lines[at] = booked ? line : { ...fee, basis: `${fee.basis}; its settle failed, so the hold stands, not $${line.usd} (${line.basis})` };
  if (done) return done.value;
  throw failed ? failed.error : new PaidRefused(`${fee.name} was not sent`);
};

/** The codes that refuse the decider's key (`auth`) or its account (`payment_required`): every later request would be
 *  refused too, so heldOnRefusal holds the decider after one. An outage is not among them. */
const KEY_REFUSALS = new Set(["auth", "payment_required"]);

/** `decider`, held once it refuses its key or its account (KEY_REFUSALS): every later step asks it nothing and fails
 *  as `held`, unsent and so unbilled, its sift saying "not run (held)". One per Web: serve's is the run's. */
export function heldOnRefusal(decider: WebDecider): WebDecider {
  let refused: string | undefined;
  const watched = <A extends unknown[], R>(ask: (...args: A) => Promise<R>) => async (...args: A): Promise<R> => {
    if (refused) throw Object.assign(new DecideError("held", `${decider.id} is held: it refused this Web earlier (${refused})`), { unsent: true });
    try {
      return await ask(...args);
    } catch (error) {
      if (KEY_REFUSALS.has(codeOf(error))) refused ??= codeOf(error);
      throw error;
    }
  };
  // Each step the decider has, watched (a decider made for one step may lack the others).
  return { ...decider, id: decider.id, ...(decider.sift ? { sift: watched(decider.sift.bind(decider)) } : {}), ...(decider.judge ? { judge: watched(decider.judge.bind(decider)) } : {}), ...(decider.guard ? { guard: watched(decider.guard.bind(decider)) } : {}) };
}

/** `ask` under the step's deadline and the caller's signal, cut at either whether or not the decider heeds its signal. */
export async function bounded<T>(ask: (ctx: { signal: AbortSignal; deadlineMs: number; pay?: DecisionPay }) => Promise<T>, options: StepOptions): Promise<{ got: T | Failure; requests: number }> {
  const ms = options.ms ?? DECIDE_MS;
  let requests = 0;
  const pay = options.pay;
  const counted: DecisionPay = (fee, send, costOf) => (pay ?? ((_, go) => go()))(fee, () => (requests++, send()), costOf);
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

export const skipped = (decider: WebDecider, op: DecisionRecord["op"], why: NonNullable<DecisionRecord["skipped"]>, n = 0): DecisionRecord => ({
  provider: decider.id, op, ran: false, items: { in: n, kept: n }, dropped: [], model: null, temperature_sent: null, temperature_applied: false, tokens: null, latency_ms: 0, cost: { usd: 0, basis: "none" }, requests: 0, questions_sha256: [], skipped: why, scored: [],
});

export function failed(decider: WebDecider, op: DecisionRecord["op"], n: number, ms: number, requests: number, failure: Failure): DecisionRecord {
  const { code, message, cost } = failure;
  return { provider: decider.id, op, ran: false, items: { in: n, kept: n }, dropped: [], model: null, temperature_sent: null, temperature_applied: "unknown", tokens: null, latency_ms: ms, cost, requests, questions_sha256: [], error: { code, message }, scored: [] };
}

export function ran(decider: WebDecider, op: DecisionRecord["op"], got: Verdicts, ms: number, requests: number, scored: Scored[], dropped: DecisionRecord["dropped"], kept = got.verdicts.length - dropped.length): DecisionRecord {
  const n = got.verdicts.length;
  const record: Omit<DecisionRecord, "scored"> = { provider: decider.id, op, ran: true, items: { in: n, kept }, dropped, model: got.model, temperature_sent: got.temperature_sent, temperature_applied: got.temperature_applied, tokens: got.tokens, latency_ms: ms, cost: got.cost, requests, questions_sha256: got.questions_sha256 };
  if (got.trimmed) record.trimmed = got.trimmed;
  return { ...record, scored };
}

export const since = (start: number) => Math.round(performance.now() - start);
export const threePlaces = (p: number) => String(Math.round(p * 1000) / 1000);
export const twoPlaces = (p: number) => Math.round(p * 100) / 100;
/** Highest score first, a refused one (null) after every scored one; ties are left to the sort's stability. */
export const byScore = (a: number | null, b: number | null) => (b ?? -1) - (a ?? -1);
/** An item's label under label, rerank+label and looking_for: `relevance`, its score to two places; none where refused. */
export const relevanceOf = (score: number | null): { relevance?: number } => (score === null ? {} : { relevance: twoPlaces(score) });
/** Whether drop leaves out an item scored `score`: never a refused one. */
export const drops = (score: number | null) => score !== null && 1 - score >= THRESHOLD;
/** The scored items drop leaves out, as the record names them. */
export const droppedOf = (scored: Scored[]): DecisionRecord["dropped"] =>
  scored.flatMap((item) => (drops(item.score) ? [{ id: item.id, score: item.score, reason: `needed p=${threePlaces(item.score!)} <= ${threePlaces(1 - THRESHOLD)}`, ...(item.at ? { at: item.at } : {}) }] : []));

/** What the step adds to an answer: `sift`, what it did. */
export type Sift = { sift?: string };
