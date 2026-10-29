// A run's spend cap (`max_cost_usd`), held in the run's own process, where its model requests are sent. Before each
// request, what the run has spent plus the request's worst case must stay within the cap; else the request is not sent
// and the run's turn ends on a model error the server reads as `spend_cap_reached`. The worst case is the request's
// input bound (inputBound: one token per UTF-8 byte of what is sent, plus what the provider adds server-side) at the
// higher of the model's input and cache-write prices, plus its max output tokens at the output price. A model serve has
// no price for cannot be kept within a cap, so under one its requests are refused; a model listed at $0 is a known $0. What the run has
// spent is read back from its store when the process starts, so it survives a restart, plus each response since; a
// request in flight holds its worst case until it answers.
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { providerInputOverhead } from "@parcha/agentrun-adapters/host";
import { REQUEST_COST, REQUEST_COST_LATE } from "@parcha/pi-durable-agent/timeline";
import type { Api, AssistantMessage, AssistantMessageEventStream, Context, Model, Models, Usage } from "@earendil-works/pi-ai";

/** A run's cap in USD, passed to its process. */
export const CAP_ENV = "AGENTRUN_SERVE_MAX_COST_USD";
/** How a request the cap refused begins its error, which the server ends the run with. */
export const SPEND_CAP_REACHED = "spend_cap_reached";

/** The run's cap from its process's environment; absent for a run without one. */
export function capOf(env: NodeJS.ProcessEnv): number | undefined {
  const text = env[CAP_ENV];
  if (text === undefined || text === "") return undefined;
  const cap = Number(text);
  if (!(Number.isFinite(cap) && cap > 0)) throw new Error(`${CAP_ENV} is ${text}, not a number above 0`);
  return cap;
}

/** What the run's store says its model requests cost: every response of every conversation in it, and each cost
 *  written apart from a response (a compaction summary's; a harness request's that came in after its answer). */
export function spentIn(storeFile: string): number {
  if (!existsSync(storeFile)) return 0;
  const db = new DatabaseSync(storeFile, { readOnly: true });
  try {
    let spent = 0;
    for (const row of db.prepare("SELECT record FROM entries").iterate()) {
      const entry = JSON.parse(String((row as { record: string }).record)) as { kind?: string; model?: { usage?: { cost?: { total?: unknown } } }[]; data?: { usd?: unknown } };
      const total = entry.kind === "pi.assistant" ? entry.model?.[0]?.usage?.cost?.total : entry.kind === REQUEST_COST || entry.kind === REQUEST_COST_LATE ? entry.data?.usd : undefined;
      if (typeof total === "number" && Number.isFinite(total)) spent += total;
    }
    return spent;
  } finally {
    db.close();
  }
}

/** The most output tokens one request may take: the model's ceiling, else its context window. A thinking budget can
 *  raise a request's ceiling up to the model's, whatever maxTokens it asked for. */
export const ceilingTokens = (model: Pick<Model<Api>, "maxTokens" | "contextWindow">) => (model.maxTokens > 0 ? model.maxTokens : model.contextWindow);

/** A request's input tokens, bounded above: one per UTF-8 byte of what is sent (a byte-level tokenizer never takes
 *  fewer than one byte a token, and an image's base64 is far more bytes than its tokens), plus `overhead`, what the
 *  provider adds server-side that the body does not hold. The same bound on every harness. */
export const inputBound = (sent: string, overhead = 0): number => Buffer.byteLength(sent, "utf8") + overhead;

/** What pi's provider adds server-side to a request of `context`, the same table the model proxy uses, by the model's API
 *  kind: undefined for a kind whose additions are not known. The context does not say how the request chooses a tool,
 *  so the dearer choice is taken. */
export function piOverhead(model: Pick<Model<Api>, "api">, context: Context): number | undefined {
  const parts = (context.messages ?? []).flatMap((message) => (Array.isArray((message as { content?: unknown }).content) ? ((message as { content: { type?: unknown }[] }).content) : []));
  return providerInputOverhead(model.api, { tools: (context.tools?.length ?? 0) > 0, toolChoice: "any", images: parts.filter((part) => part?.type === "image").length });
}

const unmeasured = (cap: number) => `${SPEND_CAP_REACHED}: the next model request was not sent. The size of a request's input is unknown, so the run's cap of $${cap} cannot be kept: the run is out of budget.`;

const noPrice = (cap: number) => `${SPEND_CAP_REACHED}: the next model request was not sent. Its model has no price here, so the run's cap of $${cap} cannot be kept: the run is out of budget.`;

/** A request's worst case at `model`'s price: `input` tokens at the dearer of its input and cache-write prices, and
 *  `output` tokens at its output price. */
function worstOf(calculateCost: typeof import("@earendil-works/pi-ai").calculateCost, model: Model<Api>): (input: number, output: number) => number {
  const priced = (tokens: Partial<Usage>) => calculateCost(model, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, ...tokens, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }).total;
  return (input, output) => Math.max(priced({ input, output }), priced({ cacheWrite: input, output }));
}

/** The cap of a run on another harness, before each of its requests: the runner's booking says what the run has spent
 *  (its session, across processes) and which of its requests are still in flight, and the model proxy each request's
 *  input bound (`inputTokensMax`, inputBound of its body; undefined when the body could not be measured). */
export interface CapGuard {
  beforeRequest(request: { spentUsd: number | null; inFlight: readonly { inputTokensMax?: number }[]; inputTokensMax?: number }): undefined | { refuse: string };
}

/** A run on another harness: before each request, what the run has spent, plus the worst case of each request still in
 *  flight, plus this request's, must stay within `cap`, else the request is refused with spend_cap_reached. A request's
 *  worst case is its input bound and its output ceiling at the run model's price, as on pi (a request on a cheaper model
 *  is held at that price too, which only refuses sooner). Requests in flight hold theirs until they answer, so requests
 *  sent side by side cannot pass the cap together. What cannot be kept within a cap is refused under one: a spend that
 *  is unknown (a request a crash cut), an input that could not be measured, and a model serve has no price for
 *  (`listed: false`, or none at all). With no cap, nothing is refused. */
export async function capBefore(cap: number | undefined, model: Model<Api> | undefined, { listed = true }: { listed?: boolean } = {}): Promise<CapGuard | undefined> {
  if (cap === undefined) return undefined;
  if (model === undefined || !listed) return { beforeRequest: () => ({ refuse: noPrice(cap) }) };
  const price = worstOf((await import("@earendil-works/pi-ai")).calculateCost, model);
  const output = ceilingTokens(model);
  return {
    beforeRequest({ spentUsd, inFlight, inputTokensMax }) {
      if (spentUsd === null) return { refuse: `${SPEND_CAP_REACHED}: the next model request was not sent. What the run has spent is unknown, so its cap of $${cap} cannot be kept: the run is out of budget.` };
      const inputs = [inputTokensMax, ...inFlight.map((request) => request.inputTokensMax)];
      if (inputs.some((input) => typeof input !== "number" || !Number.isFinite(input))) return { refuse: unmeasured(cap) };
      const worst = price(inputTokensMax!, output);
      const held = inFlight.reduce((sum, request) => sum + price(request.inputTokensMax!, output), 0);
      if (spentUsd + held + worst > cap) return { refuse: `${SPEND_CAP_REACHED}: the next model request was not sent. It could cost up to $${worst.toFixed(6)}, and with $${(spentUsd + held).toFixed(6)} spent or in flight the run would pass its cap of $${cap}: the run is out of budget.` };
      return undefined;
    },
  };
}

/** `models`, refusing each request whose worst case would take the run past `cap` after `spent` USD, and, under the cap,
 *  each request to a model in `unpriced` (one serve has no price for) or whose input cannot be bounded. A request's input
 *  is inputBound of its context, plus `overhead(model, context)` (piOverhead), what its provider adds server-side;
 *  undefined is unmeasured, never 0. */
export async function capModels<M extends Models>(models: M, cap: number, spent: number, { unpriced = new Set<string>(), overhead = piOverhead }: { unpriced?: ReadonlySet<string>; overhead?: (model: Model<Api>, context: Context) => number | undefined } = {}): Promise<M> {
  const [{ calculateCost, createAssistantMessageEventStream }, { clampMaxTokensToContext }] = await Promise.all([
    import("@earendil-works/pi-ai"),
    import("@earendil-works/pi-ai/api/simple-options"),
  ]);
  let held = 0;
  const worstCase = (model: Model<Api>, context: Context, options?: { maxTokens?: number }) => {
    const transcript = context as unknown as Parameters<typeof clampMaxTokensToContext>[1];
    const added = overhead(model, context);
    if (added === undefined) return undefined;
    const input = inputBound(JSON.stringify(context), added);
    const output = clampMaxTokensToContext(model, transcript, Math.max(options?.maxTokens ?? 0, ceilingTokens(model)));
    return worstOf(calculateCost, model)(input, output);
  };
  const refusal = (model: Model<Api>, worst: number | undefined, why = noPrice(cap)): AssistantMessage => ({
    role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, stopReason: "error", timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    // "out of budget" is final to pi-ai's retry policy, whatever digits the amounts hold.
    errorMessage: worst === undefined ? why : `${SPEND_CAP_REACHED}: the next model request was not sent. It could cost up to $${worst.toFixed(6)}, and with $${(spent + held).toFixed(6)} spent the run would pass its cap of $${cap}: the run is out of budget.`,
  });
  /** Adds what `answer` cost to what the run has spent once it settles. */
  const count = (answer: Promise<AssistantMessage>) => answer.then((message) => void (spent += message.usage?.cost?.total ?? 0), () => undefined);
  /** Admits a request of `worst`, holding it until `answer` settles, or says why not. */
  const admit = (worst: number, answer: () => Promise<AssistantMessage>): Promise<AssistantMessage> | undefined => {
    if (spent + held + worst > cap) return undefined;
    held += worst;
    let answered: Promise<AssistantMessage>;
    try {
      answered = answer();
    } catch (error) {
      held -= worst;
      throw error;
    }
    void count(answered).finally(() => void (held -= worst));
    return answered;
  };
  const stream = (send: (model: Model<Api>, context: Context, options?: { maxTokens?: number }) => AssistantMessageEventStream) =>
    (model: Model<Api>, context: Context, options?: { maxTokens?: number }): AssistantMessageEventStream => {
      const worst = unpriced.has(model.id) ? undefined : worstCase(model, context, options);
      let events: AssistantMessageEventStream | undefined;
      if (worst !== undefined && admit(worst, () => (events = send(model, context, options)).result())) return events!;
      const refused = createAssistantMessageEventStream();
      const message = refusal(model, worst, unpriced.has(model.id) ? noPrice(cap) : unmeasured(cap));
      refused.push({ type: "error", reason: "error", error: message });
      refused.end(message);
      return refused;
    };
  const complete = (send: (model: Model<Api>, context: Context, options?: { maxTokens?: number }) => Promise<AssistantMessage>) =>
    (model: Model<Api>, context: Context, options?: { maxTokens?: number }): Promise<AssistantMessage> => {
      const worst = unpriced.has(model.id) ? undefined : worstCase(model, context, options);
      return (worst === undefined ? undefined : admit(worst, () => send(model, context, options))) ?? Promise.resolve(refusal(model, worst, unpriced.has(model.id) ? noPrice(cap) : unmeasured(cap)));
    };
  const guarded: Record<PropertyKey, unknown> = {
    stream: stream(models.stream.bind(models) as never),
    streamSimple: stream(models.streamSimple.bind(models) as never),
    complete: complete(models.complete.bind(models) as never),
    completeSimple: complete(models.completeSimple.bind(models) as never),
    // A deferred response was admitted when it was sent; what it cost is counted when it is fetched.
    streamDeferred: (...args: Parameters<Models["streamDeferred"]>) => {
      const events = models.streamDeferred(...args);
      void count(events.result());
      return events;
    },
    fetchDeferred: (...args: Parameters<Models["fetchDeferred"]>) => {
      const answer = models.fetchDeferred(...args);
      void count(answer);
      return answer;
    },
  };
  return new Proxy(models, {
    get: (target, key) => {
      if (key in guarded) return guarded[key];
      const value = Reflect.get(target, key, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** `models`, with each answer of a model in `unpriced` (one serve has no price for, priced $0 by pi-ai) at an unknown
 *  cost: its cost fields are null, which the run's timeline reads as unknown and pi-durable's sums take as nothing. */
export async function unknownCost<M extends Models>(models: M, unpriced: ReadonlySet<string>): Promise<M> {
  if (!unpriced.size) return models;
  const { createAssistantMessageEventStream } = await import("@earendil-works/pi-ai");
  const unknown = (message: AssistantMessage | undefined) => {
    if (message?.usage) message.usage.cost = { input: null, output: null, cacheRead: null, cacheWrite: null, total: null } as never;
    return message;
  };
  const stream = (send: (model: Model<Api>, context: Context, options?: unknown) => AssistantMessageEventStream) =>
    (model: Model<Api>, context: Context, options?: unknown): AssistantMessageEventStream => {
      const inner = send(model, context, options);
      if (!unpriced.has(model.id)) return inner;
      const outer = createAssistantMessageEventStream();
      void (async () => {
        for await (const event of inner) {
          if ("message" in event) unknown(event.message as AssistantMessage);
          if ("error" in event) unknown(event.error as AssistantMessage);
          outer.push(event);
        }
        outer.end(unknown(await inner.result())!);
      })();
      return outer;
    };
  const complete = (send: (model: Model<Api>, context: Context, options?: unknown) => Promise<AssistantMessage>) =>
    async (model: Model<Api>, context: Context, options?: unknown): Promise<AssistantMessage> => {
      const answer = await send(model, context, options);
      return unpriced.has(model.id) ? unknown(answer)! : answer;
    };
  const guarded: Record<PropertyKey, unknown> = {
    stream: stream(models.stream.bind(models) as never),
    streamSimple: stream(models.streamSimple.bind(models) as never),
    complete: complete(models.complete.bind(models) as never),
    completeSimple: complete(models.completeSimple.bind(models) as never),
  };
  return new Proxy(models, {
    get: (target, key) => {
      if (key in guarded) return guarded[key];
      const value = Reflect.get(target, key, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
