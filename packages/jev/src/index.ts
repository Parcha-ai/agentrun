import { createHash } from "node:crypto";
import { APIConnectionError, APIError, Image, TypeSafeClient } from "@typesafe-ai/sdk";
import type { Fetch, RequestOptions, SystemOneRequest } from "@typesafe-ai/sdk";
import { validateAnswers, SystemOneError, isSystemOneResponseReason } from "@parcha/agentrun-dsl";
import type { WorkflowDeps, SystemOneResponseReason } from "@parcha/agentrun-dsl";

/** Injectable client boundary. Custom clients must honor signal and disable their own retries. */
export interface JevClient {
  systemOne(request: SystemOneRequest, options: RequestOptions): PromiseLike<unknown>;
}

/** Where Jev is reached: TypeSafe's own API (default) or OpenRouter's System One path. */
export type JevProvider = "typesafe" | "openrouter";
const keyVariable: Record<JevProvider, string> = { typesafe: "TYPESAFE_API_KEY", openrouter: "OPENROUTER_API_KEY" };
const OPENROUTER_BASE_URL = "https://openrouter.ai/api";
const OPENROUTER_DEFAULT_MODEL = "~typesafe/jev-latest";

/** The provider an environment's keys select: OpenRouter only when `OPENROUTER_API_KEY` is set and `TYPESAFE_API_KEY` is not. The runner itself never reads this. */
export function jevProviderFromEnv(env: Record<string, string | undefined> = process.env): JevProvider {
  const set = (name: string) => typeof env[name] === "string" && env[name]!.trim().length > 0;
  return set("OPENROUTER_API_KEY") && !set("TYPESAFE_API_KEY") ? "openrouter" : "typesafe";
}

/** A still image a request carries: PNG or JPEG file bytes and the type they are. The runner builds the SDK's image from it and sends it as a multipart file part. */
export interface JevImage {
  bytes: Uint8Array;
  mime: "image/png" | "image/jpeg";
}

type RunJudge = NonNullable<WorkflowDeps["runJudge"]>;
/** What one call to the runner takes: the interpreter's `runJudge` parameters, plus the images the request carries and an optional model for this call.
 *  `assets` maps each reference, a string that appears literally in `state` or in a question's `instructions` or `criteria` (`"<photo>"`), to its image;
 *  every reference must appear, and a Box question needs at least one image. */
export type JevJudgeParams = Parameters<RunJudge>[0] & {
  assets?: Record<string, JevImage>;
  /** Names the model for this call, over the runner's `model`. A Box question needs `jev-1.14.0` or `jev-preview`; the default `jev-latest` is 1.13. */
  model?: string;
};
/** The typed answers (choice, noul, score with their probabilities; box with its edges and confidence), the model that answered, its token usage, and
 *  the cost: the provider's reported cost, else the host's configured price applied to the counted tokens, else null. */
export type JevJudgeResult = Awaited<ReturnType<RunJudge>>;
/** The judge `createJevRunner` returns, and the port a host passes to a package that asks Jev about images without importing the SDK. */
export type JevJudge = (params: JevJudgeParams) => Promise<JevJudgeResult>;

const IMAGE_HEADER = "TypeSafe-Danger-Zone-Images";
const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
const BOX_MODEL = "jev-1.14.0";
/** Models that answer a Box question: Jev 1.14 and later by name, and the preview alias. `jev-latest` is 1.13 and does not. */
function answersBox(model: string): boolean {
  if (model === "jev-preview") return true;
  const version = /^jev-(\d+)\.(\d+)(?:\.\d+)?$/.exec(model);
  return version !== null && (Number(version[1]) > 1 || (Number(version[1]) === 1 && Number(version[2]) >= 14));
}
/** Every string value of a JSON value, not its keys. */
function* stringValues(value: unknown): Generator<string> {
  if (typeof value === "string") yield value;
  else if (Array.isArray(value)) for (const each of value) yield* stringValues(each);
  else if (record(value)) for (const each of Object.values(value)) yield* stringValues(each);
}
const startsWith = (bytes: Uint8Array, prefix: number[]) => prefix.every((byte, index) => bytes[index] === byte);
const imageMagic: Record<JevImage["mime"], number[]> = { "image/png": [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "image/jpeg": [0xff, 0xd8, 0xff] };

export interface JevOptions {
  /** `typesafe` (default) or `openrouter`. OpenRouter sets the API root and the default model (`~typesafe/jev-latest`); its key is `apiKey` or `OPENROUTER_API_KEY`. Cannot be combined with `client`. */
  provider?: JevProvider;
  apiKey?: string;
  /** API root, without /v1/systemone; useful for an explicitly configured gateway. */
  baseURL?: string;
  fetch?: Fetch;
  /** When supplied, owns credentials and transport; cannot be combined with apiKey/baseURL/fetch. */
  client?: JevClient;
  model?: string;
  signal?: AbortSignal;
  /** null disables the adapter deadline; requires a cancellation-only host client. */
  timeoutMs?: number | null;
  /** Optional host guard on serialized UTF-8 JSON state; null or omission disables it. */
  maxStateBytes?: number | null;
  maxAttempts?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  /** Explicit estimate, used when the provider reports no cost; unknown prices are never silently treated as free. */
  pricing?: { inputUsdPerMillionTokens: number; outputUsdPerMillionTokens: number };
}

export type JevErrorCode = "configuration" | "invalid_request" | "invalid_response" | "http" | "connection" | "aborted" | "timeout";
const adapterResponseReasons = ["response_shape", "token_usage", "model_identifier", "cost_range", "answer_validation", "max_tokens_exceeded"] as const;
export type JevResponseReason = SystemOneResponseReason | typeof adapterResponseReasons[number];
export function isJevResponseReason(value: unknown): value is JevResponseReason {
  return isSystemOneResponseReason(value) || typeof value === "string" && (adapterResponseReasons as readonly string[]).includes(value);
}
export type JevResponseDiagnostic = { reason: JevResponseReason };
export type JevRequestDiagnostic = {
  reason: "invalid_state" | "state_too_large" | "invalid_questions" | "invalid_assets" | "unsupported_model" | "unsupported_provider";
  label?: string;
  stateBytes?: number;
  maxStateBytes?: number;
};

/** Deliberately excludes provider bodies, headers, input state, and underlying causes. */
export class JevError extends Error {
  readonly responseDiagnostic?: JevResponseDiagnostic;
  constructor(readonly code: JevErrorCode, message: string, readonly attempts: number = 0, readonly status?: number,
    readonly requestDiagnostic?: JevRequestDiagnostic, responseDiagnostic?: JevResponseDiagnostic) {
    super(message);
    this.name = "JevError";
    if (isJevResponseReason(responseDiagnostic?.reason)) this.responseDiagnostic = { reason: responseDiagnostic.reason };
  }
}

const configuration = (condition: boolean, message: string): void => {
  if (!condition) throw new JevError("configuration", message);
};
const milliseconds = (n: number, allowZero = false): boolean => Number.isSafeInteger(n) && n >= (allowZero ? 0 : 1) && n <= 2_147_483_647;
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const tokens = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;

function abortable<T>(promise: PromiseLike<T>, signal: AbortSignal, error: () => JevError): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(error()); };
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(promise).then(
      value => { signal.removeEventListener("abort", abort); if (signal.aborted) reject(error()); else resolve(value); },
      failure => { signal.removeEventListener("abort", abort); reject(signal.aborted ? error() : failure); },
    );
    if (signal.aborted) abort();
  });
}

function wait(ms: number, signal: AbortSignal, error: () => JevError): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(error()); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

/** A server's Retry-After in milliseconds from now, given as delta-seconds or an HTTP date; undefined when absent or unparseable. */
function retryAfterMs(headers: unknown): number | undefined {
  const value = headers instanceof Headers ? headers.get("retry-after")?.trim() : undefined;
  if (!value) return undefined;
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

export function createJevRunner(options: JevOptions = {}): JevJudge {
  const timeoutMs = options.timeoutMs === null ? null : (options.timeoutMs ?? 30_000);
  const maxStateBytes = options.maxStateBytes ?? null;
  const maxAttempts = options.maxAttempts ?? 3;
  const retryBaseMs = options.retryBaseMs ?? 500;
  const retryMaxMs = options.retryMaxMs ?? 5_000;
  configuration(timeoutMs === null || milliseconds(timeoutMs), "timeoutMs must be null or a positive integer of at most 2147483647.");
  configuration(maxStateBytes === null || (Number.isSafeInteger(maxStateBytes) && maxStateBytes > 0), "maxStateBytes must be null or a positive safe integer.");
  configuration(timeoutMs !== null || options.client !== undefined, "The TypeSafe SDK requires a finite timeout. For timeoutMs: null, supply a cancellation-only host client.");
  configuration(Number.isInteger(maxAttempts) && maxAttempts >= 1 && maxAttempts <= 10, "maxAttempts must be an integer from 1 to 10.");
  configuration(milliseconds(retryBaseMs, true) && milliseconds(retryMaxMs, true) && retryBaseMs <= retryMaxMs, "Retry delays must be nonnegative integers; retryBaseMs cannot exceed retryMaxMs.");
  configuration(!options.client || (options.apiKey === undefined && options.baseURL === undefined && options.fetch === undefined && options.provider === undefined), "Supply either client or transport options, not both.");
  const provider = options.provider ?? "typesafe";
  configuration(provider === "typesafe" || provider === "openrouter", "provider must be typesafe or openrouter.");
  const pricing = options.pricing ? { ...options.pricing } : undefined;
  if (pricing) configuration([pricing.inputUsdPerMillionTokens, pricing.outputUsdPerMillionTokens].every(n => Number.isFinite(n) && n >= 0), "Configured token prices must be finite nonnegative numbers.");
  const model = options.model ?? (provider === "openrouter" ? OPENROUTER_DEFAULT_MODEL : "jev-latest");
  configuration(typeof model === "string" && model.trim().length > 0, "model must be a nonempty string.");
  let client: JevClient;
  try {
    const key = options.apiKey ?? (provider === "openrouter" ? process.env.OPENROUTER_API_KEY : undefined);
    // The SDK falls back to TYPESAFE_API_KEY when given no key: for OpenRouter that would send one provider's key to another.
    if (provider === "openrouter" && (typeof key !== "string" || key.trim().length === 0)) throw new Error("no key");
    client = options.client ?? new TypeSafeClient({
      apiKey: key, baseURL: options.baseURL ?? (provider === "openrouter" ? OPENROUTER_BASE_URL : undefined), fetch: options.fetch,
      defaultModel: model, retry: { maxRetries: 0 }, timeout: timeoutMs ?? undefined, logLevel: "off",
      // Bodies go as they always have: uncompressed JSON, which a host's own fetch, a gateway and OpenRouter all read.
      compression: false,
    });
  } catch {
    throw new JevError("configuration", `Could not configure Jev. Supply apiKey or set ${keyVariable[provider]}, and check transport options.`);
  }
  const runnerSignal = options.signal;

  return async params => {
    const deadline = new AbortController();
    const signals = [deadline.signal, runnerSignal, params.signal].filter((s): s is AbortSignal => !!s);
    const signal = AbortSignal.any(signals);
    let attempt = 0;
    const abortError = () => (runnerSignal?.aborted || params.signal?.aborted)
      ? new JevError("aborted", "Jev request was cancelled.", attempt)
      : new JevError("timeout", "Jev request exceeded its total deadline.", attempt);
    if (signal.aborted) throw abortError();
    const timer = timeoutMs === null ? undefined : setTimeout(() => deadline.abort(), timeoutMs);
    const started = Date.now();
    try {
      let body: string;
      let request: SystemOneRequest;
      const invalid = (reason: JevRequestDiagnostic['reason'], message: string, stateBytes?: number) => new JevError(
        "invalid_request", message, 0, undefined, { reason,
          ...(typeof params.label === "string" ? { label: params.label.slice(0, 200) } : {}),
          ...(stateBytes === undefined || maxStateBytes === null ? {} : { stateBytes, maxStateBytes }) });
      const state = params.state ?? null;
      let serializedState: string;
      try {
        if (typeof state !== "string" && state !== null && typeof state !== "object") throw new Error();
        serializedState = JSON.stringify(state);
        if (typeof serializedState !== "string") throw new Error();
      } catch {
        throw invalid("invalid_state", "Jev state must be JSON-serializable text, an object, an array or null.");
      }
      const stateBytes = Buffer.byteLength(serializedState, "utf8");
      if (maxStateBytes !== null && stateBytes > maxStateBytes) throw invalid("state_too_large",
        `Jev assembled state is ${stateBytes} UTF-8 bytes; configured host limit is ${maxStateBytes} bytes. No request was sent.`, stateBytes);
      const callModel = params.model ?? model;
      if (typeof callModel !== "string" || callModel.trim().length === 0) throw invalid("invalid_questions", "model must be a nonempty string; no request was sent.");
      try {
        body = JSON.stringify({ state: JSON.parse(serializedState), model: callModel, questions: params.questions });
        request = JSON.parse(body) as SystemOneRequest;
        if (!record(request.questions) || Object.keys(request.questions).length === 0) throw new Error();
      } catch {
        throw invalid("invalid_questions", "Jev requires a nonempty JSON question map; no request was sent.");
      }
      // Images and Box questions: validated whole before any send; the header goes with exactly these requests.
      const hasBox = Object.values(request.questions).some(question => record(question) && question.type === "box");
      const given = params.assets === undefined || params.assets === null ? {} : params.assets;
      if (!record(given)) throw invalid("invalid_assets", "assets must map each reference to an image; no request was sent.");
      const references = Object.keys(given);
      const carriesImage = references.length > 0;
      if ((carriesImage || hasBox) && provider !== "typesafe" && options.client === undefined) throw invalid("unsupported_provider", "Images and Box questions are sent to TypeSafe's own API only; the OpenRouter path is not verified for them. No request was sent.");
      if (hasBox && !answersBox(callModel)) throw invalid("unsupported_model", `A Box question needs a model that answers it: ${BOX_MODEL} (or jev-preview); jev-latest is 1.13. No request was sent.`);
      if (hasBox && !carriesImage) throw invalid("invalid_assets", "A Box question locates something in an image, and the request carries none. No request was sent.");
      let assets: Record<string, Image> | undefined;
      let assetDigests: Record<string, { sha256: string; mime: string; bytes: number }> | undefined;
      if (carriesImage) {
        // A reference is replaced where it sits inside a string value of the state, an instruction or a criterion; keys (question ids, option names) are never replaced.
        const texts = [...stringValues(JSON.parse(serializedState)), ...Object.values(request.questions).flatMap(question => record(question) ? [...stringValues(question.instructions), ...stringValues(question.criteria)] : [])];
        assets = Object.create(null) as Record<string, Image>; assetDigests = Object.create(null) as Record<string, { sha256: string; mime: string; bytes: number }>;
        for (const reference of references) {
          const image = given[reference];
          const sound = typeof reference === "string" && reference.length > 0 && Buffer.byteLength(reference, "utf8") <= 1024 && !/["\\\u0000-\u001f]/.test(reference)
            && record(image) && image.bytes instanceof Uint8Array && (image.mime === "image/png" || image.mime === "image/jpeg")
            && image.bytes.byteLength > 0 && image.bytes.byteLength <= MAX_IMAGE_BYTES && startsWith(image.bytes, imageMagic[image.mime]);
          if (!sound) throw invalid("invalid_assets", "Each image is a PNG or JPEG file of at most 16 MiB, with bytes that are that type and a plain reference. No request was sent.");
          if (!texts.some(text => text.includes(reference))) throw invalid("invalid_assets", "Every image reference must appear in the state or a question. No request was sent.");
          assets[reference] = new Image(image.bytes);
          assetDigests[reference] = { sha256: createHash("sha256").update(image.bytes).digest("hex"), mime: image.mime, bytes: image.bytes.byteLength };
        }
        request = { ...request, assets };
        // The hash names the images by their own digests, so it identifies the request that was sent without holding the bytes.
        body = JSON.stringify({ ...JSON.parse(body), assets: assetDigests });
      }
      const headers = carriesImage || hasBox ? { [IMAGE_HEADER]: "true" } : undefined;
      // The first attempt that failed in a way the server may have billed (a lost answer, a 408, a 5xx). A later 429 does not make the call free: the give-up reports this one.
      let billable: { status?: number } | undefined;
      for (attempt = 1; ; attempt++) {
        if (signal.aborted) throw abortError();
        let result: unknown;
        try {
          result = await abortable(client.systemOne(request, {
            signal, ...(timeoutMs === null ? {} : { timeout: Math.max(1, timeoutMs - (Date.now() - started)) }), retry: { maxRetries: 0 }, ...(headers ? { headers } : {}),
          }), signal, abortError);
        } catch (error) {
          if (signal.aborted) throw abortError();
          const status = error instanceof APIError ? error.status : undefined;
          const retryable = status === 408 || status === 429 || (status !== undefined && status >= 500 && status <= 599) || error instanceof APIConnectionError;
          if (retryable && status !== 429 && billable === undefined) billable = status === undefined ? {} : { status };
          if (retryable && attempt < maxAttempts) {
            const backoff = Math.min(retryMaxMs, retryBaseMs * 2 ** (attempt - 1));
            const asked = error instanceof APIError && (status === 429 || status === 503) ? retryAfterMs(error.headers) : undefined;
            const delay = asked === undefined ? backoff : Math.max(asked, backoff);
            // A server's wait is kept in full or the loop gives up now: it never runs past the deadline, or past the longest timer when there is none, so no
            // retry is sent with no time left to answer (a request that times out has a cost no one knows).
            const left = timeoutMs === null ? 2_147_483_647 : timeoutMs - (Date.now() - started);
            if (asked === undefined || delay < left) {
              await wait(delay, signal, abortError);
              continue;
            }
          }
          // HTTP 429 means every attempt was refused unanswered; after one that may have been billed, the give-up names that one instead.
          if (status === 429 && billable) throw billable.status === undefined ? new JevError("connection", "Jev transport failed.", attempt) : new JevError("http", `Jev returned HTTP ${billable.status}.`, attempt, billable.status);
          if (status !== undefined) {
            const safeStatus = Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined;
            const capacity = error instanceof APIError && record(error.body) && record(error.body.detail)
              && error.body.detail.error_type === "max_tokens_exceeded";
            // Only the structured reason is named; the provider's body text never reaches the message.
            const returned = safeStatus === undefined ? "Jev returned an HTTP failure" : `Jev returned HTTP ${safeStatus}`;
            throw new JevError("http", capacity
              ? `${returned}: the request exceeds the model's token budget (max_tokens_exceeded). Send fewer or shorter items per request.`
              : `${returned}.`, attempt, safeStatus, undefined, capacity ? { reason: "max_tokens_exceeded" } : undefined);
          }
          if (error instanceof APIConnectionError) throw new JevError("connection", "Jev transport failed.", attempt);
          throw new JevError("invalid_request", "Jev could not process the request. Check question and transport configuration.", attempt);
        }
        if (!record(result)) throw new JevError("invalid_response", "Jev returned an invalid response.", attempt, undefined, undefined, { reason: "response_shape" });
        const answers = result.answers;
        try { validateAnswers(params.questions, answers); }
        catch (error) { throw new JevError("invalid_response", "Jev returned invalid answers or probability distributions.", attempt, undefined, undefined,
          { reason: error instanceof SystemOneError && isSystemOneResponseReason(error.responseReason) ? error.responseReason : "answer_validation" }); }
        const usage = result.usage;
        // Usage carries token counts, a provider-reported cost (USD), or both; a half pair of counts or a bad cost is invalid.
        const counted = record(usage) && tokens(usage.input_tokens) && tokens(usage.output_tokens);
        const reported = record(usage) && usage.cost !== undefined && usage.cost !== null;
        const reportedCost = reported && typeof usage.cost === "number" && Number.isFinite(usage.cost) && usage.cost >= 0 ? usage.cost : undefined;
        const noCounts = record(usage) && usage.input_tokens === undefined && usage.output_tokens === undefined;
        if (usage != null && (!record(usage) || (reported ? reportedCost === undefined || !(counted || noCounts) : !counted))) {
          throw new JevError("invalid_response", "Jev returned invalid token usage.", attempt, undefined, undefined, { reason: "token_usage" });
        }
        if (result.model != null && (typeof result.model !== "string" || !result.model.trim())) {
          throw new JevError("invalid_response", "Jev returned an invalid model identifier.", attempt, undefined, undefined, { reason: "model_identifier" });
        }
        const metering = counted ? { input_tokens: usage.input_tokens as number, output_tokens: usage.output_tokens as number } : null;
        // The provider's own cost wins; else the configured estimate; else unknown (null), never 0.
        const cost = reportedCost !== undefined ? reportedCost : pricing && metering ? (metering.input_tokens * pricing.inputUsdPerMillionTokens + metering.output_tokens * pricing.outputUsdPerMillionTokens) / 1_000_000 : null;
        if (cost !== null && !Number.isFinite(cost)) throw new JevError("invalid_response", "Jev cost estimate exceeded the numeric range.", attempt, undefined, undefined, { reason: "cost_range" });
        return {
          answers, model: typeof result.model === "string" ? result.model : null,
          usage: metering, cost_usd: cost,
          request_sha256: createHash("sha256").update(body).digest("hex"),
        };
      }
    } finally {
      clearTimeout(timer);
    }
  };
}
