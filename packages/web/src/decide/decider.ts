// Every provider is asked the same questions in the same words, so the arms differ only in who answers them.
import { createHash } from "node:crypto";
import type { Hit } from "../search.js";

export type Verdict = { keep: boolean; score: number | null; reason: string };
/** "counted": the provider reported none, and the request's text was counted by the host's counter. */
export type Tokens = { in: number; out: number | null; basis: "reported" | "counted" };
/** "none": nothing was billed (the request was never sent, or refused unanswered). usd is null only when unknown. */
export type Cost = { usd: number | null; basis: "reported" | "estimate" | "unknown" | "none" };
/** What the provider says its request carried: a provider that says nothing sent no temperature. */
export type Temperature = { temperature_sent: number | null; temperature_applied: boolean | "unknown" };
/** One verdict per item asked about, in order. */
export type Verdicts = { verdicts: Verdict[]; model: string | null; tokens: Tokens | null; cost: Cost; questions_sha256: string } & Temperature;
export type DecideContext = { signal: AbortSignal; deadlineMs: number };

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

const keyed = <T>(prefix: string, items: readonly T[]): Record<string, T> => Object.fromEntries(items.map((item, i) => [`${prefix}${i + 1}`, item]));
const questionsFor = (prefix: string, n: number, question: (id: string) => NoulQuestion) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`${prefix}${i + 1}`, question(`${prefix}${i + 1}`)]));

export function siftRequest(query: string, hits: readonly Hit[], task?: string): DecisionAsk {
  return { label: "web_search sift", kind: "sift", state: { query, ...(task ? { task } : {}), results: keyed("r", hits) }, questions: questionsFor("r", hits.length, siftQuestion) };
}
export function judgeRequest(url: string, task: string, passages: readonly string[]): DecisionAsk {
  return { label: "web_fetch passages", kind: "judge", state: { url, task, passages: keyed("p", passages) }, questions: questionsFor("p", passages.length, judgeQuestion) };
}

/** How sure a decider must be that an item is not needed before it is dropped: dropped when 1 - p(needed) >= it. */
export const THRESHOLD = 0.8;
export type DeciderOptions = { threshold?: number; model?: string; count?: (text: string) => number };

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const isUnit = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
const shown = (p: number) => String(Math.round(p * 1000) / 1000);

export function deciderFrom(provider: DecisionAsker, options: DeciderOptions = {}): WebDecider {
  const threshold = options.threshold ?? THRESHOLD;
  if (!(threshold > 0.5 && threshold <= 1)) throw new RangeError(`threshold must be above 0.5 and at most 1 (it was ${threshold})`);
  const ask = async (asked: DecisionAsk, ctx: DecideContext): Promise<Verdicts> => {
    const request = options.model ? { ...asked, model: options.model } : asked;
    const text = JSON.stringify({ state: request.state, questions: request.questions });
    const outcome = await provider.decide(request, { decisionId: `web-${request.kind}-${sha256(text).slice(0, 24)}`, signal: ctx.signal, deadlineMs: ctx.deadlineMs });
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
    return { verdicts, model: outcome.model, temperature_sent, temperature_applied, tokens, cost, questions_sha256: sha256(JSON.stringify(request.questions)) };
  };
  return {
    id: provider.id,
    sift: (query, hits, task, ctx) => ask(siftRequest(query, hits, task), ctx),
    judge: (url, task, passages, ctx) => ask(judgeRequest(url, task, passages), ctx),
  };
}
