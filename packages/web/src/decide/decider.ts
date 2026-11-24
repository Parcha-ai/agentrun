// Every provider is asked the same questions in the same words, so the arms differ only in who answers them.
import { createHash } from "node:crypto";
import type { Fee } from "../fees.js";
import type { Hit } from "../search.js";
import { codeOf, costOf, costTogether } from "./failure.js";

export type Verdict = { keep: boolean; score: number | null; reason: string };
/** "counted": the provider reported none, and the request's text was counted by the host's counter. */
export type Tokens = { in: number; out: number | null; basis: "reported" | "counted" };
/** "none": nothing was billed (the request was never sent, or refused unanswered). usd is null only when unknown. */
export type Cost = { usd: number | null; basis: "reported" | "estimate" | "unknown" | "none" };
/** What the provider says its request carried: a provider that says nothing sent no temperature. */
export type Temperature = { temperature_sent: number | null; temperature_applied: boolean | "unknown" };
/** Every snippet longer than `to_chars` cut to it: `snippets` of them. */
export type Trimmed = { snippets: number; to_chars: number };
/** One verdict per item asked about, in order, and one questions hash per request; model and temperature are the
 *  first request's. */
export type Verdicts = { verdicts: Verdict[]; model: string | null; tokens: Tokens | null; cost: Cost; questions_sha256: string[]; trimmed?: Trimmed } & Temperature;
/** How a decider's request is paid: `send` once the run's cap admits `fee`, as web's Pay sends a provider's request. */
export type DecisionPay = <T>(fee: Fee, send: () => Promise<T>) => Promise<T>;
/** `pay` absent: the request is sent unmetered. */
export type DecideContext = { signal: AbortSignal; deadlineMs: number; pay?: DecisionPay };

export interface WebDecider {
  readonly id: string;
  sift(query: string, hits: readonly Hit[], task: string | undefined, ctx: DecideContext): Promise<Verdicts>;
  judge(url: string, task: string, passages: readonly string[], ctx: DecideContext): Promise<Verdicts>;
}

/** A decider's failure: `code` as the DSL's DecisionProviderError names it, and what a billed request cost. */
export class DecideError extends Error {
  override readonly name = "DecideError";
  constructor(readonly code: string, message: string, readonly costUsd?: number | null, readonly costBasis?: Cost["basis"]) {
    super(message);
  }
}

export type NoulQuestion = { type: "noul"; instructions: string; criteria: { true: string; false: string } };
export type DecisionAsk = { label: string; kind: "sift" | "judge"; state: unknown; questions: Record<string, NoulQuestion>; model?: string };
/** The part of the DSL's DecisionProvider a decider calls: its DecisionProvider satisfies this as it is. */
export interface DecisionAsker {
  readonly id: string;
  decide(request: DecisionAsk, ctx: { decisionId: string; signal: AbortSignal; deadlineMs: number | null }): Promise<{
    answers: Record<string, unknown>;
    model: string | null;
    usage: { input_tokens: number; output_tokens: number } | null;
    cost_usd: number | null;
    cost_basis: "reported" | "estimate" | "unknown";
    temperature_sent?: number | null;
    temperature_applied?: boolean | "unknown";
  }>;
}

export const siftQuestion = (id: string): NoulQuestion => ({
  type: "noul",
  instructions: `Does search result ${id} hold, or point to, information the request needs? The request is the state's task when it gives one, else its query.`,
  criteria: { true: "it holds or points to information the request needs", false: "it is off the request's topic, or holds nothing the request needs" },
});
export const judgeQuestion = (id: string): NoulQuestion => ({
  type: "noul",
  instructions: `Does passage ${id} of the page hold information the task needs?`,
  criteria: { true: "it states facts, figures, names or dates the task needs, or context needed to read them", false: "it is navigation, boilerplate, or text the task does not need" },
});

const keyed = <T>(prefix: string, items: readonly T[], first: number): Record<string, T> => Object.fromEntries(items.map((item, i) => [`${prefix}${first + i}`, item]));
const questionsFor = (prefix: string, n: number, first: number, question: (id: string) => NoulQuestion) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`${prefix}${first + i}`, question(`${prefix}${first + i}`)]));

/** `first`: the id number of the first item, so a list asked in several requests keeps one id per item. */
export function siftRequest(query: string, hits: readonly Hit[], task?: string, first = 1): DecisionAsk {
  return { label: "web_search sift", kind: "sift", state: { query, ...(task ? { task } : {}), results: keyed("r", hits, first) }, questions: questionsFor("r", hits.length, first, siftQuestion) };
}
export function judgeRequest(url: string, task: string, passages: readonly string[], first = 1): DecisionAsk {
  return { label: "web_fetch passages", kind: "judge", state: { url, task, passages: keyed("p", passages, first) }, questions: questionsFor("p", passages.length, first, judgeQuestion) };
}

/** The most bytes of state one request carries: within the least any provider takes (Parallel's 96,000), so every
 *  provider is sent the same states. */
export const STATE_BUDGET_BYTES = 90_000;
/** The most questions one request asks: within the fewest any provider takes (Parallel's 100). */
export const QUESTIONS_PER_REQUEST = 100;

const stateBytes = (request: DecisionAsk) => Buffer.byteLength(JSON.stringify(request.state));
const fits = (request: DecisionAsk) => stateBytes(request) <= STATE_BUDGET_BYTES;

/** `text` cut to at most `chars` UTF-16 units, never between the halves of a surrogate pair. */
function cutAt(text: string, chars: number): string {
  if (text.length <= chars) return text;
  const last = text.charCodeAt(chars - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? chars - 1 : chars);
}

/** A search whose state is over the budget with every snippet cut to the longest length at which it fits, if one does. */
function trimmedSearch(query: string, hits: readonly Hit[], task: string | undefined): { hits: readonly Hit[]; trimmed?: Trimmed } {
  if (fits(siftRequest(query, hits, task))) return { hits };
  const cut = (chars: number) => hits.map((hit) => (hit.snippet.length > chars ? { ...hit, snippet: cutAt(hit.snippet, chars) } : hit));
  if (!fits(siftRequest(query, cut(0), task))) return { hits };
  let fitting = 0;
  let over = Math.max(...hits.map((hit) => hit.snippet.length));
  while (over - fitting > 1) {
    const mid = Math.floor((fitting + over) / 2);
    if (fits(siftRequest(query, cut(mid), task))) fitting = mid;
    else over = mid;
  }
  return { hits: cut(fitting), trimmed: { snippets: hits.filter((hit) => hit.snippet.length > fitting).length, to_chars: fitting } };
}

/** `items` asked in order in as few requests as each fit the budget and QUESTIONS_PER_REQUEST: an item over the budget
 *  alone is asked alone. */
function requestsOf<T>(items: readonly T[], request: (items: readonly T[], first: number) => DecisionAsk): DecisionAsk[] {
  const whole = request(items, 1);
  if (items.length <= QUESTIONS_PER_REQUEST && fits(whole)) return [whole];
  const requests: DecisionAsk[] = [];
  for (let start = 0; start < items.length; ) {
    let end = start + 1;
    while (end < items.length && end - start < QUESTIONS_PER_REQUEST && fits(request(items.slice(start, end + 1), start + 1))) end++;
    requests.push(request(items.slice(start, end), start + 1));
    start = end;
  }
  return requests;
}

function tokensTogether(a: Tokens | null, b: Tokens | null): Tokens | null {
  if (!a || !b) return null;
  return { in: a.in + b.in, out: a.out === null || b.out === null ? null : a.out + b.out, basis: a.basis === "reported" && b.basis === "reported" ? "reported" : "counted" };
}

/** How sure a decider must be that an item is not needed before it is dropped: dropped when 1 - p(needed) >= it. */
export const THRESHOLD = 0.8;

/** A provider's published price, as a request is held to it before it is sent: a fee per request, and per million
 *  tokens in and out (the long rates past `longPromptTokens` input tokens). The input is bounded by the request's
 *  UTF-8 bytes, times `inputTokensPerByte` (1: a token is at least a byte), plus `extraInputTokens` the provider adds
 *  (its own prompt); the output by `maxOutputTokens`. */
export type DecisionPrice = {
  requestUsd?: number;
  inputUsdPerMillionTokens?: number;
  outputUsdPerMillionTokens?: number;
  maxOutputTokens?: number;
  inputTokensPerByte?: number;
  extraInputTokens?: number;
  longPromptTokens?: number;
  longInputUsdPerMillionTokens?: number;
  longOutputUsdPerMillionTokens?: number;
};

/** The most a request of `bytes` may cost at `price`, rounded up to a millionth of a dollar. */
export function holdOf(price: DecisionPrice, bytes: number): number {
  const tokens = Math.ceil(bytes * (price.inputTokensPerByte ?? 1)) + (price.extraInputTokens ?? 0);
  const long = price.longPromptTokens !== undefined && tokens > price.longPromptTokens;
  const input = (long ? price.longInputUsdPerMillionTokens : undefined) ?? price.inputUsdPerMillionTokens ?? 0;
  const output = (long ? price.longOutputUsdPerMillionTokens : undefined) ?? price.outputUsdPerMillionTokens ?? 0;
  const usd = (price.requestUsd ?? 0) + (tokens * input + (price.maxOutputTokens ?? 0) * output) / 1e6;
  return Math.ceil(Math.round(usd * 1e9) / 1e3) / 1e6;
}

/** `price` is required: a request the run's cap cannot price would be a paid step it cannot see. */
export type DeciderOptions = { price: DecisionPrice; threshold?: number; model?: string; count?: (text: string) => number };

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const isUnit = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
const shown = (p: number) => String(Math.round(p * 1000) / 1000);

export function deciderFrom(provider: DecisionAsker, options: DeciderOptions): WebDecider {
  if (options?.price === null || typeof options?.price !== "object") throw new TypeError(`deciderFrom needs ${provider.id}'s price, so the run's cap can hold each request`);
  const { price } = options;
  const threshold = options.threshold ?? THRESHOLD;
  if (!(threshold > 0.5 && threshold <= 1)) throw new RangeError(`threshold must be above 0.5 and at most 1 (it was ${threshold})`);
  const ask = async (asked: DecisionAsk, ctx: DecideContext): Promise<Verdicts> => {
    const request = options.model ? { ...asked, model: options.model } : asked;
    const text = JSON.stringify({ state: request.state, questions: request.questions });
    const bytes = Buffer.byteLength(text);
    const fee: Fee = { name: `${provider.id}'s decision`, by: provider.id, usd: holdOf(price, bytes), basis: `the most a request of ${bytes} bytes may cost at ${provider.id}'s price` };
    const send = () => provider.decide(request, { decisionId: `web-${request.kind}-${sha256(text).slice(0, 24)}`, signal: ctx.signal, deadlineMs: ctx.deadlineMs });
    const outcome = await (ctx.pay ? ctx.pay(fee, send) : send());
    const cost: Cost = { usd: outcome.cost_usd, basis: outcome.cost_basis };
    const ids = Object.keys(request.questions);
    let refused = 0;
    const verdicts = ids.map((id): Verdict => {
      const answer = isRecord(outcome.answers) ? outcome.answers[id] : undefined;
      if (isRecord(answer) && answer.type === "refusal") return (refused++, { keep: true, score: null, reason: "refused: kept unjudged" });
      if (!isRecord(answer) || answer.type !== "noul" || !isUnit(answer.noul)) throw new DecideError("invalid_response", `${provider.id} gave no noul answer for ${id}`, cost.usd, cost.basis);
      const p = answer.noul;
      return 1 - p >= threshold ? { keep: false, score: p, reason: `needed p=${shown(p)} <= ${shown(1 - threshold)}` } : { keep: true, score: p, reason: `needed p=${shown(p)}` };
    });
    if (ids.length && refused === ids.length) throw new DecideError("refused", `${provider.id} refused every question`, cost.usd, cost.basis);
    const tokens: Tokens | null = outcome.usage
      ? { in: outcome.usage.input_tokens, out: outcome.usage.output_tokens, basis: "reported" }
      : options.count ? { in: options.count(text), out: null, basis: "counted" } : null;
    const temperature_sent = outcome.temperature_sent ?? null;
    const temperature_applied = temperature_sent === null ? false : outcome.temperature_applied ?? "unknown";
    return { verdicts, model: outcome.model, temperature_sent, temperature_applied, tokens, cost, questions_sha256: [sha256(JSON.stringify(request.questions))] };
  };
  // Asked one after another, each through ctx.pay; a failure after the first carries what the requests before it cost.
  const askAll = async (requests: DecisionAsk[], ctx: DecideContext): Promise<Verdicts> => {
    let got: Verdicts | undefined;
    for (const [i, request] of requests.entries()) {
      try {
        const next = await ask(request, ctx);
        got = got ? { ...got, verdicts: [...got.verdicts, ...next.verdicts], tokens: tokensTogether(got.tokens, next.tokens), cost: costTogether(got.cost, next.cost), questions_sha256: [...got.questions_sha256, ...next.questions_sha256] } : next;
      } catch (thrown) {
        if (!got) throw thrown;
        const cost = costTogether(got.cost, costOf(thrown));
        const message = thrown instanceof Error ? thrown.message : String(thrown);
        throw new DecideError(codeOf(thrown), `request ${i + 1} of ${requests.length}: ${message}`, cost.usd, cost.basis);
      }
    }
    return got!;
  };
  return {
    id: provider.id,
    async sift(query, hits, task, ctx) {
      const { hits: sent, trimmed } = trimmedSearch(query, hits, task);
      const got = await askAll(requestsOf(sent, (some, first) => siftRequest(query, some, task, first)), ctx);
      return trimmed ? { ...got, trimmed } : got;
    },
    judge: (url, task, passages, ctx) => askAll(requestsOf(passages, (some, first) => judgeRequest(url, task, some, first)), ctx),
  };
}
