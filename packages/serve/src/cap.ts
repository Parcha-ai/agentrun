// A run's spend cap (`max_cost_usd`), held in the run's own process, where its model requests are sent. Before each
// request, what the run has spent plus the request's worst case must stay within the cap; else the request is not sent
// and the run's turn ends on a model error the server reads as `spend_cap_reached`. The worst case is the request's
// input (pi-ai's estimate: the last response's reported tokens plus about 3.5 characters a token after it) at the
// higher of the model's input and cache-write prices, plus its max output tokens at the output price. What the run has
// spent is read back from its store when the process starts, so it survives a restart, plus each response since; a
// request in flight holds its worst case until it answers.
import { existsSync } from "node:fs";
import type { Api, AssistantMessage, AssistantMessageEventStream, Context, Model, Models, Usage } from "@earendil-works/pi-ai";
import { storeRecords } from "./files.js";

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

/** What the run's store says its model requests cost: every response of every conversation in it. */
export function spentIn(storeFile: string): number {
  if (!existsSync(storeFile)) return 0;
  let spent = 0;
  for (const entry of storeRecords(storeFile, "SELECT record FROM entries") as { kind?: string; model?: { usage?: { cost?: { total?: unknown } } }[] }[]) {
    const total = entry.kind === "pi.assistant" ? entry.model?.[0]?.usage?.cost?.total : undefined;
    if (typeof total === "number" && Number.isFinite(total)) spent += total;
  }
  return spent;
}

/** `models`, refusing each request whose worst case would take the run past `cap` after `spent` USD. */
export async function capModels<M extends Models>(models: M, cap: number, spent: number): Promise<M> {
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
    // A thinking budget can raise a request's ceiling up to the model's, whatever maxTokens it asked for; a model that
    // names no ceiling sends none, and answers within its context window.
    const ceiling = model.maxTokens > 0 ? model.maxTokens : model.contextWindow;
    const output = clampMaxTokensToContext(model, transcript, Math.max(options?.maxTokens ?? 0, ceiling));
    return Math.max(priced(model, { input, output }), priced(model, { cacheWrite: input, output }));
  };
  const refusal = (model: Model<Api>, worst: number): AssistantMessage => ({
    role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, stopReason: "error", timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    // "out of budget" is final to pi-ai's retry policy, whatever digits the amounts hold.
    errorMessage: `${SPEND_CAP_REACHED}: the next model request was not sent. It could cost up to $${worst.toFixed(6)}, and with $${(spent + held).toFixed(6)} spent the run would pass its cap of $${cap}: the run is out of budget.`,
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
      const worst = worstCase(model, context, options);
      let events: AssistantMessageEventStream | undefined;
      if (admit(worst, () => (events = send(model, context, options)).result())) return events!;
      const refused = createAssistantMessageEventStream();
      const message = refusal(model, worst);
      refused.push({ type: "error", reason: "error", error: message });
      refused.end(message);
      return refused;
    };
  const complete = (send: (model: Model<Api>, context: Context, options?: { maxTokens?: number }) => Promise<AssistantMessage>) =>
    (model: Model<Api>, context: Context, options?: { maxTokens?: number }): Promise<AssistantMessage> => {
      const worst = worstCase(model, context, options);
      return admit(worst, () => send(model, context, options)) ?? Promise.resolve(refusal(model, worst));
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
