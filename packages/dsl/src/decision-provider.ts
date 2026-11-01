// The seam for decision models: a DecisionProvider answers typed questions (noul, choice, score, box) about a state, fast
// and without an agent harness, and judgeFromProvider makes one the interpreter's runJudge. Jev is one provider and a
// third-party API another; each passes the conformance suite in `@parcha/agentrun-dsl/testing`.
import { createHash } from "node:crypto";
import { completeConfidence, validateAnswers, type SystemOneAnswer, type SystemOneQuestion } from "./system-one.js";
import type { DecisionImageDigest } from "./decision-receipts.js";
import type { WorkflowDeps } from "./workflow.js";

type RunJudge = NonNullable<WorkflowDeps["runJudge"]>;
type JudgeParams = Parameters<RunJudge>[0];
type JudgeResult = Awaited<ReturnType<RunJudge>>;

export type DecisionInput = "text" | "json" | "image" | "pdf" | "url";

/** What a provider answers, so a workflow or host can tell before it asks. */
export interface DecisionCapabilities {
  types: SystemOneQuestion["type"][];
  inputs: DecisionInput[];
  /** What grounds the answers: nothing, sources for the whole call, or spans per answer. */
  evidence: "none" | "citations" | "spans";
  /** Where the probabilities come from. Only "calibrated" claims to have been measured against outcomes. */
  probability: "calibrated" | "model" | "self_reported" | "none";
  /** Whether it looks things up on the web. */
  grounding: boolean;
  /** "never": a request is paid once sent, so it is never sent again unasked. The provider retries only a request that
   *  provably never reached the service (a connect error before sending) or one refused unanswered with a time to
   *  retry (a 429 with Retry-After). A failure after sending (a 408, a 5xx, a lost connection) is `outcome_unknown`,
   *  and the decision escalates as interrupted. "deduped": the provider answers a decision id it has seen with the
   *  same answer and no new charge. */
  replay: "never" | "deduped";
  /** The most questions one request may hold, or null for no limit. */
  maxQuestions: number | null;
  /** The largest state one request may hold, as UTF-8 JSON bytes, or null for no limit. */
  maxStateBytes: number | null;
  /** The models a node may pin, by name; absent or null, any name goes to the provider. */
  models?: readonly string[] | null;
}

/** An image a request carries, loaded by the host: its bytes, its type, and the reference it was loaded from. */
export interface DecisionImage { bytes: Uint8Array; mime: string; ref: string }

/** A PNG's or JPEG's width and height in pixels, read from its header (PNG's IHDR, a JPEG's first frame marker); null
 *  when the bytes are neither or the header is cut short. A provider with a size cap checks it before a paid call. */
export function imageDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  const u16 = (at: number) => (bytes[at]! << 8) | bytes[at + 1]!;
  const u32 = (at: number) => ((bytes[at]! << 24) >>> 0) + (bytes[at + 1]! << 16) + (bytes[at + 2]! << 8) + bytes[at + 3]!;
  if (bytes.length >= 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[12] === 0x49 && bytes[13] === 0x48 && bytes[14] === 0x44 && bytes[15] === 0x52) {
    return { width: u32(16), height: u32(20) };
  }
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  for (let at = 2; at + 3 < bytes.length;) {
    if (bytes[at] !== 0xff) return null;
    const marker = bytes[at + 1]!;
    if (marker === 0xff) { at++; continue; }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) { at += 2; continue; }
    // A start-of-frame marker (C0-CF but DHT C4, JPG C8 and DAC CC) holds precision, height, width.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return at + 8 < bytes.length ? { width: u16(at + 7), height: u16(at + 5) } : null;
    if (marker === 0xd9 || marker === 0xda) return null;
    at += 2 + u16(at + 2);
  }
  return null;
}

/** How a host reads an image a decision node names: `ref` is the node's resolved reference (a run-relative path). */
export type LoadImage = (ref: string, ctx: { signal: AbortSignal }) => Promise<{ bytes: Uint8Array; mime: string }>;

export type DecisionRequest = Pick<JudgeParams, "label" | "kind" | "state" | "questions" | "item" | "executionPath" | "model"> & {
  /** The images, by the token the state or a question names each with; only for a provider whose inputs include image. */
  images?: Record<string, DecisionImage>;
};

export interface DecisionContext {
  /** The decision receipt's id: the same request asked again has the same id. */
  decisionId: string;
  signal: AbortSignal;
  /** How long the provider has, every attempt included, in milliseconds; null leaves it to the provider. */
  deadlineMs: number | null;
}

/** A source an answer rests on. `scope` is "call" when the provider grounds the whole request in it, or the id of the one
 *  question it supports. */
export interface DecisionEvidence { url: string; title: string | null; excerpts: string[]; scope: string }

type WithoutConfidence<A> = A extends { confidence: unknown } ? Omit<A, "confidence"> & { confidence?: number | null } : A;
/** An answer as a provider gives it: a choice or score may lack a confidence, which judgeFromProvider derives. */
export type ProviderAnswer = SystemOneAnswer | WithoutConfidence<Extract<SystemOneAnswer, { type: "choice" | "score" }>>;

/** How a cost was reached. "unknown" goes with a null cost, never with 0. */
export type CostBasis = "reported" | "estimate" | "unknown";

export interface DecisionOutcome {
  answers: Record<string, ProviderAnswer>;
  evidence: DecisionEvidence[];
  model: string | null;
  usage: { input_tokens: number; output_tokens: number } | null;
  cost_usd: number | null;
  cost_basis: CostBasis;
  provider_request_id: string | null;
}

/** `outcome_unknown`: the request was sent and its outcome is not known (a 408, a 5xx, a connection lost after
 *  sending). It may have been answered and billed, so it is not sent again; the run escalates the decision as
 *  interrupted. */
export type DecisionProviderErrorCode = "configuration" | "auth" | "rate_limited" | "timeout" | "aborted" | "invalid_request" | "invalid_response" | "http" | "connection" | "outcome_unknown";

/** A provider's failure. Its message names what failed, never a key, a header, a request or response body. */
export class DecisionProviderError extends Error {
  readonly status?: number;
  readonly attempts: number;
  /** The provider's own reference for the failure, when it gives one. */
  readonly refId?: string;
  /** What a request that was or may have been billed is booked at (`outcome_unknown`, `invalid_response`), with how it was
   *  reached; null when unknown. */
  readonly costUsd?: number | null;
  readonly costBasis?: CostBasis;
  constructor(readonly code: DecisionProviderErrorCode, message: string, details: { status?: number; attempts?: number; refId?: string; costUsd?: number | null; costBasis?: CostBasis; cause?: unknown } = {}) {
    super(message, details.cause !== undefined ? { cause: details.cause } : undefined);
    this.name = "DecisionProviderError";
    this.attempts = details.attempts ?? 0;
    if (details.status !== undefined) this.status = details.status;
    if (details.refId !== undefined) this.refId = details.refId;
    if (details.costUsd !== undefined) this.costUsd = details.costUsd;
    if (details.costBasis !== undefined) this.costBasis = details.costBasis;
  }
}

export interface DecisionProvider {
  /** "jev", "parallel", "http:<name>" and the like. */
  readonly id: string;
  /** The environment variables it reads its keys from, by name; never their values. */
  readonly needs: readonly string[];
  readonly capabilities: DecisionCapabilities;
  decide(request: DecisionRequest, ctx: DecisionContext): Promise<DecisionOutcome>;
}

/** What a provider's error books for its request: one sent whose outcome was lost (`outcome_unknown`), or one answered
 *  with what the seam or the provider rejects (`invalid_response`), was or may have been paid for, and is booked at the
 *  cost the error carries, null when that is unknown (never 0). Undefined for an error that books nothing. */
export function chargedCost(error: unknown): number | null | undefined {
  if (!(error instanceof DecisionProviderError) || (error.code !== "outcome_unknown" && error.code !== "invalid_response")) return undefined;
  return typeof error.costUsd === "number" && Number.isFinite(error.costUsd) ? error.costUsd : null;
}

/** Refuses, as invalid_request, a request beyond what `capabilities` declares: a question type it does not answer, more
 *  questions than it takes, a larger state, or a model it does not serve. A provider calls it before it sends anything. */
export function checkCapabilities(capabilities: DecisionCapabilities, request: Pick<DecisionRequest, "questions" | "state" | "model">): void {
  if (request.model !== undefined && capabilities.models && !capabilities.models.includes(request.model)) throw new DecisionProviderError("invalid_request", `The provider does not answer with the model "${request.model}".`);
  const types = Object.values(request.questions).map((question) => question?.type);
  const unknown = types.filter((type) => !capabilities.types.includes(type));
  if (unknown.length) throw new DecisionProviderError("invalid_request", `The provider does not answer ${[...new Set(unknown)].map(String).join(", ")} questions.`);
  if (capabilities.maxQuestions !== null && types.length > capabilities.maxQuestions) throw new DecisionProviderError("invalid_request", `${types.length} questions exceed the ${capabilities.maxQuestions} one request may hold.`);
  if (capabilities.maxStateBytes !== null) {
    const bytes = Buffer.byteLength(JSON.stringify(request.state ?? null) ?? "null", "utf8");
    if (bytes > capabilities.maxStateBytes) throw new DecisionProviderError("invalid_request", `A state of ${bytes} bytes exceeds the ${capabilities.maxStateBytes} one request may hold.`);
  }
}

export interface JudgeFromProviderOptions {
  deadlineMs?: number | null;
  /** Reads the images a node names. A request with images on a host without it is refused as configuration. */
  loadImage?: LoadImage;
}

/** Loads a request's images through the host's `loadImage`, before anything is sent: a provider that takes no image input,
 *  a host that cannot load one, or an image that cannot be read is refused, and no request is made. */
async function loadImages(provider: DecisionProvider, images: Record<string, string>, loadImage: LoadImage | undefined, signal: AbortSignal): Promise<{ loaded: Record<string, DecisionImage>; digests: DecisionImageDigest[] }> {
  if (!provider.capabilities.inputs.includes("image")) throw new DecisionProviderError("invalid_request", `The provider ${provider.id} takes no image input, and the request carries ${Object.keys(images).length}.`);
  if (!loadImage) throw new DecisionProviderError("configuration", "The request carries images, and this host has no loadImage to read them.");
  const loaded: Record<string, DecisionImage> = Object.create(null);
  const digests: DecisionImageDigest[] = [];
  for (const [token, ref] of Object.entries(images)) {
    let image: { bytes: Uint8Array; mime: string };
    try { image = await loadImage(ref, { signal }); }
    catch (error) { throw new DecisionProviderError("invalid_request", `The image ${token} (${ref}) could not be read: ${String((error as Error)?.message ?? error).slice(0, 200)}`); }
    if (!(image?.bytes instanceof Uint8Array) || !image.bytes.byteLength || typeof image.mime !== "string") throw new DecisionProviderError("invalid_request", `The image ${token} (${ref}) read as no image bytes.`);
    loaded[token] = { bytes: image.bytes, mime: image.mime, ref };
    digests.push({ token, ref, sha256: createHash("sha256").update(image.bytes).digest("hex"), mime: image.mime, bytes: image.bytes.byteLength });
  }
  return { loaded: { ...loaded }, digests };
}

/** The interpreter's runJudge, answered by `provider`: the request goes to it with the decision's id, its signal and
 *  `deadlineMs`, and with the images it names, loaded through `loadImage`; a choice or score without a confidence gets one
 *  derived, and the result names each one's source and each image's digest. The answers are validated against the
 *  questions, and ones that do not match them are invalid_response. */
export function judgeFromProvider(provider: DecisionProvider, options: JudgeFromProviderOptions = {}): RunJudge {
  return async (params) => {
    const request: DecisionRequest = { label: params.label, kind: params.kind, state: params.state, questions: params.questions, ...(params.item ? { item: params.item } : {}), ...(params.executionPath !== undefined ? { executionPath: params.executionPath } : {}), ...(params.model !== undefined ? { model: params.model } : {}) };
    checkCapabilities(provider.capabilities, request);
    let digests: DecisionImageDigest[] | undefined;
    if (params.images && Object.keys(params.images).length) {
      const images = await loadImages(provider, params.images, options.loadImage, params.signal ?? new AbortController().signal);
      request.images = images.loaded;
      digests = images.digests;
    }
    const outcome = await provider.decide(request, { decisionId: params.decisionId ?? "", signal: params.signal ?? new AbortController().signal, deadlineMs: options.deadlineMs ?? null });
    const { answers, confidence_source } = completeConfidence(params.questions, (outcome.answers ?? {}) as Record<string, unknown>);
    try { validateAnswers(params.questions, answers); }
    catch (error) {
      // The provider answered, so the request was paid for: the rejection carries its cost, or null when it reported none.
      const cost = typeof outcome.cost_usd === "number" && Number.isFinite(outcome.cost_usd) ? outcome.cost_usd : null;
      throw new DecisionProviderError("invalid_response", `${provider.id} answered with ${(error as Error).message.replace(/^System One /, "")}`, { costUsd: cost, costBasis: cost === null ? "unknown" : outcome.cost_basis });
    }
    const result: JudgeResult = {
      answers, model: outcome.model, usage: outcome.usage, cost_usd: outcome.cost_usd, cost_basis: outcome.cost_basis,
      evidence: outcome.evidence, provider_request_id: outcome.provider_request_id, confidence_source,
      ...(digests ? { images: digests } : {}),
    };
    return result;
  };
}

/** The interpreter's runJudge over a host's providers: each request goes to the provider its node names, or to
 *  `default`, with the node's pinned model, within the shorter of the node's `timeoutMs` and the provider's own
 *  `deadlineMs`: a node only ever shortens it. The node's bound is kept here: when it passes, the call is cut, and a cut
 *  call may already have been sent and billed, so it is `outcome_unknown` (the decision escalates as interrupted), never
 *  asked again. The result names the provider that answered. */
export function judgeFromProviders(options: { providers: Readonly<Record<string, DecisionProvider>>; default: string; deadlineMs?: number | null; loadImage?: LoadImage }): RunJudge {
  return async (params) => {
    const id = params.provider ?? options.default;
    const provider = Object.hasOwn(options.providers, id) ? options.providers[id] : undefined;
    if (!provider) throw new DecisionProviderError("configuration", `No decision provider "${id}" on this host.`);
    const own = options.deadlineMs ?? null;
    const node = params.timeoutMs ?? null;
    const shorter = node !== null && (own === null || node < own);
    const deadlineMs = shorter ? node : own;
    const cut = new AbortController();
    const timer = shorter ? setTimeout(() => cut.abort(new DOMException("The decision node's timeoutMs passed", "TimeoutError")), node) : undefined;
    const signal = params.signal ? AbortSignal.any([params.signal, cut.signal]) : cut.signal;
    try {
      const result = await judgeFromProvider(provider, { deadlineMs, ...(options.loadImage ? { loadImage: options.loadImage } : {}) })({ ...params, signal });
      return { ...result, provider: id };
    } catch (error) {
      if (cut.signal.aborted && error instanceof DecisionProviderError && (error.code === "aborted" || error.code === "timeout")) {
        throw new DecisionProviderError("outcome_unknown", `${id}: cut by the node's timeoutMs (${node} ms) after it may have been sent`, {
          attempts: error.attempts, ...(error.costUsd !== undefined ? { costUsd: error.costUsd } : {}), ...(error.costBasis !== undefined ? { costBasis: error.costBasis } : {}), cause: error });
      }
      throw error;
    } finally { if (timer !== undefined) clearTimeout(timer); }
  };
}
