// A CLI harness run's own model requests beside the harness's (a learned workflow's model nodes and `llm` call nodes, a
// call node's native search) on the run's one route: the session's model proxy (AdapterSession.port), under a side key
// minted for LEARNED_WORKFLOW_TOOL. Through it each request gets what the harness's own get: the policy that shapes and
// checks its body, the provider's origin and credential (the operator's gateway, OpenRouter, the vendor's API: whatever
// the harness's requests use), the harness's price, and the session's booking, under the run's one cap (harness-app.ts
// guard), labelled on its runner.request record. No client of their own, no second meter.
//
// The models here are pi-ai's (the learned node runner and the completer take a pi-ai registry), with one model: the
// session's, at the proxy, in the API the proxy serves, with the side key as its bearer token. pi-ai's own cost on an
// answer is the catalog's reading of its usage, for the call's own report (llm.ts); what the run is charged is the
// session's booking.
import type { Api, AssistantMessage, AssistantMessageEventStream, Context, Model, ProviderStreams, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { createProvider } from "@earendil-works/pi-ai/models";
import type { SessionPort } from "@parcha/agentrun-kernel";
import { attachingImages } from "./attach-images.js";

/** The provider id the port's one model is listed under. */
export const PORT_PROVIDER = "agentrun-session";
/** The provider id a tier's port model is listed under (tieredModels): the run's model of that tier, on a proxy of its
 *  own beside the session's (AdapterSession.port's `tier`). */
export const tierProvider = (tier: string): string => `${PORT_PROVIDER}-${tier}`;

/** Where pi-ai's client of `api` is pointed to reach a session's proxy at `url`: Anthropic's SDK adds /v1/messages to its
 *  base; OpenAI's adds /responses to a base that holds /v1. The one rule for the port's models and pi's own (runner
 *  adapters/pi.ts). */
export const sessionBaseUrl = (api: SessionPort["api"], url: string): string => (api === "anthropic-messages" ? url : `${url}/v1`);

/** The effort a model asks for at each thinking level, as pi-ai's catalog says (null: no effort sent). */
export type ThinkingLevelMap = NonNullable<Model<Api>["thinkingLevelMap"]>;

/** The catalog's entry for a session's model, as its route carries it (model-route.ts `like`): its reasoning, price,
 *  window and ceiling, the effort each thinking level asks for, and what it takes as input with its input limits. */
/** `developerRole`: on Responses, the instructions go as a developer message, not a system one (a ChatGPT plan's route,
 *  which takes no system message). `adaptiveThinking`: on Messages, the session asks its thinking level as an adaptive
 *  effort (pi-ai's `forceAdaptiveThinking`), never a token budget: the route's own translation reads that level back
 *  (model-route.ts LEVELS_BY_NAME). `translatedChatCompletions`: the Messages hop carries native Chat Completions
 *  reasoning and a conversation cache key; its thinking blocks may have no signature. */
export type SessionLike = Partial<Pick<Model<Api>, "reasoning" | "cost" | "contextWindow" | "maxTokens" | "thinkingLevelMap">> & { readonly input?: readonly string[]; readonly inputLimits?: unknown; readonly developerRole?: boolean; readonly adaptiveThinking?: boolean; readonly translatedChatCompletions?: boolean };

/** Pi's side port with its route's catalog metadata. A plain harness port remains valid; the kernel needs only the
 *  proxy coordinates, while the host's model client also keeps its reasoning, limits and translation settings. */
export type SessionModelPort = SessionPort & { readonly like?: SessionLike };

/** The one model of a session's route as pi-ai lists it, for the port's requests and for pi's own (runner adapters/pi.ts):
 *  `model` in `api` at the proxy `url` (sessionBaseUrl), under `provider`, with `headers` (the session key as the proxy
 *  reads one, a bearer token), its reasoning, limits, price, input and input limits from `like` (the catalog's entry),
 *  `reasoning` when it says none. With no input said it takes images on either wire: a host tool's images (a screenshot)
 *  reach the model in its tool result. OpenAI's Responses through a gateway takes no developer role (pi-ai sends its
 *  system prompt as a system message). */
export function sessionModel(api: SessionPort["api"], url: string, model: string, options: { provider: string; headers?: Readonly<Record<string, string | null>>; like?: SessionLike; reasoning: boolean }): Model<Api> {
  const { like } = options;
  return {
    id: model, name: model, api, provider: options.provider, baseUrl: sessionBaseUrl(api, url), ...(options.headers ? { headers: options.headers } : {}),
    // What the model takes as input and its input limits, as the catalog says (the route's `like`): a model that takes no
    // images is sent pi-ai's placeholder in place of one, and pi's read holds an image to its limits. Unsaid, text and
    // images within pi's defaults.
    // The effort each thinking level asks for, as the catalog says: a level it maps to null sends none, so pi's thinking
    // off sends no "none" to a model that refuses it (gpt-6.1-sol). Unsaid, pi-ai's defaults.
    reasoning: like?.reasoning ?? options.reasoning, ...(like?.thinkingLevelMap ? { thinkingLevelMap: like.thinkingLevelMap } : {}),
    input: like?.input ? [...like.input] : ["text", "image"],
    ...(like?.inputLimits ? { inputLimits: like.inputLimits } : {}),
    cost: like?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: like?.contextWindow ?? 200_000, maxTokens: like?.maxTokens ?? 32_000,
    ...(api === "openai-responses" ? { compat: { supportsDeveloperRole: like?.developerRole === true } } : {}),
    ...(api === "anthropic-messages" && (like?.adaptiveThinking || like?.translatedChatCompletions) ? { compat: { forceAdaptiveThinking: true, ...(like.translatedChatCompletions ? { allowEmptySignature: true } : {}) } } : {}),
  } as unknown as Model<Api>;
}

/** pi-ai's provider for the one model of a session's proxy on its wire: pi-ai's client of `api` (Anthropic's Messages or
 *  OpenAI's Responses) at the proxy (sessionBaseUrl), its one model `model` (sessionModel), the proxy's session key its
 *  credential (named `keyName`). The proxy knows a request by `authorization: Bearer <key>`: on Messages that header is set
 *  on the model, since pi-ai's Anthropic client sends its key as x-api-key, which the proxy does not forward; on Responses
 *  pi-ai sends the key as that bearer token itself. The one client every runner caller of a session proxy builds: pi's
 *  sessions and a workflow's model nodes. Each request's images are checked as they are attached
 *  (attach-images.ts): one a provider would refuse goes as a text saying why. */
export function sessionProvider(api: SessionPort["api"], proxy: { readonly url: string; readonly key: string }, model: string, options: { provider: string; keyName: string; like?: SessionLike; reasoning: boolean }): ReturnType<typeof createProvider> {
  return createProvider({
    id: options.provider,
    baseUrl: sessionBaseUrl(api, proxy.url),
    auth: { apiKey: { name: options.keyName, resolve: async () => ({ auth: { apiKey: proxy.key }, source: "session" }) } },
    models: [sessionModel(api, proxy.url, model, { provider: options.provider, ...(api === "anthropic-messages" ? { headers: { authorization: `Bearer ${proxy.key}` } } : {}), ...(options.like ? { like: options.like } : {}), reasoning: options.reasoning })],
    api: sessionApi(api, options.like),
  } as never);
}

/** A translated Chat Completions session carries its cache identity in Messages' existing metadata field: the proxy
 *  preserves it without forwarding extra headers. The translation uses it only for provider cache affinity. */
function sessionApi(api: SessionPort["api"], like?: SessionLike): ProviderStreams {
  const own = attachingImages(api === "anthropic-messages" ? anthropicMessagesApi() : openAIResponsesApi());
  if (api !== "anthropic-messages" || !like?.translatedChatCompletions) return own;
  const withSession = <O extends { sessionId?: string; cacheRetention?: "none" | "short" | "long"; metadata?: Record<string, unknown> }>(options?: O) => ({
    ...options,
    // The upstream can have accepted a paid request before this hop fails. Never replay it implicitly.
    maxRetries: 0,
    ...(options?.cacheRetention === "none" ? { metadata: { ...options.metadata, user_id: "" } } : options?.sessionId ? { metadata: { ...options.metadata, user_id: options.sessionId } } : {}),
  });
  return {
    ...own,
    stream: (model, context, options) => own.stream(model, context, withSession(options)),
    streamSimple: (model, context, options) => own.streamSimple(model, context, withSession(options)),
  };
}

/** The run's models over a session's port, as learned-workflow.ts, llm.ts and hosted-search.ts take them. */
export type PortModels = {
  getModel(provider: string, id: string): Model<Api> | undefined;
  getModels(): readonly Model<Api>[];
  streamSimple(model: Model<Api>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream;
  completeSimple(model: Model<Api>, context: Context, options?: SimpleStreamOptions): Promise<AssistantMessage>;
};

/** Models over `port` (the session's, read at each request: undefined until a drive has attached a proxy, and anew for
 *  each drive), one model named by any provider and id: the session's own, listed under `provider`. `like`: the
 *  catalog's entry for the model the run is priced by, whose reasoning, limits and price the port's model takes; absent,
 *  the current port's own metadata, when supplied by Pi. */
export async function portModels(port: () => SessionModelPort | undefined, like?: SessionLike, provider: string = PORT_PROVIDER): Promise<PortModels> {
  const { createModels } = await import("@earendil-works/pi-ai/models");
  // One registry per proxy and key: a later drive's proxy is a new address.
  let built: { at: string; models: ReturnType<typeof createModels>; model: Model<Api> } | undefined;
  const current = () => {
    const now = port();
    if (!now) return undefined;
    const at = `${now.url} ${now.key} ${now.model} ${now.api}`;
    if (built?.at === at) return built;
    const baseUrl = sessionBaseUrl(now.api, now.url);
    // Read the current drive's metadata with its port. An explicit caller description still takes precedence.
    const description = like ?? now.like;
    // The side key as the proxy reads a key (a bearer token), and no beta header pi-ai would add of its own: the session's
    // policy admits the betas its harness sends, and these requests need none.
    const headers = { authorization: `Bearer ${now.key}`, ...(now.api === "anthropic-messages" ? { "anthropic-beta": null } : {}) };
    const model = sessionModel(now.api, now.url, now.model, { provider, headers, ...(description ? { like: description } : {}), reasoning: true });
    const models = createModels({});
    models.setProvider(createProvider({
      id: provider, baseUrl,
      auth: { apiKey: { name: "the session's side key", resolve: async () => ({ auth: { apiKey: now.key }, source: "session" }) } },
      models: [model as never],
      api: sessionApi(now.api, description),
    } as never));
    built = { at, models, model: models.getModel(provider, now.model) as Model<Api> };
    return built;
  };
  const registry = (model: Model<Api>) => {
    const at = current();
    if (!at || at.model !== model) throw new Error("the session's model route is not up: no turn holds its proxy");
    return at.models;
  };
  return {
    getModel: () => current()?.model,
    getModels: () => {
      const at = current();
      return at ? [at.model] : [];
    },
    streamSimple: (model, context, options) => registry(model).streamSimple(model as never, context, options) as AssistantMessageEventStream,
    completeSimple: (model, context, options) => registry(model).completeSimple(model as never, context, options) as Promise<AssistantMessage>,
  };
}

/** Port models of several ports as one registry (learned-workflow.ts takes one): each listed under its own provider id
 *  (PORT_PROVIDER for the session's, tierProvider(tier) for a tier's), a model's request sent through the port it came
 *  from. */
export function tieredModels(byProvider: ReadonlyMap<string, PortModels>): PortModels {
  const of = (model: Model<Api>): PortModels => {
    const port = byProvider.get(model.provider);
    if (!port) throw new Error(`no port of the run lists the model ${model.provider}/${model.id}`);
    return port;
  };
  return {
    getModel: (provider, id) => byProvider.get(provider)?.getModel(provider, id),
    getModels: () => [...byProvider.values()].flatMap((port) => port.getModels()),
    streamSimple: (model, context, options) => of(model).streamSimple(model, context, options),
    completeSimple: (model, context, options) => of(model).completeSimple(model, context, options),
  };
}
