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
import type { Api, AssistantMessage, AssistantMessageEventStream, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { SessionPort } from "@parcha/agentrun-kernel";

/** The provider id the port's one model is listed under. */
export const PORT_PROVIDER = "agentrun-session";

/** The run's models over a session's port, as learned-workflow.ts, llm.ts and hosted-search.ts take them. */
export type PortModels = {
  getModel(provider: string, id: string): Model<Api> | undefined;
  getModels(): readonly Model<Api>[];
  streamSimple(model: Model<Api>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream;
  completeSimple(model: Model<Api>, context: Context, options?: SimpleStreamOptions): Promise<AssistantMessage>;
};

/** Models over `port` (the session's, read at each request: undefined until a drive has attached a proxy, and anew for
 *  each drive), one model named by any provider and id: the session's own. `like`: the catalog's entry for the model the
 *  run is priced by, whose reasoning, limits and price the port's model takes. */
export async function portModels(port: () => SessionPort | undefined, like?: Partial<Model<Api>>): Promise<PortModels> {
  const [{ createModels, createProvider }, { anthropicMessagesApi }, { openAIResponsesApi }] = await Promise.all([
    import("@earendil-works/pi-ai/models"),
    import("@earendil-works/pi-ai/api/anthropic-messages.lazy"),
    import("@earendil-works/pi-ai/api/openai-responses.lazy"),
  ]);
  // One registry per proxy and key: a later drive's proxy is a new address.
  let built: { at: string; models: ReturnType<typeof createModels>; model: Model<Api> } | undefined;
  const current = () => {
    const now = port();
    if (!now) return undefined;
    const at = `${now.url} ${now.key} ${now.model} ${now.api}`;
    if (built?.at === at) return built;
    // Anthropic's SDK adds /v1/messages to its base; OpenAI's adds /responses to a base that holds /v1.
    const baseUrl = now.api === "anthropic-messages" ? now.url : `${now.url}/v1`;
    // The side key as the proxy reads a key (a bearer token), and no beta header pi-ai would add of its own: the session's
    // policy admits the betas its harness sends, and these requests need none.
    const headers = { authorization: `Bearer ${now.key}`, ...(now.api === "anthropic-messages" ? { "anthropic-beta": null } : {}) } as unknown as Record<string, string>;
    const model = {
      id: now.model, name: now.model, api: now.api, provider: PORT_PROVIDER, baseUrl, headers,
      reasoning: like?.reasoning ?? true, input: ["text"],
      cost: like?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: like?.contextWindow ?? 200_000, maxTokens: like?.maxTokens ?? 32_000,
      ...(now.api === "openai-responses" ? { compat: { supportsDeveloperRole: false } } : {}),
    } as unknown as Model<Api>;
    const models = createModels({});
    models.setProvider(createProvider({
      id: PORT_PROVIDER, baseUrl,
      auth: { apiKey: { name: "the session's side key", resolve: async () => ({ auth: { apiKey: now.key }, source: "session" }) } },
      models: [model as never],
      api: now.api === "anthropic-messages" ? anthropicMessagesApi() : openAIResponsesApi(),
    } as never));
    built = { at, models, model: models.getModel(PORT_PROVIDER, now.model) as Model<Api> };
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
