// Parallel Decisions (POST https://api.parallel.ai/v1/decisions) as a DecisionProvider: typed questions about a JSON
// state, answered with probabilities and grounded in live web evidence. The API takes no idempotency key, so a decision is
// never asked again across a crash (replay "never"). Within one call it is retried only on a retryable error (408, 429,
// 5xx, a lost connection). The response carries no cost, so each attempt that may have been billed (every one but a 429,
// which is refused unanswered) is booked at list price, as an estimate.
import { setTimeout as sleep } from "node:timers/promises";
import { checkCapabilities, DecisionProviderError } from "@parcha/agentrun-dsl";
import type { DecisionCapabilities, DecisionContext, DecisionEvidence, DecisionOutcome, DecisionProvider, DecisionRequest, ProviderAnswer, SystemOneQuestion } from "@parcha/agentrun-dsl";

/** Parallel's list price for one `fast` decision request, up to 100 questions (docs.parallel.ai pricing, 2026-10-28). */
export const PARALLEL_LIST_PRICE_USD = 0.001;

const KEY_VARIABLE = "PARALLEL_API_KEY";
const BASE_URL = "https://api.parallel.ai";
/** Parallel's documented limits: options per choice, levels per score, and characters per rendered question. */
const LIMITS = { minOptions: 2, maxOptions: 255, minLevels: 2, maxLevels: 10, renderedChars: 5_000 } as const;

export interface ParallelOptions {
  /** The key; otherwise PARALLEL_API_KEY, read when a request is made. */
  apiKey?: string;
  /** API root, without /v1/decisions. */
  baseURL?: string;
  fetch?: typeof fetch;
  /** The longest one request may take, every attempt included (default 30 s); a shorter deadline from the host wins. */
  timeoutMs?: number;
  /** Attempts for a 408, 429, 5xx or a lost connection (default 3). */
  maxAttempts?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  /** Whether citations carry their passages (default true). */
  includeExcerpts?: boolean;
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const unit = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
const retryable = (status: number) => status === 408 || status === 429 || (status >= 500 && status <= 599);

/** A question as Parallel takes it: a choice option with no description is described by its own name, and a noul's
 *  criteria name both outcomes. */
function wireQuestion(question: SystemOneQuestion): Record<string, unknown> {
  if (question.type === "choice") return { type: "choice", instructions: question.instructions, criteria: Object.fromEntries(Object.entries(question.criteria).map(([option, text]) => [option, text ?? option])) };
  if (question.type === "noul") return { type: "noul", instructions: question.instructions, ...(question.criteria ? { criteria: { true: question.criteria.true ?? "otherwise", false: question.criteria.false ?? "otherwise" } } : {}) };
  return { ...question };
}

function checkLimits(questions: Record<string, SystemOneQuestion>): void {
  for (const [id, question] of Object.entries(questions)) {
    const refuse = (why: string) => { throw new DecisionProviderError("invalid_request", `Question "${id}" ${why}.`); };
    if (question.type === "choice") {
      const options = Object.keys(question.criteria).length;
      if (options < LIMITS.minOptions || options > LIMITS.maxOptions) refuse(`has ${options} options; Parallel takes ${LIMITS.minOptions} to ${LIMITS.maxOptions}`);
    }
    if (question.type === "score" && (question.criteria.length < LIMITS.minLevels || question.criteria.length > LIMITS.maxLevels)) refuse(`has ${question.criteria.length} levels; Parallel takes ${LIMITS.minLevels} to ${LIMITS.maxLevels}`);
    const rendered = id.length + JSON.stringify(wireQuestion(question)).length;
    if (rendered > LIMITS.renderedChars) refuse(`renders to ${rendered} characters; Parallel takes ${LIMITS.renderedChars}`);
  }
}

/** The answers, sources and metering of a 200 response, checked against the questions asked. */
function readResponse(body: unknown, questions: Record<string, SystemOneQuestion>, attempts: number, billed: number): DecisionOutcome {
  const invalid = (why: string) => new DecisionProviderError("invalid_response", `Parallel returned ${why}.`, { attempts });
  if (!isRecord(body) || !isRecord(body.answers)) throw invalid("no answers");
  const asked = Object.keys(questions);
  const given = Object.keys(body.answers);
  if (given.length !== asked.length || given.some((id) => !Object.hasOwn(questions, id))) throw invalid("answers that do not match the questions asked");
  const answers: Record<string, ProviderAnswer> = {};
  for (const id of asked) {
    const a = body.answers[id];
    if (!isRecord(a)) throw invalid(`no answer for "${id}"`);
    if (a.type === "refusal") answers[id] = { type: "refusal" };
    else if (a.type === "noul") answers[id] = { type: "noul", noul: a.noul as number };
    else if (a.type === "choice") answers[id] = { type: "choice", choice: a.choice as string, probabilities: a.probabilities as Record<string, number>, ...(unit(a.confidence) ? { confidence: a.confidence } : {}) };
    else if (a.type === "score") answers[id] = { type: "score", score: a.score as number, legend: a.legend as Record<string, string>, probabilities: a.probabilities as Record<string, number>, ...(unit(a.confidence) ? { confidence: a.confidence } : {}) };
    else throw invalid(`an answer of unknown type for "${id}"`);
  }
  if (body.citations !== undefined && !Array.isArray(body.citations)) throw invalid("citations that are not a list");
  const evidence: DecisionEvidence[] = ((body.citations as unknown[] | undefined) ?? []).filter(isRecord).filter((c) => typeof c.url === "string").map((c) => ({
    url: c.url as string, title: typeof c.title === "string" ? c.title : null,
    excerpts: Array.isArray(c.excerpts) ? c.excerpts.filter((e): e is string => typeof e === "string") : [], scope: "call",
  }));
  const usage = isRecord(body.usage) && Number.isSafeInteger(body.usage.input_tokens) && (body.usage.input_tokens as number) >= 0 ? { input_tokens: body.usage.input_tokens as number, output_tokens: 0 } : null;
  return {
    answers, evidence, model: typeof body.mode === "string" ? `parallel-${body.mode}` : null, usage,
    cost_usd: billed * PARALLEL_LIST_PRICE_USD, cost_basis: "estimate", provider_request_id: typeof body.decision_id === "string" ? body.decision_id : null,
  };
}

/** The wait a Retry-After header asks for, in milliseconds, when it is a number of seconds. */
function retryAfterMs(response: Response): number | undefined {
  const value = response.headers.get("retry-after");
  if (value === null || !/^\d+(?:\.\d+)?$/.test(value.trim())) return undefined;
  return Math.round(Number(value) * 1000);
}

export function parallelProvider(options: ParallelOptions = {}): DecisionProvider {
  const capabilities: DecisionCapabilities = {
    types: ["noul", "choice", "score"], inputs: ["text", "json", "url"], evidence: "citations", probability: "model", grounding: true,
    replay: "never", maxQuestions: 100, maxStateBytes: 96_000,
  };
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxAttempts = options.maxAttempts ?? 3;
  const retryBaseMs = options.retryBaseMs ?? 500;
  const retryMaxMs = options.retryMaxMs ?? 5_000;
  const url = `${(options.baseURL ?? BASE_URL).replace(/\/+$/, "")}/v1/decisions`;
  return {
    id: "parallel", needs: [KEY_VARIABLE], capabilities,
    async decide(request: DecisionRequest, ctx: DecisionContext): Promise<DecisionOutcome> {
      checkCapabilities(capabilities, request);
      checkLimits(request.questions);
      const key = options.apiKey ?? process.env[KEY_VARIABLE];
      if (typeof key !== "string" || !key.trim()) throw new DecisionProviderError("configuration", `${KEY_VARIABLE} is not set.`);
      const body = JSON.stringify({ mode: "fast", state: request.state ?? null, questions: Object.fromEntries(Object.entries(request.questions).map(([id, q]) => [id, wireQuestion(q)])), include_excerpts: options.includeExcerpts ?? true });
      const deadline = AbortSignal.timeout(Math.min(timeoutMs, ctx.deadlineMs ?? Infinity));
      const signal = AbortSignal.any([ctx.signal, deadline]);
      const stopped = (attempts: number) => ctx.signal.aborted
        ? new DecisionProviderError("aborted", "The Parallel request was cancelled.", { attempts })
        : new DecisionProviderError("timeout", "The Parallel request passed its deadline.", { attempts });
      const fetcher = options.fetch ?? fetch;
      // Attempts before this one that may have been billed: a lost answer, a 408 or a 5xx. A 429 was refused unanswered.
      let billedBefore = 0;
      for (let attempt = 1; ; attempt++) {
        let response: Response;
        try {
          response = await fetcher(url, { method: "POST", headers: { "content-type": "application/json", "x-api-key": key }, body, signal });
        } catch {
          if (signal.aborted) throw stopped(attempt);
          if (attempt >= maxAttempts) throw new DecisionProviderError("connection", "Parallel could not be reached.", { attempts: attempt });
          billedBefore++;
          await sleep(Math.min(retryMaxMs, retryBaseMs * 2 ** (attempt - 1)), undefined, { signal }).catch(() => { throw stopped(attempt); });
          continue;
        }
        if (response.ok) {
          let parsed: unknown;
          try { parsed = await response.json(); }
          catch { if (signal.aborted) throw stopped(attempt); throw new DecisionProviderError("invalid_response", "Parallel returned a body that is not JSON.", { attempts: attempt }); }
          return readResponse(parsed, request.questions, attempt, billedBefore + 1);
        }
        const status = response.status;
        if (retryable(status) && attempt < maxAttempts) {
          if (status !== 429) billedBefore++;
          const wait = (status === 429 || status === 503 ? retryAfterMs(response) : undefined) ?? Math.min(retryMaxMs, retryBaseMs * 2 ** (attempt - 1));
          await response.body?.cancel().catch(() => {});
          await sleep(wait, undefined, { signal }).catch(() => { throw stopped(attempt); });
          continue;
        }
        const refId = await response.json().then((b: unknown) => (isRecord(b) && isRecord(b.error) && typeof b.error.ref_id === "string" ? b.error.ref_id : undefined), () => undefined);
        const details = { status, attempts: attempt, ...(refId !== undefined ? { refId } : {}) };
        if (status === 401 || status === 403) throw new DecisionProviderError("auth", `Parallel refused the key (HTTP ${status}).`, details);
        if (status === 400 || status === 422) throw new DecisionProviderError("invalid_request", `Parallel refused the request (HTTP ${status}).`, details);
        if (status === 429) throw new DecisionProviderError("rate_limited", `Parallel rate-limited the request after ${attempt} attempts.`, details);
        throw new DecisionProviderError("http", `Parallel answered HTTP ${status}.`, details);
      }
    },
  };
}
