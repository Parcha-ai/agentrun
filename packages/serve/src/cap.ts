// A run's spend cap (`max_cost_usd`), held in the run's own process, where its model requests are sent. Before each
// request, what the run has spent plus the request's worst case must stay within the cap; else the request is not sent
// and the run's turn ends on a model error the server reads as `spend_cap_reached`. The worst case is the request's
// input bound (inputBound: one token per UTF-8 byte of what is sent, plus what the provider adds server-side) at the
// higher of the model's input and cache-write prices, plus its max output tokens at the output price. A model serve has
// no price for cannot be kept within a cap, so under one its requests are refused; a model listed at $0 is a known $0. What the run has
// spent is read back from its store when the process starts, so it survives a restart, plus each response since; a
// request in flight holds its worst case until it answers. A request stopped before its end counts at that worst case,
// the most the provider can have billed for it, since a cut stream's own usage is not what it charged; the figure is
// written on the request's end mark (request-start.ts), so a later process counts it the same. Nor can a spend no one
// knows (a request a crash cut, a cost that is not a number) or a model whose output is priced and that has no output
// ceiling be kept within a cap: under one, each refuses the request, never passes as $0.
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { providerInputOverhead } from "@parcha/agentrun-adapters/host";
import { type EntryLike, REQUEST_COST, REQUEST_COST_LATE, REQUEST_ENDED, REQUEST_STARTED, timelineOf } from "@parcha/pi-durable-agent/timeline";
import type { Api, AssistantMessage, AssistantMessageEventStream, Context, Model, Models, Usage } from "@earendil-works/pi-ai";

/** A run's cap in USD, passed to its process. */
export const CAP_ENV = "AGENTRUN_SERVE_MAX_COST_USD";
/** How a request the cap refused begins its error, which the server ends the run with. */
export const SPEND_CAP_REACHED = "spend_cap_reached";
/** The option a request's worst case rides on from the cap to its marks (request-start.ts): what the cap held for it. A
 *  symbol, so no provider ever sends it. */
export const HELD_USD = Symbol.for("agentrun.serve.held_usd");
/** The field of a request's end mark (REQUEST_ENDED) that says what the cap held for it, when its stream ended aborted
 *  or its summary failed: the request counts at that figure. Optional: an end with none (an older store, a run with no
 *  cap) leaves the request cut, at an unknown cost. */
export const HELD_FIELD = "heldUsd";
/** The field of the start mark (REQUEST_STARTED) written for a request this cap refused: it never left, and pi's error
 *  entry for it answers this mark, never an earlier request's. */
export const CAP_REFUSED_FIELD = "capRefused";

/** The run's cap from its process's environment; absent for a run without one. */
export function capOf(env: NodeJS.ProcessEnv): number | undefined {
  const text = env[CAP_ENV];
  if (text === undefined || text === "") return undefined;
  const cap = Number(text);
  if (!(Number.isFinite(cap) && cap > 0)) throw new Error(`${CAP_ENV} is ${text}, not a number above 0`);
  return cap;
}

/** Whether `entry` is pi's answer to a request this cap refused (capModels): an error that begins spend_cap_reached. */
const refusedHere = (entry: EntryLike): boolean => {
  const message = entry.kind === "pi.assistant" ? (entry.model?.[0] as { stopReason?: unknown; errorMessage?: unknown } | undefined) : undefined;
  return message?.stopReason === "error" && typeof message.errorMessage === "string" && message.errorMessage.startsWith(`${SPEND_CAP_REACHED}:`);
};

/** The cost an entry adds to what a run spent, as the timeline counts it: a pi answer's total (none for one stopped before
 *  its end), and the usd of a cost written apart from an answer; 0 for anything else, or for a cost that is not a number
 *  (which makes the whole spend unknown, by the timeline's verdict). */
const costOf = (entry: EntryLike): number => {
  const message = entry.kind === "pi.assistant" ? (entry.model?.[0] as { stopReason?: unknown; usage?: { cost?: { total?: unknown } } } | undefined) : undefined;
  const cost = message ? (message.stopReason === "aborted" ? undefined : message.usage?.cost?.total)
    : entry.kind === REQUEST_COST || entry.kind === REQUEST_COST_LATE ? (entry.data as { usd?: unknown } | undefined)?.usd : undefined;
  return typeof cost === "number" && Number.isFinite(cost) ? cost : 0;
};

/** What the run's store says its model requests cost, across every conversation in it: known or not as the run's own
 *  timeline says (pi-durable-agent's timelineOf), read as a settled run, since the process that wrote it is gone, and
 *  then the full amount, never the timeline's total rounded for display. Every response,
 *  and each cost written apart from one (a compaction summary's; a harness request's that came in after its answer).
 *  Every rule the timeline keeps for a cost no one knows holds here: a request or compaction marked as sent with no
 *  answer (a crash cut it, and it may have been billed), a cost that is not a number, a cost still pending. Two readings
 *  are the cap's own, on its copy of the entries (the run's shown cost is the timeline's, unchanged): a request stopped
 *  before its end counts at the figure its end mark holds (HELD_FIELD), and with none is cut, at an unknown cost; and
 *  this cap's refusals are left out, as none left. Unknown is null, which a cap never reads as $0. */
export function spentIn(storeFile: string): number | null {
  if (!existsSync(storeFile)) return 0;
  const db = new DatabaseSync(storeFile, { readOnly: true });
  const entries: EntryLike[] = [];
  let marked = false;
  try {
    for (const row of db.prepare("SELECT record FROM entries ORDER BY rowid").iterate()) {
      const entry = JSON.parse(String((row as { record: string }).record)) as EntryLike;
      const data = (entry.data ?? {}) as Record<string, unknown>;
      // A request this cap refused never left, and costs nothing: its mark and pi's error entry for it (an older store
      // has the entry alone, which the timeline would count as answering an earlier request a crash cut).
      if (refusedHere(entry) || (entry.kind === REQUEST_STARTED && data[CAP_REFUSED_FIELD] === true)) continue;
      if (entry.kind === REQUEST_STARTED) marked = true;
      // pi's entry for a marked request stopped before its end (what had streamed of it): the request is counted by its
      // marks instead, at the figure its end holds, or cut. Before the first mark (an older run) it stays unknown.
      if (marked && entry.kind === "pi.assistant" && (entry.model?.[0] as { stopReason?: unknown } | undefined)?.stopReason === "aborted") continue;
      entries.push(entry);
      const held = data[HELD_FIELD];
      if (entry.kind !== REQUEST_ENDED || data.unsent === true || typeof held !== "number" || !Number.isFinite(held)) continue;
      // The stopped request closed at what the cap held for it: a summary by its cost, a generation by an answer.
      entries.push(data.request === "compaction"
        ? { kind: REQUEST_COST, data: { request: "compaction", usd: held } }
        : { kind: "pi.assistant", ...(entry.conversationId !== undefined ? { conversationId: entry.conversationId } : {}), model: [{ role: "assistant", content: [], stopReason: "stop", usage: { cost: { total: held } }, timestamp: 0 }] });
    }
  } finally {
    db.close();
  }
  // The timeline says whether the spend is known; the amount is summed here, as it is, since the timeline rounds its total
  // for display (to the millionth of a dollar), and a cap must not lose what that drops.
  const usage = timelineOf(entries, { settled: true }).find((row) => row.kind === "usage")?.usage;
  if (usage === undefined) return 0;
  if (typeof usage.usd !== "number" || !Number.isFinite(usage.usd)) return null;
  return entries.reduce((sum, entry) => sum + costOf(entry), 0);
}

/** The most output tokens one request may take: the model's ceiling, else its context window. A thinking budget can
 *  raise a request's ceiling up to the model's, whatever maxTokens it asked for. */
export const ceilingTokens = (model: Pick<Model<Api>, "maxTokens" | "contextWindow">) => (model.maxTokens > 0 ? model.maxTokens : model.contextWindow);

/** The output tokens a request's worst case is priced at: the model's ceiling; none when the model names no ceiling and
 *  its output costs nothing at every price tier, so any number of output tokens is $0; undefined when its output is
 *  priced and it names no ceiling, so nothing bounds what a request may cost. */
function outputBound(model: Pick<Model<Api>, "maxTokens" | "contextWindow" | "cost">): number | undefined {
  const ceiling = ceilingTokens(model);
  if (Number.isFinite(ceiling) && ceiling > 0) return ceiling;
  return [model.cost, ...(model.cost?.tiers ?? [])].every((rates) => rates?.output === 0) ? 0 : undefined;
}

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

const noCeiling = (cap: number) => `${SPEND_CAP_REACHED}: the next model request was not sent. Its model has no output ceiling here and its output is priced, so what a request may cost has no bound and the run's cap of $${cap} cannot be kept: the run is out of budget.`;

const unknownSpend = (cap: number) => `${SPEND_CAP_REACHED}: the next model request was not sent. What the run has spent is unknown, so its cap of $${cap} cannot be kept: the run is out of budget.`;

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
 *  is unknown (a request a crash cut), an input that could not be measured, a model serve has no price for
 *  (`listed: false`, or none at all), and a model whose output is priced and that has no output ceiling. With no cap,
 *  nothing is refused. */
export async function capBefore(cap: number | undefined, model: Model<Api> | undefined, { listed = true }: { listed?: boolean } = {}): Promise<CapGuard | undefined> {
  if (cap === undefined) return undefined;
  if (model === undefined || !listed) return { beforeRequest: () => ({ refuse: noPrice(cap) }) };
  const output = outputBound(model);
  if (output === undefined) return { beforeRequest: () => ({ refuse: noCeiling(cap) }) };
  const price = worstOf((await import("@earendil-works/pi-ai")).calculateCost, model);
  return {
    beforeRequest({ spentUsd, inFlight, inputTokensMax }) {
      if (spentUsd === null) return { refuse: unknownSpend(cap) };
      const inputs = [inputTokensMax, ...inFlight.map((request) => request.inputTokensMax)];
      if (inputs.some((input) => typeof input !== "number" || !Number.isFinite(input))) return { refuse: unmeasured(cap) };
      const worst = price(inputTokensMax!, output);
      const held = inFlight.reduce((sum, request) => sum + price(request.inputTokensMax!, output), 0);
      // Written so that a worst case that is not a number refuses.
      if (!(spentUsd + held + worst <= cap)) return { refuse: `${SPEND_CAP_REACHED}: the next model request was not sent. It could cost up to $${worst.toFixed(6)}, and with $${(spentUsd + held).toFixed(6)} spent or in flight the run would pass its cap of $${cap}: the run is out of budget.` };
      return undefined;
    },
  };
}

/** `models`, refusing each request whose worst case would take the run past `cap` after `spent` USD, and, under the cap,
 *  each request to a model in `unpriced` (one serve has no price for) or whose output is priced and that has no output
 *  ceiling, each whose input cannot be bounded, and every request once what the run has spent is unknown: `spent` null
 *  (spentIn), or an answer since whose cost is unknown. A request's input is inputBound of its context, plus
 *  `overhead(model, context)` (piOverhead), what its provider adds server-side; undefined is unmeasured, never 0. Each
 *  request sent carries its worst case (HELD_USD) to the marks below, and one stopped before its end counts at it.
 *  `refused` (markRequests') writes the start mark of a refused model request before pi writes its error entry. */
export async function capModels<M extends Models>(models: M, cap: number, spent: number | null, { unpriced = new Set<string>(), overhead = piOverhead, refused: markRefused }: { unpriced?: ReadonlySet<string>; overhead?: (model: Model<Api>, context: Context) => number | undefined; refused?: () => Promise<void> } = {}): Promise<M> {
  const [{ calculateCost, createAssistantMessageEventStream }, { clampMaxTokensToContext }] = await Promise.all([
    import("@earendil-works/pi-ai"),
    import("@earendil-works/pi-ai/api/simple-options"),
  ]);
  let held = 0;
  const worstCase = (model: Model<Api>, context: Context, ceiling: number, options?: { maxTokens?: number }) => {
    const transcript = context as unknown as Parameters<typeof clampMaxTokensToContext>[1];
    const added = overhead(model, context);
    if (added === undefined) return undefined;
    const input = inputBound(JSON.stringify(context), added);
    const output = ceiling === 0 ? 0 : clampMaxTokensToContext(model, transcript, Math.max(options?.maxTokens ?? 0, ceiling));
    return worstOf(calculateCost, model)(input, output);
  };
  /** A request's worst case, or why the cap refuses it. */
  const judge = (model: Model<Api>, context: Context, options?: { maxTokens?: number }): { worst: number } | { why: string } => {
    if (unpriced.has(model.id)) return { why: noPrice(cap) };
    const ceiling = outputBound(model);
    if (ceiling === undefined) return { why: noCeiling(cap) };
    if (spent === null) return { why: unknownSpend(cap) };
    const worst = worstCase(model, context, ceiling, options);
    if (worst === undefined) return { why: unmeasured(cap) };
    // Written so that a worst case that is not a number refuses.
    if (!(spent + held + worst <= cap)) return { why: `${SPEND_CAP_REACHED}: the next model request was not sent. It could cost up to $${worst.toFixed(6)}, and with $${(spent + held).toFixed(6)} spent the run would pass its cap of $${cap}: the run is out of budget.` };
    return { worst };
  };
  const refusal = (model: Model<Api>, why: string): AssistantMessage => ({
    role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, stopReason: "error", timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    // "out of budget" is final to pi-ai's retry policy, whatever digits the amounts hold.
    errorMessage: why,
  });
  /** Adds what `answer` cost to what the run has spent once it settles. One stopped before its end, or that failed with
   *  no answer, counts at `worst`, what the cap held for it (as spentIn reads its end mark); without one (a deferred
   *  response) it is unknown, as is a cost that is not a number, from then on. */
  const count = (answer: Promise<AssistantMessage>, worst?: number) => {
    const add = (cost: unknown) => void (spent = spent !== null && typeof cost === "number" && Number.isFinite(cost) ? spent + cost : null);
    return answer.then((message) => add(message.stopReason === "aborted" ? worst : message.usage?.cost?.total), () => add(worst));
  };
  /** Sends a request judged to fit at `worst`, holding that until `answer` settles. */
  const admit = (worst: number, answer: () => Promise<AssistantMessage>): Promise<AssistantMessage> => {
    held += worst;
    let answered: Promise<AssistantMessage>;
    try {
      answered = answer();
    } catch (error) {
      held -= worst;
      throw error;
    }
    void count(answered, worst).finally(() => void (held -= worst));
    return answered;
  };
  /** `options` with the request's worst case for its marks. */
  const carrying = <O>(options: O, worst: number): O => ({ ...options, [HELD_USD]: worst }) as O;
  const stream = (send: (model: Model<Api>, context: Context, options?: { maxTokens?: number }) => AssistantMessageEventStream) =>
    (model: Model<Api>, context: Context, options?: { maxTokens?: number }): AssistantMessageEventStream => {
      const judged = judge(model, context, options);
      if ("worst" in judged) {
        let events: AssistantMessageEventStream | undefined;
        admit(judged.worst, () => (events = send(model, context, carrying(options, judged.worst))).result());
        return events!;
      }
      const refused = createAssistantMessageEventStream();
      const message = refusal(model, judged.why);
      // Its own start mark first, so pi's error entry for it answers that mark, never an earlier request a stop or a crash
      // cut. A mark that cannot be written still ends the request: spentIn leaves refusals out either way.
      void Promise.resolve()
        .then(() => markRefused?.())
        .catch(() => undefined)
        .then(() => {
          refused.push({ type: "error", reason: "error", error: message });
          refused.end(message);
        });
      return refused;
    };
  const complete = (send: (model: Model<Api>, context: Context, options?: { maxTokens?: number }) => Promise<AssistantMessage>) =>
    (model: Model<Api>, context: Context, options?: { maxTokens?: number }): Promise<AssistantMessage> => {
      const judged = judge(model, context, options);
      return "worst" in judged ? admit(judged.worst, () => send(model, context, carrying(options, judged.worst))) : Promise.resolve(refusal(model, judged.why));
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
