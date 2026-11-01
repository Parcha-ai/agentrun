// OpenRouter's Decisions models (POST https://openrouter.ai/api/v1/systemone) as a DecisionProvider: the System One request
// Jev takes ({ state, model, questions }), sent to whichever Decisions model the node's `model` names, such as
// `perplexity/pplx-decider-v1.2`, `liquid/d1` or `cloudflare/clef`. A request is paid once sent, so it is sent again only
// when it provably never reached OpenRouter (a connect error before sending) or was refused with a time to retry (a 429
// with Retry-After); a 408, a 5xx, a connection lost after sending or a deadline in flight is outcome_unknown at an unknown
// cost. The cost is the response's `usage.cost`, else unknown (null, never 0). Images go in the JSON body as base64
// `assets` (OpenRouter refuses TypeSafe's multipart form), only to a model whose catalog entry lists image input; OpenRouter
// documents them as alpha, so the provider marks them experimental.
import { setTimeout as sleep } from "node:timers/promises";
import { checkCapabilities, DecisionProviderError, imageDimensions } from "@parcha/agentrun-dsl";
import type { DecisionCapabilities, DecisionContext, DecisionImage, DecisionOutcome, DecisionProvider, DecisionRequest, ProviderAnswer } from "@parcha/agentrun-dsl";

const KEY_VARIABLE = "OPENROUTER_API_KEY";
const BASE_URL = "https://openrouter.ai/api";
const IMAGE_HEADER = "TypeSafe-Danger-Zone-Images";
/** Jev's longest image side in pixels: past it TypeSafe answers HTTP 400 "Invalid image dimensions.", through OpenRouter
 *  too (live, 2026-10-30). The same cap as @parcha/agentrun-jev's JEV_MAX_IMAGE_SIDE_PX. */
const JEV_MAX_IMAGE_SIDE_PX = 1568;

export interface OpenRouterOptions {
  /** The key; otherwise OPENROUTER_API_KEY, read when a request is made. */
  apiKey?: string;
  /** API root, without /v1/systemone (default https://openrouter.ai/api). */
  baseURL?: string;
  /** The transport: a host's faux fetch replaces OpenRouter here (see `@parcha/agentrun-decisions/testing/faux-system-one`). */
  fetch?: typeof fetch;
  /** The model for a node that names none. Absent, such a node is refused: every OpenRouter decision names its model. */
  model?: string;
  /** The longest one request may take, every attempt included (default 30 s); a shorter deadline from the host wins. */
  timeoutMs?: number;
  /** Attempts for a request that never reached OpenRouter, or a 429 that says when to retry (default 3). */
  maxAttempts?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  /** Whether `model` takes image input. Absent, the public model catalog (`/v1/models?output_modalities=decisions`) is read
   *  once, through `fetch`, the first time a request carries an image; a model it does not list with image input is refused
   *  before sending. A catalog that cannot be read refuses nothing. */
  takesImages?: (model: string) => boolean | Promise<boolean>;
  /** Sent as OpenRouter's app attribution headers (HTTP-Referer, X-Title) when set. */
  app?: { url?: string; title?: string };
}

/** What a provider adds beside the seam's capabilities: the inputs not verified against the live API. */
export interface ExperimentalInputs { experimental: { inputs: readonly DecisionCapabilities["inputs"][number][]; note: string } }

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
/** Failures a request meets before it is sent: no DNS answer, no connection, no TLS handshake. Any other is after. */
const BEFORE_SENDING = new Set(["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ENETUNREACH", "EHOSTUNREACH", "UND_ERR_CONNECT_TIMEOUT",
  "CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "ERR_TLS_CERT_ALTNAME_INVALID"]);
const neverSent = (error: unknown): boolean => {
  for (let cause: unknown = error, depth = 0; isRecord(cause) || cause instanceof Error; cause = (cause as { cause?: unknown }).cause, depth++) {
    const code = (cause as { code?: unknown }).code;
    if (typeof code === "string" && BEFORE_SENDING.has(code)) return true;
    if (depth >= 4) break;
  }
  return false;
};

/** The wait a Retry-After header asks for, in milliseconds: a number of seconds, or an HTTP date (a past one is 0). */
function retryAfterMs(response: Response): number | undefined {
  const value = response.headers.get("retry-after")?.trim();
  if (!value) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(value)) return Math.round(Number(value) * 1000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}

/** The request body. OpenRouter takes JSON only (a multipart body is refused, "invalid content-type"): each image goes in
 *  `assets` under its token as `{ type: "image", format, data_base64 }`, the file in standard base64 with no `data:` prefix. */
function bodyOf(payload: Record<string, unknown>, images: Record<string, DecisionImage> | undefined): { body: string; headers: Record<string, string> } {
  const entries = Object.entries(images ?? {});
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (!entries.length) return { body: JSON.stringify(payload), headers };
  const assets = Object.fromEntries(entries.map(([token, image]) => [token, { type: "image", format: image.mime === "image/jpeg" ? "jpeg" : "png", data_base64: Buffer.from(image.bytes).toString("base64") }]));
  return { body: JSON.stringify({ ...payload, assets }), headers: { ...headers, [IMAGE_HEADER]: "true" } };
}

/** Whether `model` is Jev, which reads an image token anywhere in the state or a question, inside longer text too.
 *  OpenRouter's other Decisions models read an image only as a top-level item of an array state; anywhere else OpenRouter
 *  refuses it (live, 2026-10-30: "reads images only as top-level state items"). */
const readsTokenAnywhere = (model: string): boolean => /^~?(typesafe\/)?jev-/.test(model);

/** The state a non-Jev model reads its images in: an array state with each token a top-level item goes as it is; an object
 *  state (a workflow node's) whose tokens are top-level values goes as `[{ the other fields }, "<token>", ...]`. Null when
 *  a token stands anywhere else. */
function itemizedState(state: unknown, tokens: string[]): unknown[] | null {
  if (Array.isArray(state)) return tokens.every((token) => state.includes(token)) ? state : null;
  if (!isRecord(state)) return null;
  const isToken = (value: unknown): value is string => typeof value === "string" && tokens.includes(value);
  const placed = Object.values(state).filter(isToken);
  if (!tokens.every((token) => placed.includes(token))) return null;
  const rest = Object.fromEntries(Object.entries(state).filter(([, value]) => !isToken(value)));
  return [...(Object.keys(rest).length ? [rest] : []), ...placed];
}

/** Every string value in the state, an instruction or a criterion: the places Jev reads an image token. */
function* tokenPlaces(state: unknown, questions: DecisionRequest["questions"]): Generator<string> {
  const walk = function* (value: unknown): Generator<string> {
    if (typeof value === "string") yield value;
    else if (Array.isArray(value)) for (const each of value) yield* walk(each);
    else if (isRecord(value)) for (const each of Object.values(value)) yield* walk(each);
  };
  yield* walk(state);
  for (const question of Object.values(questions) as unknown[]) if (isRecord(question)) { yield* walk(question.instructions); yield* walk(question.criteria); }
}

/** The answers, metering and id of a 200 response, checked for shape and against the questions asked; the seam checks
 *  each answer against its question. */
function readResponse(body: unknown, questions: DecisionRequest["questions"], attempts: number): DecisionOutcome {
  // OpenRouter answered, so the request was billed: a response this rejects is booked at an unknown cost.
  const invalid = (why: string) => new DecisionProviderError("invalid_response", `OpenRouter returned ${why}.`, { attempts, costUsd: null, costBasis: "unknown" });
  if (!isRecord(body) || !isRecord(body.answers)) throw invalid("no answers");
  const given = Object.keys(body.answers);
  if (given.length !== Object.keys(questions).length || given.some((id) => !Object.hasOwn(questions, id))) throw invalid("answers that do not match the questions asked");
  const answers: Record<string, ProviderAnswer> = Object.create(null);
  for (const [id, answer] of Object.entries(body.answers)) {
    if (!isRecord(answer) || typeof answer.type !== "string") throw invalid(`an answer with no type for "${id}"`);
    answers[id] = answer as unknown as ProviderAnswer;
  }
  const usage = isRecord(body.usage) ? body.usage : undefined;
  const counted = usage && isCount(usage.input_tokens) ? { input_tokens: usage.input_tokens as number, output_tokens: isCount(usage.output_tokens) ? usage.output_tokens as number : 0 } : null;
  const cost = usage && typeof usage.cost === "number" && Number.isFinite(usage.cost) && usage.cost >= 0 ? usage.cost : null;
  return {
    answers: { ...answers }, evidence: [], model: typeof body.model === "string" && body.model.trim() ? body.model : null, usage: counted,
    cost_usd: cost, cost_basis: cost === null ? "unknown" : "reported", provider_request_id: typeof body.id === "string" ? body.id : null,
  };
}

/** The image-capable Decisions models the public catalog lists, read once; null when it cannot be read. */
function catalogReader(fetcher: typeof fetch, root: string): () => Promise<Set<string> | null> {
  let read: Promise<Set<string> | null> | undefined;
  return () => (read ??= (async () => {
    try {
      const response = await fetcher(`${root}/v1/models?output_modalities=decisions`, { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) return null;
      const body: unknown = await response.json();
      const models = isRecord(body) && Array.isArray(body.data) ? body.data : [];
      return new Set(models.filter(isRecord).filter((m) => isRecord(m.architecture) && Array.isArray(m.architecture.input_modalities) && m.architecture.input_modalities.includes("image")).map((m) => String(m.id)));
    } catch { return null; }
  })().then((set) => { if (set === null) read = undefined; return set; }));
}

export function openrouterProvider(options: OpenRouterOptions = {}): DecisionProvider & ExperimentalInputs {
  const capabilities: DecisionCapabilities = {
    types: ["noul", "choice", "score"], inputs: ["text", "json", "image"], evidence: "none", probability: "model", grounding: false,
    replay: "never", maxQuestions: null, maxStateBytes: null,
  };
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxAttempts = options.maxAttempts ?? 3;
  const retryBaseMs = options.retryBaseMs ?? 500;
  const retryMaxMs = options.retryMaxMs ?? 5_000;
  const root = (options.baseURL ?? BASE_URL).replace(/\/+$/, "");
  const url = `${root}/v1/systemone`;
  const fetcher = options.fetch ?? fetch;
  const catalog = catalogReader(fetcher, root);
  const takesImages = options.takesImages ?? (async (model: string) => (await catalog())?.has(model) ?? true);
  return {
    id: "openrouter", needs: [KEY_VARIABLE], capabilities,
    experimental: { inputs: ["image"], note: "Images to OpenRouter's Decisions models go as base64 JSON assets, an alpha OpenRouter feature; for other models each token is a whole top-level state value, sent as an item of an array state." },
    async decide(request: DecisionRequest, ctx: DecisionContext): Promise<DecisionOutcome> {
      checkCapabilities(capabilities, request);
      const model = request.model ?? options.model;
      if (typeof model !== "string" || !model.trim()) throw new DecisionProviderError("invalid_request", "An OpenRouter decision names its model (the node's model, such as liquid/d1); this one names none.");
      const images = request.images && Object.keys(request.images).length ? request.images : undefined;
      let state: unknown = request.state ?? null;
      if (images) {
        if (!(await takesImages(model))) throw new DecisionProviderError("invalid_request", `The OpenRouter model ${model} takes no image input.`);
        if (readsTokenAnywhere(model)) {
          const places = [...tokenPlaces(request.state, request.questions)];
          const unplaced = Object.keys(images).filter((token) => !places.some((text) => text.includes(token)));
          if (unplaced.length) throw new DecisionProviderError("invalid_request", `Every image token must appear in the state or a question: ${unplaced.join(", ")} does not.`);
          for (const [token, image] of Object.entries(images)) {
            const size = imageDimensions(image.bytes);
            if (size === null) throw new DecisionProviderError("invalid_request", `The image ${token} (${image.ref}) has no width and height its header can be read from; nothing was sent.`);
            if (size.width > JEV_MAX_IMAGE_SIDE_PX || size.height > JEV_MAX_IMAGE_SIDE_PX) throw new DecisionProviderError("invalid_request",
              `The image ${token} (${image.ref}) is ${size.width}x${size.height} px; Jev takes at most ${JEV_MAX_IMAGE_SIDE_PX} px on each side. Render it smaller (a letter page at 140 dpi is 1190x1540); nothing was sent.`);
          }
        } else {
          state = itemizedState(request.state, Object.keys(images));
          if (state === null) throw new DecisionProviderError("invalid_request", `The OpenRouter model ${model} reads an image only where the state holds its token as a whole top-level value, such as state: { "page": "${Object.keys(images)[0]}" }; not inside text or a question.`);
        }
      }
      const key = options.apiKey ?? process.env[KEY_VARIABLE];
      if (typeof key !== "string" || !key.trim()) throw new DecisionProviderError("configuration", `${KEY_VARIABLE} is not set.`);
      const payload = { state, model, questions: request.questions };
      const budgetMs = Math.min(timeoutMs, ctx.deadlineMs ?? Infinity);
      const deadlineAt = Date.now() + budgetMs;
      const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(budgetMs)]);
      const stopped = (attempts: number) => new DecisionProviderError("aborted", "The OpenRouter request was cancelled.", { attempts });
      // Sent and lost: it may have been answered and billed, so it is never sent again, at an unknown cost.
      const lost = (attempts: number, what: string, status?: number) => new DecisionProviderError("outcome_unknown", `OpenRouter ${what} after the request was sent; it may have been answered, and is not sent again.`, { attempts, ...(status !== undefined ? { status } : {}), costUsd: null, costBasis: "unknown" });
      const app = { ...(options.app?.url ? { "HTTP-Referer": options.app.url } : {}), ...(options.app?.title ? { "X-Title": options.app.title } : {}) };
      for (let attempt = 1; ; attempt++) {
        // A form body is read as it is sent, so each attempt builds its own.
        const { body, headers } = bodyOf(payload, images);
        let response: Response;
        try {
          response = await fetcher(url, { method: "POST", headers: { ...headers, ...app, authorization: `Bearer ${key}` }, body, signal });
        } catch (error) {
          if (signal.aborted) throw ctx.signal.aborted ? stopped(attempt) : lost(attempt, "passed its deadline");
          if (!neverSent(error)) throw lost(attempt, "lost the connection");
          if (attempt >= maxAttempts) throw new DecisionProviderError("connection", "OpenRouter could not be reached.", { attempts: attempt });
          await sleep(Math.min(retryMaxMs, retryBaseMs * 2 ** (attempt - 1)), undefined, { signal }).catch(() => { throw ctx.signal.aborted ? stopped(attempt) : new DecisionProviderError("timeout", "OpenRouter could not be reached before the deadline.", { attempts: attempt }); });
          continue;
        }
        if (response.ok) {
          let text: string;
          try { text = await response.text(); }
          catch { throw ctx.signal.aborted ? stopped(attempt) : lost(attempt, signal.aborted ? "passed its deadline" : "lost the connection while the answer was read"); }
          let parsed: unknown;
          try { parsed = JSON.parse(text); }
          catch { throw new DecisionProviderError("invalid_response", "OpenRouter returned a body that is not JSON.", { attempts: attempt, costUsd: null, costBasis: "unknown" }); }
          return readResponse(parsed, request.questions, attempt);
        }
        const status = response.status;
        if (status === 408 || (status >= 500 && status <= 599)) { void response.body?.cancel().catch(() => {}); throw lost(attempt, `answered HTTP ${status}`, status); }
        // A 429 was refused unanswered; it is sent again only when OpenRouter says when, and only if that is before the deadline.
        const wait = status === 429 ? retryAfterMs(response) : undefined;
        if (wait !== undefined && attempt < maxAttempts && wait < deadlineAt - Date.now()) {
          void response.body?.cancel().catch(() => {});
          await sleep(wait, undefined, { signal }).catch(() => { throw ctx.signal.aborted ? stopped(attempt) : new DecisionProviderError("rate_limited", `OpenRouter rate-limited the request after ${attempt} attempts.`, { status, attempts: attempt }); });
          continue;
        }
        void response.body?.cancel().catch(() => {});
        const details = { status, attempts: attempt };
        if (status === 401 || status === 403) throw new DecisionProviderError("auth", `OpenRouter refused the key (HTTP ${status}).`, details);
        if (status === 400 || status === 404 || status === 422) throw new DecisionProviderError("invalid_request", `OpenRouter refused the request (HTTP ${status}).`, details);
        if (status === 429) throw new DecisionProviderError("rate_limited", `OpenRouter rate-limited the request after ${attempt} attempts.`, details);
        throw new DecisionProviderError("http", `OpenRouter answered HTTP ${status}.`, details);
      }
    },
  };
}
