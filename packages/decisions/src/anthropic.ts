// A prompted Claude model (POST {base}/v1/messages) as a DecisionProvider: the System One request ({ state, questions })
// as the user message, the answers held to a JSON schema. A request is paid once sent, so it is sent again only when it
// provably never reached the API or was refused with a time to retry (a 429 with Retry-After).
import { setTimeout as sleep } from "node:timers/promises";
import { checkCapabilities, DecisionProviderError } from "@parcha/agentrun-dsl";
import type { DecisionCapabilities, DecisionContext, DecisionOutcome, DecisionProvider, DecisionRequest, ProviderAnswer } from "@parcha/agentrun-dsl";

const KEY_VARIABLE = "ANTHROPIC_API_KEY";
const BASE_VARIABLE = "ANTHROPIC_BASE_URL";
const BASE_URL = "https://api.anthropic.com";
const API_VERSION = "2023-06-01";
const MODEL = "claude-haiku-5-5";
const MAX_TOKENS = 8192;

/** USD per million tokens; past `longPromptTokens` input tokens a request is billed at the long rates. */
export type AnthropicPrice = { inputUsdPerMillionTokens: number; outputUsdPerMillionTokens: number; longPromptTokens?: number; longInputUsdPerMillionTokens?: number; longOutputUsdPerMillionTokens?: number };
/** Anthropic's published list prices (platform.claude.com pricing), by model. */
export const ANTHROPIC_PUBLISHED_PRICING: Readonly<Record<string, AnthropicPrice>> = {
  "claude-haiku-5-5": { inputUsdPerMillionTokens: 0.1, outputUsdPerMillionTokens: 0.5, longPromptTokens: 100_000, longInputUsdPerMillionTokens: 0.5, longOutputUsdPerMillionTokens: 2.5 },
};

/** The task alone: what to answer is the questions' own words, the same a decision model is sent. */
export const ANTHROPIC_SYSTEM = [
  "You are a decision model. The user message is JSON: a state, and questions about it by id.",
  "Answer every question from the state alone.",
  "For a noul question (true or false, with criteria for each), give the probability, from 0 to 1, that its answer is true.",
  "For a choice question, give each option the probability, from 0 to 1, that it is the one that fits; they sum to 1.",
  "Reply with the JSON object the schema describes, keyed by question id, and nothing else.",
].join("\n");

export interface AnthropicOptions {
  /** The key; otherwise ANTHROPIC_API_KEY, read when a request is made. */
  apiKey?: string;
  /** API root, without /v1/messages; otherwise ANTHROPIC_BASE_URL, read when a request is made, else Anthropic's. */
  baseURL?: string;
  fetch?: typeof fetch;
  /** The model for a request that names none (default claude-haiku-5-5). */
  model?: string;
  /** The price of `model` when ANTHROPIC_PUBLISHED_PRICING lists none; without either, the cost is unknown. */
  pricing?: AnthropicPrice;
  /** The longest one request may take, every attempt included (default 30 s); a shorter deadline from the host wins. */
  timeoutMs?: number;
  maxAttempts?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const isUnit = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
/** Failures a request meets before it is sent: no DNS answer, no connection, no TLS handshake. Any other is after. */
const BEFORE_SENDING = new Set(["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ENETUNREACH", "EHOSTUNREACH", "UND_ERR_CONNECT_TIMEOUT",
  "CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "ERR_TLS_CERT_ALTNAME_INVALID"]);
const neverSent = (error: unknown): boolean => {
  for (let cause: unknown = error, depth = 0; (isRecord(cause) || cause instanceof Error) && depth <= 4; cause = (cause as { cause?: unknown }).cause, depth++) {
    const code = (cause as { code?: unknown }).code;
    if (typeof code === "string" && BEFORE_SENDING.has(code)) return true;
  }
  return false;
};

function retryAfterMs(response: Response): number | undefined {
  const value = response.headers.get("retry-after")?.trim();
  if (!value) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(value)) return Math.round(Number(value) * 1000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}

const optionsOf = (question: DecisionRequest["questions"][string]) => (question.type === "choice" ? Object.keys(question.criteria) : []);

/** The answers' schema: a noul a number, a choice an object of a number per option, every question required. */
function schemaOf(questions: DecisionRequest["questions"]) {
  const properties = Object.fromEntries(Object.entries(questions).map(([id, question]) => {
    if (question.type !== "choice") return [id, { type: "number" }];
    const options = optionsOf(question);
    return [id, { type: "object", additionalProperties: false, required: options, properties: Object.fromEntries(options.map((option) => [option, { type: "number" }])) }];
  }));
  return { type: "object", additionalProperties: false, required: Object.keys(questions), properties };
}

function costOf(usage: { input_tokens: number; output_tokens: number }, price: AnthropicPrice | undefined): number | null {
  if (!price) return null;
  const long = price.longPromptTokens !== undefined && usage.input_tokens > price.longPromptTokens;
  const input = long ? price.longInputUsdPerMillionTokens ?? price.inputUsdPerMillionTokens : price.inputUsdPerMillionTokens;
  const output = long ? price.longOutputUsdPerMillionTokens ?? price.outputUsdPerMillionTokens : price.outputUsdPerMillionTokens;
  return (usage.input_tokens * input + usage.output_tokens * output) / 1e6;
}

/** The model's answers read against the questions asked: every one answered, none unasked, each probability in range. */
function answersOf(text: string, questions: DecisionRequest["questions"]): Record<string, ProviderAnswer> | string {
  let given: unknown;
  try { given = JSON.parse(text); } catch { return "an answer that is not JSON"; }
  if (!isRecord(given)) return "an answer that is not a JSON object";
  const ids = Object.keys(questions);
  if (Object.keys(given).length !== ids.length || Object.keys(given).some((id) => !Object.hasOwn(questions, id))) return "answers that do not match the questions asked";
  const answers: Record<string, ProviderAnswer> = {};
  for (const id of ids) {
    const question = questions[id]!;
    const value = given[id];
    if (question.type === "noul") {
      if (!isUnit(value)) return `no probability for "${id}"`;
      answers[id] = { type: "noul", noul: value };
      continue;
    }
    const options = optionsOf(question);
    if (!isRecord(value) || Object.keys(value).length !== options.length || !options.every((option) => isUnit(value[option]))) return `no probability per option for "${id}"`;
    const sum = options.reduce((total, option) => total + (value[option] as number), 0);
    if (!(sum > 0)) return `probabilities that sum to 0 for "${id}"`;
    const probabilities = Object.fromEntries(options.map((option) => [option, Math.abs(sum - 1) < 1e-9 ? (value[option] as number) : (value[option] as number) / sum]));
    const choice = options.reduce((best, option) => (probabilities[option]! > probabilities[best]! ? option : best), options[0]!);
    answers[id] = { type: "choice", choice, probabilities };
  }
  return answers;
}

export function anthropicProvider(options: AnthropicOptions = {}): DecisionProvider {
  const capabilities: DecisionCapabilities = {
    types: ["noul", "choice"], inputs: ["text", "json"], evidence: "none", probability: "self_reported", grounding: false,
    replay: "never", maxQuestions: null, maxStateBytes: null,
  };
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxAttempts = options.maxAttempts ?? 3;
  const retryBaseMs = options.retryBaseMs ?? 500;
  const retryMaxMs = options.retryMaxMs ?? 5_000;
  const fetcher = options.fetch ?? fetch;
  return {
    id: "anthropic", needs: [KEY_VARIABLE], capabilities,
    async decide(request: DecisionRequest, ctx: DecisionContext): Promise<DecisionOutcome> {
      checkCapabilities(capabilities, request);
      const key = options.apiKey ?? process.env[KEY_VARIABLE];
      if (typeof key !== "string" || !key.trim()) throw new DecisionProviderError("configuration", `${KEY_VARIABLE} is not set.`);
      const root = (options.baseURL ?? process.env[BASE_VARIABLE] ?? BASE_URL).replace(/\/+$/, "");
      const model = request.model ?? options.model ?? MODEL;
      const price = ANTHROPIC_PUBLISHED_PRICING[model] ?? options.pricing;
      const body = JSON.stringify({
        model,
        max_tokens: MAX_TOKENS,
        system: ANTHROPIC_SYSTEM,
        messages: [{ role: "user", content: JSON.stringify({ state: request.state ?? null, questions: request.questions }) }],
        output_config: { effort: "low", format: { type: "json_schema", schema: schemaOf(request.questions) } },
      });
      const headers = { "content-type": "application/json", "anthropic-version": API_VERSION, "x-api-key": key };
      const budgetMs = Math.min(timeoutMs, ctx.deadlineMs ?? Infinity);
      const deadlineAt = Date.now() + budgetMs;
      const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(budgetMs)]);
      const stopped = (attempts: number) => new DecisionProviderError("aborted", "The Anthropic request was cancelled.", { attempts });
      // Sent and lost: it may have been answered and billed, so it is never sent again, at an unknown cost.
      const lost = (attempts: number, what: string, status?: number) => new DecisionProviderError("outcome_unknown", `Anthropic ${what} after the request was sent; it may have been answered, and is not sent again.`, { attempts, ...(status === undefined ? {} : { status }), costUsd: null, costBasis: "unknown" });
      for (let attempt = 1; ; attempt++) {
        let response: Response;
        try {
          response = await fetcher(`${root}/v1/messages`, { method: "POST", headers, body, signal });
        } catch (error) {
          if (signal.aborted) throw ctx.signal.aborted ? stopped(attempt) : lost(attempt, "passed its deadline");
          if (!neverSent(error)) throw lost(attempt, "lost the connection");
          if (attempt >= maxAttempts) throw new DecisionProviderError("connection", "Anthropic could not be reached.", { attempts: attempt });
          const unreached = () => { throw ctx.signal.aborted ? stopped(attempt) : new DecisionProviderError("timeout", "Anthropic could not be reached before the deadline.", { attempts: attempt }); };
          await sleep(Math.min(retryMaxMs, retryBaseMs * 2 ** (attempt - 1)), undefined, { signal }).catch(unreached);
          continue;
        }
        if (response.ok) {
          let text: string;
          try { text = await response.text(); }
          catch { throw ctx.signal.aborted ? stopped(attempt) : lost(attempt, signal.aborted ? "passed its deadline" : "lost the connection while the answer was read"); }
          return readMessage(text, request.questions, price, attempt);
        }
        const status = response.status;
        if (status === 408 || (status >= 500 && status <= 599)) { void response.body?.cancel().catch(() => {}); throw lost(attempt, `answered HTTP ${status}`, status); }
        const wait = status === 429 ? retryAfterMs(response) : undefined;
        void response.body?.cancel().catch(() => {});
        if (wait !== undefined && attempt < maxAttempts && wait < deadlineAt - Date.now()) {
          const limited = () => { throw ctx.signal.aborted ? stopped(attempt) : new DecisionProviderError("rate_limited", `Anthropic rate-limited the request after ${attempt} attempts.`, { status, attempts: attempt }); };
          await sleep(wait, undefined, { signal }).catch(limited);
          continue;
        }
        const details = { status, attempts: attempt };
        if (status === 401 || status === 403) throw new DecisionProviderError("auth", `Anthropic refused the key (HTTP ${status}).`, details);
        if (status === 400 || status === 404 || status === 413 || status === 422) throw new DecisionProviderError("invalid_request", `Anthropic refused the request (HTTP ${status}).`, details);
        if (status === 429) throw new DecisionProviderError("rate_limited", `Anthropic rate-limited the request after ${attempt} attempts.`, details);
        throw new DecisionProviderError("http", `Anthropic answered HTTP ${status}.`, details);
      }
    },
  };
}

/** A 200's message as the outcome. Anthropic answered, so the request was billed: what this rejects is booked at its cost. */
function readMessage(text: string, questions: DecisionRequest["questions"], price: AnthropicPrice | undefined, attempts: number): DecisionOutcome {
  let message: unknown;
  try { message = JSON.parse(text); }
  catch { throw new DecisionProviderError("invalid_response", "Anthropic returned a body that is not JSON.", { attempts, costUsd: null, costBasis: "unknown" }); }
  const raw = isRecord(message) && isRecord(message.usage) ? message.usage : undefined;
  const usage = raw && isCount(raw.input_tokens) && isCount(raw.output_tokens) ? { input_tokens: raw.input_tokens, output_tokens: raw.output_tokens } : null;
  const cost = usage ? costOf(usage, price) : null;
  const booked = { cost_usd: cost, cost_basis: cost === null ? "unknown" as const : "estimate" as const };
  const invalid = (why: string) => new DecisionProviderError("invalid_response", `Anthropic returned ${why}.`, { attempts, costUsd: cost, costBasis: booked.cost_basis });
  if (!isRecord(message)) throw invalid("no message");
  const outcome = { evidence: [], model: typeof message.model === "string" && message.model ? message.model : null, usage, ...booked, provider_request_id: typeof message.id === "string" ? message.id : null };
  if (message.stop_reason === "refusal") return { answers: Object.fromEntries(Object.keys(questions).map((id) => [id, { type: "refusal" as const }])), ...outcome };
  if (message.stop_reason === "max_tokens") throw invalid("an answer cut at max_tokens");
  const block = Array.isArray(message.content) ? message.content.find((part) => isRecord(part) && part.type === "text") : undefined;
  if (!isRecord(block) || typeof block.text !== "string") throw invalid("no text answer");
  const answers = answersOf(block.text, questions);
  if (typeof answers === "string") throw invalid(answers);
  return { answers, ...outcome };
}
