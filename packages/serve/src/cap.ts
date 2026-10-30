// A run's spend cap (`max_cost_usd`), held in the run's own process, where its model requests are sent. Before each
// request, what the run has spent plus the request's worst case must stay within the cap; else the request is not sent
// and the run's turn ends on a model error the server reads as `spend_cap_reached`. The worst case is the request's
// input (pi-ai's estimate: the last response's reported tokens plus about 3.5 characters a token after it) at the
// higher of the model's input and cache-write prices, plus its max output tokens at the output price. What the run has
// spent is read back from its store when the process starts, so it survives a restart, plus each response since; a
// request in flight holds its worst case until it answers.
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
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
export function spentIn(storeFile: string): number | null {
  if (!existsSync(storeFile)) return 0;
  const db = new DatabaseSync(storeFile, { readOnly: true });
  try {
    let spent = 0;
    for (const row of db.prepare("SELECT record FROM entries").iterate()) {
      const entry = JSON.parse(String((row as { record: string }).record)) as { kind?: string; model?: { usage?: { cost?: { total?: unknown } } }[]; data?: { usd?: unknown } };
      const total = entry.kind === "pi.assistant" ? entry.model?.[0]?.usage?.cost?.total : entry.kind === REQUEST_COST || entry.kind === REQUEST_COST_LATE ? entry.data?.usd : undefined;
      if (total === undefined && entry.kind !== "pi.assistant") continue;
      // A response or a booked request whose cost is not a number (a provider that does not price it, a request a crash
      // cut) makes what the run has spent unknown: under a cap, never read as $0.
      if (typeof total !== "number" || !Number.isFinite(total)) return null;
      spent += total;
    }
    return spent;
  } finally {
    db.close();
  }
}

/** The most output tokens one request may take: the model's ceiling, else its context window. A thinking budget can
 *  raise a request's ceiling up to the model's, whatever maxTokens it asked for. */
export const ceilingTokens = (model: Pick<Model<Api>, "maxTokens" | "contextWindow">) => (model.maxTokens > 0 ? model.maxTokens : model.contextWindow);

/** The cap of a run on another harness, before each of its requests: the runner's booking says what the run has spent
 *  (its session, across processes) and which of its requests are still in flight. */
export interface CapGuard {
  beforeRequest(request: { spentUsd: number | null; inFlight: readonly unknown[] }): undefined | { refuse: string };
}

/** A run on another harness: before each request, what the run has spent, plus the worst case of each request still in
 *  flight, plus this request's, must stay within `cap`, else the request is refused with spend_cap_reached. A request's
 *  worst case is its output ceiling at the run model's price (its input is not known before the harness sends it; a
 *  request on a cheaper model is held at that price too, which only refuses sooner). Requests in flight hold theirs until
 *  they answer, as pi's own cap holds them, so requests sent side by side cannot pass the cap together. Under a cap,
 *  whatever cannot be priced refuses, never passes as $0: a spend that is unknown (a request a crash cut), a model this
 *  process cannot find, a model with no price, and one with no output ceiling to price a request by. */
export async function capBefore(cap: number | undefined, model: Model<Api> | undefined): Promise<CapGuard | undefined> {
  if (cap === undefined) return undefined;
  const refusing = (why: string): CapGuard => ({ beforeRequest: () => ({ refuse: `${SPEND_CAP_REACHED}: the next model request was not sent. ${why}, so its cap of $${cap} cannot be kept: the run is out of budget.` }) });
  if (model === undefined) return refusing("The run's model is unknown here (model unknown)");
  const ceiling = ceilingTokens(model);
  if (!(Number.isFinite(ceiling) && ceiling > 0)) return refusing(`The model ${model.id} has no output ceiling to price a request by (no output ceiling)`);
  const { calculateCost } = await import("@earendil-works/pi-ai");
  const worst = calculateCost(model, { input: 0, output: ceiling, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }).total;
  if (!(worst > 0)) return refusing(`The model ${model.id} has no price (no price)`);
  return guardOf(cap, worst);
}

/** The guard over a request's worst case `worst`: written so that a worst case that is not a number refuses. */
export function guardOf(cap: number, worst: number): CapGuard {
  return {
    beforeRequest({ spentUsd, inFlight }) {
      if (spentUsd === null) return { refuse: `${SPEND_CAP_REACHED}: the next model request was not sent. What the run has spent is unknown, so its cap of $${cap} cannot be kept: the run is out of budget.` };
      const held = worst * inFlight.length;
      if (!(spentUsd + held + worst <= cap)) return { refuse: `${SPEND_CAP_REACHED}: the next model request was not sent. It could cost up to $${worst.toFixed(6)}, and with $${(spentUsd + held).toFixed(6)} spent or in flight the run would pass its cap of $${cap}: the run is out of budget.` };
      return undefined;
    },
  };
}

/** `models`, refusing each request whose worst case would take the run past `cap` after `spent` USD. */
export async function capModels<M extends Models>(models: M, cap: number, spent: number | null): Promise<M> {
  const [{ calculateCost, createAssistantMessageEventStream }, { estimateContextTokens }, { clampMaxTokensToContext }] = await Promise.all([
    import("@earendil-works/pi-ai"),
    import("@earendil-works/pi-ai/utils/estimate"),
    import("@earendil-works/pi-ai/api/simple-options"),
  ]);
  let held = 0;
  const priced = (model: Model<Api>, tokens: Partial<Usage>) =>
    calculateCost(model, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, ...tokens, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }).total;
  const worstCase = (model: Model<Api>, context: Context, options?: { maxTokens?: number }) => {
    const transcript = context as unknown as Parameters<typeof clampMaxTokensToContext>[1];
    const input = estimateContextTokens(transcript).tokens;
    const output = clampMaxTokensToContext(model, transcript, Math.max(options?.maxTokens ?? 0, ceilingTokens(model)));
    return Math.max(priced(model, { input, output }), priced(model, { cacheWrite: input, output }));
  };
  /** Why a request on `model` of worst case `worst` cannot be kept within the cap at all, by name; else undefined. */
  const unkept = (model: Model<Api>, worst: number): string | undefined => {
    const ceiling = ceilingTokens(model);
    if (!(Number.isFinite(ceiling) && ceiling > 0)) return `The model ${model.id} has no output ceiling to price a request by (no output ceiling)`;
    if (!(worst > 0)) return `The model ${model.id} has no price (no price)`;
    if (spent === null) return "What the run has spent is unknown";
    return undefined;
  };
  const refusal = (model: Model<Api>, worst: number, why = unkept(model, worst)): AssistantMessage => ({
    role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, stopReason: "error", timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    // "out of budget" is final to pi-ai's retry policy, whatever digits the amounts hold.
    errorMessage: why
      ? `${SPEND_CAP_REACHED}: the next model request was not sent. ${why}, so its cap of $${cap} cannot be kept: the run is out of budget.`
      : `${SPEND_CAP_REACHED}: the next model request was not sent. It could cost up to $${worst.toFixed(6)}, and with $${((spent ?? 0) + held).toFixed(6)} spent the run would pass its cap of $${cap}: the run is out of budget.`,
  });
  /** Adds what `answer` cost to what the run has spent once it settles. */
  const count = (answer: Promise<AssistantMessage>) => answer.then((message) => {
    const total = message.usage?.cost?.total;
    // An answer whose cost is not a number makes what the run has spent unknown from here on.
    spent = spent === null || typeof total !== "number" || !Number.isFinite(total) ? null : spent + total;
  }, () => undefined);
  /** Admits a request of `worst`, holding it until `answer` settles, or says why not. */
  const admit = (model: Model<Api>, worst: number, answer: () => Promise<AssistantMessage>): Promise<AssistantMessage> | undefined => {
    if (unkept(model, worst) !== undefined || spent === null || !(spent + held + worst <= cap)) return undefined;
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
      const worst = worstCase(model, context, options);
      let events: AssistantMessageEventStream | undefined;
      if (admit(model, worst, () => (events = send(model, context, options)).result())) return events!;
      const refused = createAssistantMessageEventStream();
      const message = refusal(model, worst);
      refused.push({ type: "error", reason: "error", error: message });
      refused.end(message);
      return refused;
    };
  const complete = (send: (model: Model<Api>, context: Context, options?: { maxTokens?: number }) => Promise<AssistantMessage>) =>
    (model: Model<Api>, context: Context, options?: { maxTokens?: number }): Promise<AssistantMessage> => {
      const worst = worstCase(model, context, options);
      return admit(model, worst, () => send(model, context, options)) ?? Promise.resolve(refusal(model, worst));
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
