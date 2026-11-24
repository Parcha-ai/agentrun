// The runner's model route: where a model's requests go, on which id, at what price. A model is resolved as main
// resolves a run's (model.ts chooseModel and runModels: the faux module under --faux, the gateway, or each provider on
// its own key), and a route speaks a wire its caller speaks (`wires`: the pi adapter speaks both of main's, provider.ts,
// and so do a workflow's model nodes, which take the route's wire as pi does):
// - an Anthropic model goes to Anthropic itself (its catalog origin, ANTHROPIC_BASE_URL's when set), its key read by
//   name when a request goes, never held by the route; a Claude model of serve's gateway goes to the gateway on Messages;
// - a model pi-ai speaks OpenAI's Responses to (OpenAI's own on its key, serve's gateway), for a caller that speaks
//   Responses, goes there itself, where provider.ts providerFor sends it (the origin, the key, the id on the wire);
// - any other model answers through the route's own fetch: the Messages request runs on pi-ai's model of it (the faux
//   core under --faux, never the network; another provider's or the gateway's on its key from `env`), and its events
//   come back as a Messages stream.
//   A model whose catalog entry takes its tools as text (local-models.ts `toolsAs`) gets them in its system prompt and
//   its calls read back from its reply (text-tools.ts), on this translation alone.
// Its price is pi-ai's calculateCost on the catalog's cost, tiers included (a request past a model's tier is priced at
// the tier, as its provider bills it), and its cost is that catalog entry, tiers included, for the cap's judgement.
import { randomUUID } from "node:crypto";
import { calculateCost } from "@earendil-works/pi-ai";
import type { ThinkingLevelMap } from "../port-models.js";
import type { Wire } from "@parcha/agentrun-kernel";
import { onOpenRouter, openRouterAttribution, ROUTE_ORIGIN, streamErrorOf } from "@parcha/agentrun-kernel/host";
import type { ToolsAs } from "../local-models.js";
import { chooseModel, MODEL_PROVIDER, type PinnedModel, runModels, type Tier } from "../model.js";
import { OLLAMA_PROVIDER } from "../ollama-provider.js";
import { gatewayHeadersAt, providerFor } from "../provider.js";
import { keepText, type Redact, runnerSecrets, secretRedactor } from "./redact.js";
import { responsesFetch } from "./responses-fetch.js";
import { callsOfText, type PiContext, toolsAsText } from "./text-tools.js";

/** What a request on a model costs, USD per million tokens, as pi-ai's catalog lists it (tiers included). */
export type RouteCost = {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly tiers?: readonly { readonly inputTokensAbove: number; readonly input: number; readonly output: number; readonly cacheRead: number; readonly cacheWrite: number }[];
};

/** A request's token usage, as the proxy's booking prices it. */
export type RouteUsage = { input: number; output: number; cacheRead: number; cacheWrite: number };

/** Where a model's requests go: the API `provider.api` names at `origin` (the shape the kernel's model proxy forwards), its
 *  credential sent as `auth` says, for `model` (its id on that wire), priced by `price`; `fetch`, the route's own upstream
 *  when its model speaks no wire of the caller's, and `cost` beside them. */
export interface ModelRoute {
  /** `plan`: a ChatGPT plan's route (provider.ts billing "plan"), billed to the plan: no price, its rules on the wire.
   *  Whether its answers state what they cost is the proxy's to read from `origin` (statesUsageCost): OpenRouter's, or
   *  this route's own translation of one (ROUTE_ORIGIN). */
  readonly provider: { readonly api: Wire; readonly origin: string; readonly credential: () => string | Promise<string>; readonly headers?: Readonly<Record<string, string>>; readonly auth?: "bearer" | "x-api-key"; readonly plan?: boolean; readonly refused?: (credential: string) => Promise<void> };
  readonly model: string;
  /** The model as the run names it (`provider/model-id`, chooseModel's): what the `llm` tool's answer says it ran on,
   *  never the session provider the runner reaches it through. */
  readonly named?: string;
  /** The catalog's entry for the model, as pi-ai's model of it takes it: on every wire, what it takes as input (whether it
   *  takes images) and its input limits (an image's most size), which pi's session and its read size an image by; on a
   *  wire that carries its reasoning (Responses), also whether it reasons, its window, its output ceiling, and the effort
   *  each thinking level asks for (`thinkingLevelMap`: a level mapped to null sends no effort, so pi's thinking off asks
   *  a model that takes no "none" for none, gpt-6.1-sol's case). On the route's own translation, a model that reasons
   *  asks its level by name (LEVELS_BY_NAME: `adaptiveThinking`), so the run's effort reaches it; Particle's also keeps
   *  its window and ceiling, and marks its Messages hop as carrying Chat Completions (`translatedChatCompletions`). */
  readonly like?: { readonly reasoning?: boolean; readonly contextWindow?: number; readonly maxTokens?: number; readonly input?: readonly string[]; readonly inputLimits?: unknown; readonly developerRole?: boolean; readonly adaptiveThinking?: boolean; readonly thinkingLevelMap?: ThinkingLevelMap; readonly translatedChatCompletions?: boolean };
  /** A request's price from its usage (the proxy's booking reads it): pi-ai's calculateCost, tiers included. */
  readonly price?: (model: string, usage: RouteUsage) => number | null;
  /** The upstream fetch: the route's own, for a model that does not speak Messages. Absent: the network. */
  readonly fetch?: typeof fetch;
  /** The catalog's cost of the model, tiers included: what the cap prices a request at before it leaves. */
  readonly cost?: RouteCost;
  /** True when serve has no price for the model (runModels' `unpriced`): `cost` is then a placeholder of zeros, which the
   *  cap never reads as a price (capModelOf: price unknown, never $0). */
  readonly unpriced?: boolean;
  /** The model's most output tokens (its catalog ceiling): the cap's output bound, null when the catalog names none. */
  readonly outputCeiling?: number | null;
  /** A model on this machine's own Ollama (ollama-provider.ts): $0, and its requests never count toward the run's
   *  free-model limit (the cap's CapModel.local), which guards a provider's shared quota this model has none of. */
  readonly local?: boolean;
}


type PiModel = { id: string; provider: string; api: string; baseUrl?: string; cost: RouteCost; maxTokens?: number; reasoning?: boolean; contextWindow?: number; input?: readonly string[]; inputLimits?: unknown; thinkingLevelMap?: ThinkingLevelMap; toolsAs?: ToolsAs };
/** The wires a caller of routeOf speaks when it names none: Anthropic's Messages alone. */
const MESSAGES_ONLY: readonly Wire[] = ["anthropic-messages"];
type PiModels = { getModel(provider: string, id: string): unknown; streamSimple(model: never, context: never, options?: never): AsyncIterable<PiEvent> };
type PiEvent = { type: string; contentIndex?: number; delta?: string; partial?: { content?: { type: string; id?: string; name?: string }[] }; toolCall?: { id: string; name: string; arguments: unknown }; reason?: string; message?: PiMessage; error?: PiMessage };
type PiMessage = { usage?: RouteUsage & { reasoning?: number }; stopReason?: string; errorMessage?: string; content?: { type: string; text?: string; thinking?: string }[] };

/** The route of `model` ("provider/model-id"; undefined for the host's model of `tier`; a claimed run's pin, sent as
 *  pinned: chooseModel's PinnedModel), resolved from `env` as main resolves a run's model, on a wire of `wires` (the
 *  caller's; default Messages alone). `upstream`: what the route's own
 *  translation sends with (a test's stand-in for the provider); absent, the network. `redact`: the runner's one redactor,
 *  which the translation's error text passes through (absent, one over every secret `env` holds). Refuses, in main's
 *  words, a model this host cannot run. */
export async function routeOf(model: string | PinnedModel | undefined, env: NodeJS.ProcessEnv = process.env, tier: Tier = "default", wires: readonly Wire[] = MESSAGES_ONLY, upstream?: typeof fetch, redact?: Redact): Promise<ModelRoute> {
  const chosen = await chooseModel(env, model, tier);
  if ("why" in chosen) throw new Error(chosen.why);
  // A tier's own model, when one is named (a subagent's model_tiers), is the one registered, at the tier's price: a gateway
  // lists only the models it is given, so the host's model for the tier in its place would leave this one unknown.
  const named = tier !== "default" && typeof model === "string" ? { [tier]: model } : {};
  const { models, unpriced } = await runModels(env, tier === "default" ? model : undefined, [tier], undefined, named);
  const target = models.getModel(chosen.model.provider, chosen.model.modelId) as unknown as PiModel | undefined;
  if (!target) throw new Error(`no model ${chosen.model.provider}/${chosen.model.modelId} here`);
  // A model serve has no price for (runModels' `unpriced`) carries a placeholder cost of zeros: its requests are booked at
  // no known price (null), never $0, as a CLI run's are (adapters.ts priceOf).
  const price = (_model: string, used: RouteUsage): number | null => (unpriced.has(chosen.model.modelId) ? null : priceOn(target, used));
  // What the model takes as input and its input limits, on every wire: pi's session sends a model that takes no images
  // pi-ai's placeholder in place of one, and pi's read holds an image to the model's limits (port-models.ts sessionModel).
  const sees = { ...(target.input ? { input: target.input } : {}), ...(target.inputLimits ? { inputLimits: target.inputLimits } : {}) };
  // The settings serve registered for a gateway model, carried on either wire, so pi's session reads the same model whether
  // it speaks Messages or Responses to the gateway.
  const settings = { ...sees, ...(target.reasoning !== undefined ? { reasoning: target.reasoning } : {}), ...(target.contextWindow ? { contextWindow: target.contextWindow } : {}), ...(target.maxTokens ? { maxTokens: target.maxTokens } : {}), ...(target.thinkingLevelMap ? { thinkingLevelMap: target.thinkingLevelMap } : {}) };
  const route = { model: chosen.model.modelId, named: `${chosen.model.provider}/${chosen.model.modelId}`, price, cost: target.cost, ...(unpriced.has(chosen.model.modelId) ? { unpriced: true } : {}), outputCeiling: target.maxTokens ?? null, like: sees };
  // An Anthropic model speaks Messages itself: the network, at its catalog origin, its key read by name per request.
  // Its requests name the claim's run, turn and attempt only where that origin is serve's own gateway (gatewayHeadersAt).
  if (chosen.model.provider === "anthropic") {
    const origin = target.baseUrl ?? "https://api.anthropic.com";
    const headers = gatewayHeadersAt(env, origin);
    return { ...route, provider: { api: "anthropic-messages", origin, credential: () => env.ANTHROPIC_API_KEY ?? env.ANTHROPIC_AUTH_TOKEN ?? "", ...(headers ? { headers } : {}) } };
  }
  // A Claude model of serve's gateway (model.ts gatewayWire), for a caller that speaks Messages: the gateway itself, on
  // Messages, so the prompt cache marks pi-ai puts on the request reach it (provider.ts).
  if (target.api === "anthropic-messages" && chosen.model.provider === MODEL_PROVIDER && wires.includes("anthropic-messages")) {
    const to = providerFor("anthropic-messages", env, chosen.model, "pi");
    return { ...route, model: to.modelId, provider: { api: "anthropic-messages", origin: to.origin, credential: to.credential, auth: to.auth, ...(to.headers ? { headers: to.headers } : {}) }, like: settings };
  }
  // A model pi-ai speaks Responses to, for a caller that speaks it: that wire itself, where main sends it (provider.ts).
  if (target.api === "openai-responses" && wires.includes("openai-responses")) {
    const to = providerFor("openai-responses", env, chosen.model, "pi");
    // A ChatGPT plan's model: billed to the plan, at no price here (unpriced, never $0), its instructions sent as a
    // developer message (the plan takes no system one).
    const onPlan = to.billing === "plan";
    const plan = onPlan ? { price: () => null, unpriced: true as const } : {};
    return {
      ...route, model: to.modelId, ...plan,
      provider: { api: "openai-responses", origin: to.origin, credential: to.credential, auth: to.auth, ...(to.headers ? { headers: to.headers } : {}), ...(onPlan ? { plan: true } : {}), ...(to.refused ? { refused: to.refused } : {}) },
      like: onPlan ? { ...settings, developerRole: true } : settings,
    };
  }
  // The translation writes an answer's cost in its usage only where pi-ai read the provider's own (OpenRouter's): the
  // proxy reads it on ROUTE_ORIGIN (statesUsageCost). A model that reasons is given to pi's session as one that asks its
  // thinking level by name (LEVELS_BY_NAME), which the translation hands to pi-ai (levelOf): the run's effort reaches the
  // model, mapped and clamped by its own catalog entry. Direct Particle states no cost (its usage is priced from the
  // catalog), and its session also takes the model's window and ceiling and replays unsigned reasoning.
  // An Ollama model's session also takes its window, the context every request asks Ollama for (num_ctx), so pi compacts
  // before Ollama would cut the prompt.
  const local = target.provider === OLLAMA_PROVIDER;
  const like = target.provider === "particle" ? { ...settings, ...LEVELS_BY_NAME, translatedChatCompletions: true } : local ? { ...settings, ...(target.reasoning ? LEVELS_BY_NAME : {}) } : target.reasoning ? { ...sees, ...LEVELS_BY_NAME } : undefined;
  return { ...route, ...(like ? { like } : {}), ...(local ? { local: true } : {}), provider: { api: "anthropic-messages", origin: ROUTE_ORIGIN, credential: () => "model-route" }, fetch: messagesFetch(models as unknown as PiModels, target, redact ?? secretRedactor(runnerSecrets(env)), upstream, env) };
}

/** Whether pi-ai sends `target`'s requests to OpenRouter (pi-ai's own test, utils/openrouter-cost.js isOpenRouterModel). */
const piOnOpenRouter = (target: PiModel): boolean => target.provider === "openrouter" || onOpenRouter(target.baseUrl ?? "");

/** How much of an answer's text the error tap keeps: its end, where a stream's error event is. */
const TAP_WINDOW = 64 * 1024;

/** `upstream` (the network when absent) with the end of each answer's body kept (`kept()`), as it streams by: what the
 *  provider said when pi-ai reports a failure, read for the provider's own error event by its fields (streamErrorOf),
 *  which pi-ai's client drops (it keeps the words alone). The body reaches pi-ai as it came. */
function tapped(upstream: typeof fetch | undefined): { fetch: typeof fetch; kept: () => string } {
  let kept = "";
  const send = upstream ?? globalThis.fetch;
  const fetcher = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const response = await send(input, init);
    kept = "";
    if (!response.body) return response;
    const decoder = new TextDecoder();
    const keep = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        kept = (kept + decoder.decode(chunk, { stream: true })).slice(-TAP_WINDOW);
        controller.enqueue(chunk);
      },
    });
    return new Response(response.body.pipeThrough(keep), { status: response.status, statusText: response.statusText, headers: response.headers });
  }) as typeof fetch;
  return { fetch: fetcher, kept: () => kept };
}

/** A fetch that answers Anthropic Messages requests on `target`, through pi-ai's `models`. A provider's error text, which
 *  pi records, goes through `redact` (the runner's one redactor): a provider that echoes its key leaves none there.
 *  `upstream`: the route's own fetch, for a model that does not speak Messages (absent: the network). A request pi-ai
 *  sends to OpenRouter carries AgentRun's app attribution unless `env` turns it off (kernel openrouter-attribution.ts),
 *  as one the model proxy sends there does; a request to any other provider carries none. */
export function messagesFetch(models: PiModels, target: PiModel, redact: Redact = keepText, upstream?: typeof fetch, env: NodeJS.ProcessEnv = process.env): typeof fetch {
  const attribution = piOnOpenRouter(target) ? openRouterAttribution(env) : {};
  const particle = target.provider === "particle";
  // Side requests without a Pi session id retain affinity for this route's lifetime.
  const cacheSession = particle ? randomUUID() : undefined;
  // A tool call's id as Messages carries it (letters, digits, _ and -), and back to the provider's own on its result.
  const providerIds = new Map<string, string>();
  const messagesId = (id: string): string => {
    const safe = id.replace(/[^A-Za-z0-9_-]/g, "_");
    providerIds.set(safe, id);
    return safe;
  };
  return (async (_url: unknown, init: { body?: unknown; signal?: AbortSignal } = {}) => {
    const body = JSON.parse(String(init.body ?? "{}")) as MessagesRequest;
    const built = contextOf(body, target, (id) => providerIds.get(id) ?? id) as PiContext;
    // A model that takes its tools as text (its catalog entry's toolsAs): its tools in its system prompt, every call and
    // result of its history as text, and its calls read from its reply. A request with no tools goes as it is.
    const asText = target.toolsAs === "text" && (built.tools?.length ?? 0) > 0;
    const context = asText ? toolsAsText(built) : built;
    // Keep each OpenRouter or Particle answer's end for structured failures inside a successful HTTP stream.
    const tap = piOnOpenRouter(target) || particle ? tapped(upstream) : undefined;
    const sendWith = tap?.fetch ?? upstream;
    const level = levelOf(body);
    // Particle's cache affinity: the session's id (the Messages hop's metadata.user_id), else this route's own; an
    // empty id is a caller that asked for no cache hint.
    const affinity = !particle ? {} : body.metadata?.user_id === "" ? { cacheRetention: "none" } : { sessionId: body.metadata?.user_id || cacheSession };
    const streamOptions = { ...affinity, ...(body.max_tokens ? { maxTokens: body.max_tokens } : {}), ...(level ? { reasoning: level } : {}), ...(init.signal ? { signal: init.signal } : {}), ...(sendWith ? { fetch: sendWith } : {}), ...(Object.keys(attribution).length ? { headers: attribution } : {}) };
    const events = models.streamSimple(target as never, context as never, streamOptions as never);
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (event: { type: string; [key: string]: unknown }) => controller.enqueue(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
        // A failed request's error event carries its words alone, one data line each: pi-ai's Messages client throws an
        // error event's data as the request's error, so the caller reads the model's own error as main's in-process pi
        // reports it ("500 {...}"), never this route's envelope around it.
        const sendWords = (words: string) => controller.enqueue(encoder.encode(`event: error\n${words.split(/\r?\n/).map((line) => `data: ${line}`).join("\n")}\n\n`));
        // What the provider said the answer cost (pi-ai reads OpenRouter's usage.cost: totalFromProvider), in the
        // message's usage as `cost`, for the proxy to book (usageCostOf). Never pi-ai's own pricing of it.
        const reportedOf = (used: RouteUsage | undefined): number | undefined => {
          const cost = (used as { cost?: { total?: unknown; totalFromProvider?: unknown } } | undefined)?.cost;
          return cost?.totalFromProvider === true && typeof cost.total === "number" && Number.isFinite(cost.total) && cost.total > 0 ? cost.total : undefined;
        };
        // The provider's own error inside its 200 stream (the tap's kept end, read by its fields: streamErrorOf) goes as
        // Messages writes one (`rate_limit_error` for a rate limit, else `api_error`), after the usage the provider reported
        // before it (`used`, its stated `cost` too) as the message's, so the proxy books it by its one rule for an error in a
        // stream: those tokens at list (or that cost), else refused at nothing. Its top-level `message` is the same words,
        // which pi-ai's Messages client reads as the request's error. A failure with no such event (a transport error, a
        // status) goes as its words alone: the proxy books that as an answer cut short, at an unknown cost. Whatever the
        // model wrote that this translation held is sent before either (sendHeld), so an error with no usage after the
        // model began is never read as a refusal.
        const sendError = (words: string, used?: { input: number; output: number; cacheRead?: number; cacheWrite?: number; reasoning?: number }, cost?: number) => {
          const failed = tap ? streamErrorOf(tap.kept()) : undefined;
          if (failed === undefined) return sendWords(words);
          const tokens = used ? { input_tokens: used.input, output_tokens: used.output, cache_read_input_tokens: used.cacheRead ?? 0, cache_creation_input_tokens: used.cacheWrite ?? 0, ...(used.reasoning === undefined ? {} : { output_tokens_details: { thinking_tokens: used.reasoning } }) } : undefined;
          if ((tokens && tokens.input_tokens + tokens.output_tokens + tokens.cache_read_input_tokens + tokens.cache_creation_input_tokens > 0) || cost !== undefined) {
            send({ type: "message_delta", delta: { stop_reason: null, stop_sequence: null }, usage: { ...(tokens ?? { input_tokens: 0, output_tokens: 0 }), ...(cost === undefined ? {} : { cost }) } });
          }
          send({ type: "error", message: words, error: { type: failed.rateLimit ? "rate_limit_error" : "api_error", message: words } });
        };
        send({ type: "message_start", message: { id: `msg_${Date.now().toString(36)}`, type: "message", role: "assistant", model: body.model ?? target.id, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } });
        // Messages blocks are numbered as sent. A thinking block is sent too, so the model's reasoning reaches the run's
        // record as a Timeline row; its text goes through the run's one redactor, so a held key the model quoted in its
        // thinking is cut before pi's session journals it, not only at read. It carries no signature here. Particle
        // preserves this redacted text for its native tool continuation; other translated providers drop it.
        const blockOf = new Map<number, number>();
        const sentJson = new Set<number>();
        let blocks = 0;
        // The thinking of the block being streamed, gathered so its whole text is redacted at once (its deltas are not sent),
        // and that block's index while it is open.
        let thinking = "";
        let thinkingAt: number | undefined;
        const open = (at: number | undefined) => {
          const index = blocks++;
          blockOf.set(at ?? -1, index);
          return index;
        };
        // The thinking block held open, sent as it ends: its whole text through the run's one redactor, then its stop.
        const endThinking = () => {
          if (thinkingAt === undefined) return;
          send({ type: "content_block_delta", index: thinkingAt, delta: { type: "thinking_delta", thinking: redact(thinking) } });
          send({ type: "content_block_stop", index: thinkingAt });
          thinkingAt = undefined;
        };
        // What the model wrote that this translation held back when its request fails (a thinking block before its end; a
        // text-tools reply, read whole at its end, here the failed reply's parts): sent before the error, as a provider
        // that streams it would have sent it. The model ran, and the proxy must not read the error as one before anything
        // was generated (a refusal at $0): what it wrote shows it did. A text-tools reply that began with no part pi-ai
        // kept goes as an empty text block, which still shows the model began.
        const sendHeld = (reply?: { began: boolean; message: PiMessage }) => {
          endThinking();
          if (!reply?.began) return;
          const parts = reply.message.content ?? [];
          const thought = parts.filter((each) => each.type === "thinking").map((each) => each.thinking ?? "").join("");
          const text = parts.filter((each) => each.type === "text").map((each) => each.text ?? "").join("");
          if (thought) {
            const index = blocks++;
            send({ type: "content_block_start", index, content_block: { type: "thinking", thinking: "", signature: "" } });
            send({ type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: redact(thought) } });
            send({ type: "content_block_stop", index });
          }
          if (text || !thought) {
            const index = blocks++;
            send({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
            if (text) send({ type: "content_block_delta", index, delta: { type: "text_delta", text } });
            send({ type: "content_block_stop", index });
          }
        };
        try {
          for await (const event of asText ? [] : events) {
            const at = event.contentIndex;
            if (event.type === "text_start") send({ type: "content_block_start", index: open(at), content_block: { type: "text", text: "" } });
            else if (event.type === "thinking_start") {
              thinking = "";
              thinkingAt = open(at);
              send({ type: "content_block_start", index: thinkingAt, content_block: { type: "thinking", thinking: "", signature: "" } });
            } else if (event.type === "thinking_delta") thinking += event.delta ?? "";
            else if (event.type === "thinking_end") {
              // The whole thinking at its end, through the run's one redactor, in one delta: a held key the model quoted is
              // cut before pi's session journals it even where it spans two deltas (a cut per delta could miss a key split
              // across them).
              thinkingAt = blockOf.get(at ?? -1);
              endThinking();
            }
            else if (event.type === "text_delta") send({ type: "content_block_delta", index: blockOf.get(at ?? -1), delta: { type: "text_delta", text: event.delta ?? "" } });
            else if (event.type === "toolcall_start") {
              const call = event.partial?.content?.[at ?? -1];
              send({ type: "content_block_start", index: open(at), content_block: { type: "tool_use", id: messagesId(call?.id ?? `call_${blocks}`), name: call?.name ?? "", input: {} } });
            } else if (event.type === "toolcall_delta" && event.delta) {
              sentJson.add(blockOf.get(at ?? -1)!);
              send({ type: "content_block_delta", index: blockOf.get(at ?? -1), delta: { type: "input_json_delta", partial_json: event.delta } });
            } else if (event.type === "toolcall_end") {
              const index = blockOf.get(at ?? -1);
              if (index === undefined) {
                // A call that came whole, with no start: opened and filled here.
                const opened = open(at);
                send({ type: "content_block_start", index: opened, content_block: { type: "tool_use", id: messagesId(event.toolCall?.id ?? `call_${opened}`), name: event.toolCall?.name ?? "", input: {} } });
                send({ type: "content_block_delta", index: opened, delta: { type: "input_json_delta", partial_json: JSON.stringify(event.toolCall?.arguments ?? {}) } });
                send({ type: "content_block_stop", index: opened });
              } else {
                if (!sentJson.has(index)) send({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(event.toolCall?.arguments ?? {}) } });
                send({ type: "content_block_stop", index });
              }
            } else if (event.type === "text_end") send({ type: "content_block_stop", index: blockOf.get(at ?? -1) });
            else if (event.type === "done" || event.type === "error") {
              const message = (event.type === "done" ? event.message : event.error) ?? {};
              if (event.type === "error") {
                sendHeld();
                sendError(redact(message.errorMessage ?? event.reason ?? "the model's request failed"), message.usage, reportedOf(message.usage));
                break;
              }
              const used: NonNullable<PiMessage["usage"]> = message.usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
              const cost = reportedOf(message.usage);
              send({ type: "message_delta", delta: { stop_reason: stopReasonOf(event.reason ?? message.stopReason), stop_sequence: null }, usage: { input_tokens: used.input, output_tokens: used.output, cache_read_input_tokens: used.cacheRead, cache_creation_input_tokens: used.cacheWrite, ...(used.reasoning === undefined ? {} : { output_tokens_details: { thinking_tokens: used.reasoning } }), ...(cost === undefined ? {} : { cost }) } });
              send({ type: "message_stop" });
            }
          }
          if (asText) {
            // The reply whole, then its text and its calls as Messages blocks. A reply that opens a call block and
            // holds no call it can read is asked again, at most TEXT_TOOL_TRIES times in all, its usage summed, and
            // only out of what the cap held for this one request (reaskTokens): the re-ask's output limit is what is
            // left of it once the tries so far and the re-ask's own input, uncached, are paid.
            const tools = built.tools ?? [];
            const used = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
            // The provider's cost of every try, summed while each stated one; unknown once one did not.
            let reported: number | undefined = 0;
            const outputHeld = body.max_tokens ?? target.maxTokens;
            let heldUsd = 0;
            let spentUsd = 0;
            let replies = events;
            let nextTokens = 0;
            for (let attempt = 1; ; attempt++) {
              let again = false;
              // Whether this try's reply began: any of its content's events (pi-ai's `start` is the request's own).
              let began = false;
              for await (const event of replies) {
                if (event.type !== "done" && event.type !== "error") {
                  if (event.type !== "start") began = true;
                  continue;
                }
                const message = (event.type === "done" ? event.message : event.error) ?? {};
                if (event.type === "error") {
                  const wrote = began || (message.content ?? []).length > 0;
                  sendHeld({ began: wrote, message });
                  // The tries so far were paid, and this one's usage too: their sum, with their stated cost while each
                  // try that reported tokens stated one. A try that wrote and then failed with no usage and no cost ran at
                  // a cost nobody said: the sum of the tries before it would undercount the request, so none is sent
                  // and the request's total is unknown (the cap's hold covers every try).
                  const given = message.usage;
                  const own = reportedOf(given);
                  const said = given !== undefined && given.input + given.output + (given.cacheRead ?? 0) + (given.cacheWrite ?? 0) > 0;
                  const unsaid = wrote && !said && own === undefined;
                  const tokens = unsaid ? undefined : { input: used.input + (given?.input ?? 0), output: used.output + (given?.output ?? 0), cacheRead: used.cacheRead + (given?.cacheRead ?? 0), cacheWrite: used.cacheWrite + (given?.cacheWrite ?? 0) };
                  const cost = unsaid || reported === undefined || (said && own === undefined) ? undefined : reported + (own ?? 0);
                  sendError(redact(message.errorMessage ?? event.reason ?? "the model's request failed"), tokens, cost !== undefined && cost > 0 ? cost : undefined);
                  break;
                }
                const given = message.usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
                const part = { input: given.input, output: given.output, cacheRead: given.cacheRead ?? 0, cacheWrite: given.cacheWrite ?? 0 };
                used.input += part.input;
                used.output += part.output;
                used.cacheRead += part.cacheRead;
                used.cacheWrite += part.cacheWrite;
                const cost = reportedOf(message.usage);
                reported = reported === undefined || cost === undefined ? undefined : reported + cost;
                if (attempt === 1 && outputHeld !== undefined) heldUsd = priceOn(target, { ...part, output: outputHeld });
                spentUsd += priceOn(target, part);
                const said = (message.content ?? []).filter((each) => each.type === "text").map((each) => each.text ?? "").join("");
                // A reply cut at its output limit may stop inside a call: a call block in it is never run, it is broken.
                const cut = (event.reason ?? message.stopReason) === "length";
                const parsed = callsOfText(said, tools);
                const read = cut && (parsed.calls.length > 0 || parsed.broken) ? { text: said.trim(), calls: [], broken: true } : parsed;
                if (read.broken && attempt < TEXT_TOOL_TRIES && outputHeld !== undefined) {
                  nextTokens = reaskTokens(target, part, heldUsd - spentUsd, outputHeld);
                  if (nextTokens > 0 && nextTokens >= part.output) {
                    again = true;
                    break;
                  }
                }
                // The reply's thinking first, as the streamed branch sends it: one block, its whole text through the run's
                // one redactor before pi's session journals it.
                const thought = (message.content ?? []).filter((each) => each.type === "thinking").map((each) => each.thinking ?? "").join("");
                if (thought) {
                  const index = blocks++;
                  send({ type: "content_block_start", index, content_block: { type: "thinking", thinking: "", signature: "" } });
                  send({ type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: redact(thought) } });
                  send({ type: "content_block_stop", index });
                }
                if (read.text) {
                  const index = blocks++;
                  send({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
                  send({ type: "content_block_delta", index, delta: { type: "text_delta", text: read.text } });
                  send({ type: "content_block_stop", index });
                }
                for (const call of read.calls) {
                  const index = blocks++;
                  send({ type: "content_block_start", index, content_block: { type: "tool_use", id: messagesId(`call_${randomUUID().replace(/-/g, "").slice(0, 24)}`), name: call.name, input: {} } });
                  send({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(call.arguments) } });
                  send({ type: "content_block_stop", index });
                }
                const reason = read.calls.length ? "tool_use" : stopReasonOf(event.reason === "toolUse" ? "stop" : event.reason ?? message.stopReason);
                send({ type: "message_delta", delta: { stop_reason: reason, stop_sequence: null }, usage: { input_tokens: used.input, output_tokens: used.output, cache_read_input_tokens: used.cacheRead, cache_creation_input_tokens: used.cacheWrite, ...(reported === undefined ? {} : { cost: reported }) } });
                send({ type: "message_stop" });
              }
              if (!again) break;
              replies = models.streamSimple(target as never, context as never, { ...streamOptions, maxTokens: nextTokens } as never);
            }
          }
        } catch (error) {
          sendHeld();
          sendError(redact((error as Error)?.message ?? String(error)));
        }
        controller.close();
      },
    });
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as unknown as typeof fetch;
}

/** The bytes of a request a token count answers per token (forMessagesClients' count_tokens). */
const COUNT_BYTES_PER_TOKEN = 4;
/** Whether a request asks Messages' token count (its path's last segment, any query after it). */
const countsTokens = (url: unknown): boolean => /\/count_tokens(?:\?|$)/.test(String(url));

/** Why a Messages `tool_choice` that forces a call is refused (its 400's words), else undefined: the model behind the
 *  route (Ollama's chat) takes no tool choice, so a call forced by "any" or by a tool's name cannot be kept. "auto",
 *  "none" and none at all are taken; any other type is refused too. */
function forcedChoice(choice: unknown): string | undefined {
  if (choice === undefined || choice === null) return undefined;
  const plain = typeof choice === "object" && !Array.isArray(choice) ? (choice as { type?: unknown; name?: unknown }) : undefined;
  const type = plain ? plain.type : choice;
  if (type === "auto" || type === "none") return undefined;
  const unkept = 'is not taken on this model\'s route: the model here cannot be made to call a tool, so send "auto"';
  if (type === "any") return `tool_choice "any" ${unkept}`;
  if (type === "tool") return `tool_choice naming the tool ${String(plain?.name ?? "(none)")} ${unkept}`;
  return `tool_choice ${JSON.stringify(type ?? "(no type)")} is not taken on this model's route: "auto" and "none" only`;
}

/** `route` (a translated route's fetch, which streams every answer, as pi-ai asks) for any Messages client on the wire it
 *  translates onto, which asks two things pi-ai never does. Its token count (POST /v1/messages/count_tokens, free, asked
 *  beside its turns) is answered here and never run on the model, which has no count of its own: the body's bytes over
 *  four (COUNT_BYTES_PER_TOKEN), a bound for its context, not a price. A request with no `stream: true` (a side request)
 *  gets its answer whole, one JSON message as Messages writes it, joined from the stream (wholeOf). A tool_choice that
 *  forces a call is refused with a 400 before the model is asked (forcedChoice). */
export function forMessagesClients(route: typeof fetch): typeof fetch {
  return (async (url: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1] = {}) => {
    const body = String(init.body ?? "");
    if (countsTokens(url)) return Response.json({ input_tokens: Math.ceil(new TextEncoder().encode(body).length / COUNT_BYTES_PER_TOKEN) });
    const read = (() => {
      try {
        return JSON.parse(body || "{}") as { stream?: unknown; tool_choice?: unknown };
      } catch {
        return undefined;
      }
    })();
    const refused = forcedChoice(read?.tool_choice);
    if (refused) return messagesError(refused, 400, "invalid_request_error");
    const streamed = read === undefined || read.stream === true;
    const answer = await route(url, init);
    return streamed || answer.status !== 200 ? answer : wholeOf(await answer.text());
  }) as typeof fetch;
}

/** The route's translation onto each wire it translates a model onto (wires.ts TRANSLATED), by wire: what a harness's
 *  proxy on that wire forwards with for `model` (`provider/model-id`), made on `env`. Anthropic's Messages: the route's
 *  own Messages fetch (messagesFetch), as a Messages client asks it (forMessagesClients). OpenAI's Responses: that same
 *  fetch under a Responses edge (responsesFetch). provider.ts routedProvider reads it; a wire with no entry has no
 *  translation, whatever TRANSLATED says. */
export const TRANSLATORS: Readonly<Partial<Record<Wire, (model: string, env: NodeJS.ProcessEnv) => Promise<typeof fetch>>>> = Object.freeze({
  "anthropic-messages": async (model: string, env: NodeJS.ProcessEnv) => forMessagesClients((await routeOf(model, env)).fetch!),
  // OpenAI's Responses: the same Messages fetch under a Responses edge (responses-fetch.ts), a model that reasons asked its
  // effort by name as on Messages.
  "openai-responses": async (model: string, env: NodeJS.ProcessEnv) => {
    const route = await routeOf(model, env);
    return responsesFetch(route.fetch!, { reasons: route.like?.reasoning === true });
  },
});

type StreamBlock = { type: string; text?: string; thinking?: string; signature?: string; input?: unknown; [key: string]: unknown };

/** One Messages answer whole, from the events of its stream (`sse`): the message_start's message, each block joined from
 *  its deltas (a tool call's input parsed from its pieces), the last message_delta's stop and usage over the start's. An
 *  error event answers as Messages writes an error, at 500, with its words; so does a stream a part of which is not JSON. */
function wholeOf(sse: string): Response {
  try {
    return wholeRead(sse);
  } catch {
    // A part that does not read (a data line not JSON, a tool call's input cut short) is said as an error event is.
    return messagesError("The model's answer could not be read whole: a part of it is not JSON.");
  }
}

/** A Messages error answer: `words` its message, 500 api_error unless said otherwise. */
const messagesError = (words: string, status = 500, type = "api_error"): Response => Response.json({ type: "error", error: { type, message: words } }, { status });

/** wholeOf's reading, which throws on a part that is not JSON. */
function wholeRead(sse: string): Response {
  let message: Record<string, unknown> = {};
  const blocks: StreamBlock[] = [];
  const pieces = new Map<number, string>();
  for (const frame of sse.split(/\n\n/)) {
    const lines = frame.split("\n");
    const kind = lines.find((line) => line.startsWith("event: "))?.slice("event: ".length);
    const data = lines.filter((line) => line.startsWith("data: ")).map((line) => line.slice("data: ".length)).join("\n");
    if (!kind || !data) continue;
    if (kind === "error") {
      let words = data;
      try {
        const said = JSON.parse(data) as { error?: { message?: unknown }; message?: unknown };
        words = String(said.error?.message ?? said.message ?? data);
      } catch {
        // Its words alone (sendWords), not JSON.
      }
      return messagesError(words);
    }
    const event = JSON.parse(data) as { index?: number; message?: Record<string, unknown>; content_block?: StreamBlock; delta?: Record<string, unknown>; usage?: Record<string, unknown> };
    const at = event.index ?? -1;
    if (kind === "message_start") message = { ...event.message };
    else if (kind === "content_block_start" && event.content_block) blocks[at] = { ...event.content_block };
    else if (kind === "content_block_delta" && blocks[at] && event.delta) {
      const { type, text, thinking, signature, partial_json: piece } = event.delta as { type?: string; text?: string; thinking?: string; signature?: string; partial_json?: string };
      if (type === "text_delta") blocks[at].text = (blocks[at].text ?? "") + (text ?? "");
      else if (type === "thinking_delta") blocks[at].thinking = (blocks[at].thinking ?? "") + (thinking ?? "");
      else if (type === "signature_delta") blocks[at].signature = signature ?? "";
      else if (type === "input_json_delta") pieces.set(at, (pieces.get(at) ?? "") + (piece ?? ""));
    } else if (kind === "message_delta") message = { ...message, ...(event.delta ?? {}), usage: { ...((message.usage as object | undefined) ?? {}), ...(event.usage ?? {}) } };
  }
  for (const [at, piece] of pieces) if (blocks[at] && piece) blocks[at].input = JSON.parse(piece) as unknown;
  return Response.json({ ...message, content: blocks.filter(Boolean) });
}

/** pi-ai's stop reason as Messages says it. */
const stopReasonOf = (reason: string | undefined): string => (reason === "toolUse" ? "tool_use" : reason === "length" ? "max_tokens" : "end_turn");

type MessagesBlock = { type: string; text?: string; thinking?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; content?: string | MessagesBlock[]; is_error?: boolean; source?: { type?: string; media_type?: string; data?: string } };
type MessagesRequest = {
  model?: string;
  max_tokens?: number;
  thinking?: { type?: string };
  output_config?: { effort?: unknown };
  metadata?: { user_id?: string };
  system?: string | MessagesBlock[];
  messages?: { role: "user" | "assistant"; content: string | MessagesBlock[] }[];
  tools?: { name: string; description?: string; input_schema?: unknown }[];
};

/** pi-ai's thinking levels past off, each asked by its own name. */
const NAMED_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
/** How the route's translation has pi's session register a model that reasons: on Messages, with adaptive thinking whose
 *  effort is the level's own name (a thinkingLevelMap of each level to itself), so a request carries the session's level
 *  as it is, `output_config.effort`, and no budget the translation would have to read a level back from. Off maps to
 *  nothing: a session at off sends thinking disabled, and no level reaches the model. */
const LEVELS_BY_NAME = { reasoning: true, adaptiveThinking: true, thinkingLevelMap: Object.fromEntries(NAMED_LEVELS.map((level) => [level, level])) as ThinkingLevelMap } as const;
/** The thinking level a Messages request from pi's session asks (LEVELS_BY_NAME), else undefined: none asked, or off. */
function levelOf(body: MessagesRequest): (typeof NAMED_LEVELS)[number] | undefined {
  const effort = body.output_config?.effort;
  return body.thinking?.type === "adaptive" && (NAMED_LEVELS as readonly unknown[]).includes(effort) ? (effort as (typeof NAMED_LEVELS)[number]) : undefined;
}

/** A part of a pi-ai message, as the context carries it. */
type Part = { readonly type: string; readonly [key: string]: unknown };

const textOf = (content: string | MessagesBlock[] | undefined): string => (typeof content === "string" ? content : (content ?? []).filter((block) => block.type === "text").map((block) => block.text ?? "").join("\n"));

/** A Messages block as pi-ai's part: a text as text, a base64 image as an image; anything else none. */
const partOf = (block: MessagesBlock): Part[] =>
  block.type === "text" ? [{ type: "text", text: block.text ?? "" }] : block.type === "image" && block.source?.data ? [{ type: "image", data: block.source.data, mimeType: block.source.media_type ?? "image/png" }] : [];

/** A tool_result's content as pi-ai's toolResult content: its parts in order (partOf), so a screenshot a tool returned
 *  reaches the model, with the texts between two images joined by "\n" into one part, so a result of text alone is the
 *  one text it always was (textOf). A string is one text. Never empty: a result with no text or image part is one empty
 *  text. */
const resultOf = (content: string | MessagesBlock[] | undefined): Part[] => {
  if (typeof content === "string" || content === undefined) return [{ type: "text", text: content ?? "" }];
  const parts: Part[] = [];
  for (const part of content.flatMap(partOf)) {
    const last = parts.at(-1);
    if (part.type === "text" && last?.type === "text") parts[parts.length - 1] = { type: "text", text: `${String(last.text)}\n${String(part.text)}` };
    else parts.push(part);
  }
  return parts.length ? parts : [{ type: "text", text: "" }];
};

/** A Messages request as pi-ai's context on `target`: its system prompt, tools and turns (a tool_result as its own
 *  toolResult message, naming the tool its call named; `providerId` maps a call id back to the provider's). */
function contextOf(body: MessagesRequest, target: PiModel, providerId: (id: string) => string): unknown {
  const named = new Map<string, string>();
  const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const messages: unknown[] = [];
  for (const message of body.messages ?? []) {
    const blocks: MessagesBlock[] = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
    if (message.role === "assistant") {
      const content = blocks.flatMap((block): Part[] => {
        if (block.type === "text") return [{ type: "text", text: block.text ?? "" }];
        // Retain Particle's native reasoning alongside the assistant tool call on continuation. The Messages
        // hop has already redacted this text; restore only the field name, never a foreign provider's signature.
        if (target.provider === "particle" && block.type === "thinking") return [{ type: "thinking", thinking: block.thinking ?? "", thinkingSignature: "reasoning_content" }];
        if (block.type === "tool_use") {
          named.set(block.id ?? "", block.name ?? "");
          return [{ type: "toolCall", id: providerId(block.id ?? ""), name: block.name ?? "", arguments: (block.input ?? {}) as object }];
        }
        return [];
      });
      messages.push({ role: "assistant", content, api: target.api, provider: target.provider, model: target.id, usage: zero, stopReason: content.some((part) => part.type === "toolCall") ? "toolUse" : "stop", timestamp: Date.now() });
      continue;
    }
    const said = blocks.flatMap(partOf);
    for (const block of blocks.filter((each) => each.type === "tool_result")) {
      const id = block.tool_use_id ?? "";
      messages.push({ role: "toolResult", toolCallId: providerId(id), toolName: named.get(id) ?? "", content: resultOf(block.content), isError: block.is_error === true, timestamp: Date.now() });
    }
    if (said.length) messages.push({ role: "user", content: said, timestamp: Date.now() });
  }
  const system = typeof body.system === "string" ? body.system : textOf(body.system);
  return {
    ...(system ? { systemPrompt: system } : {}),
    messages,
    ...(body.tools?.length ? { tools: body.tools.map((tool) => ({ name: tool.name, description: tool.description ?? "", parameters: tool.input_schema ?? { type: "object", properties: {} } })) } : {}),
  };
}

/** How many times a text-tools reply is asked for when it opens a call block that holds no call it can read. */
const TEXT_TOOL_TRIES = 3;

/** `used` priced on `target`'s catalog entry: pi-ai's calculateCost, tiers included (the proxy's booking, and the cap's). */
function priceOn(target: PiModel, used: RouteUsage): number {
  const usage = { ...used, totalTokens: used.input + used.output + used.cacheRead + used.cacheWrite, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  return calculateCost(target as never, usage as never).total;
}

/** A text-tools re-ask's output limit: the most tokens it may answer with when what is left of the request's hold is
 *  `leftUsd` (its first try's input as it was billed and its output limit `outputHeld`, less every try so far) and its
 *  input, the prompt `last` was asked with, is priced uncached at the dearer of the input and cache-write prices, as the
 *  cap prices a fresh input. Never more than `outputHeld`; 0 when nothing is left. So the one hold the cap took for
 *  the request covers every try it makes. */
export function reaskTokens(target: PiModel, last: RouteUsage, leftUsd: number, outputHeld: number): number {
  const prompt = last.input + last.cacheRead + last.cacheWrite;
  const at = (output: number) => Math.max(priceOn(target, { input: prompt, output, cacheRead: 0, cacheWrite: 0 }), priceOn(target, { input: 0, output, cacheRead: 0, cacheWrite: prompt }));
  const inputUsd = at(0);
  const perToken = (at(1_000_000) - inputUsd) / 1_000_000;
  const room = leftUsd - inputUsd;
  if (room < 0) return 0;
  if (!(perToken > 0)) return outputHeld;
  return Math.max(0, Math.min(outputHeld, Math.floor(room / perToken)));
}
