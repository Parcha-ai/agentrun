// The live parts, through one model gateway: the root agent on Opus (Anthropic's Messages API at the gateway's root), a
// workflow's agent nodes on the cheap model the host sets (`NODE`), and Jev at `<gateway>/typesafe`. A gateway that holds
// the keys needs none from this process.
//   LEARN_CLASSIFY_GATEWAY      the gateway's root URL, or its /v1 base (required for --live outside a take)
//   AGENTRUN_BROKER_URL         a take's broker (take-in-docker.sh sets it), used when the one above is not set
//   LEARN_CLASSIFY_GATEWAY_KEY  the key the gateway wants, if it wants one
import { createJevRunner } from '@parcha/agentrun-jev';

/** USD per million tokens, by model. In and out were measured through the gateway's cost header; the gateway's ledger is
 *  the bill. Opus's cache prices are assumed (a tenth of input to read, 1.25 times to write); the cheap models' cache is
 *  priced as input, so the guard errs high. */
export const PRICES = Object.freeze({
  'claude-opus-5-5': Object.freeze({ input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5 }),
  'gpt-6-luna': Object.freeze({ input: 0.1, output: 0.5, cacheRead: 0.1, cacheWrite: 0.1 }),
  'deepseek-v4.1-flash': Object.freeze({ input: 0.22, output: 0.66, cacheRead: 0.22, cacheWrite: 0.22 }),
});
export const LUNA_PRICE = PRICES['gpt-6-luna'];
export const JEV_PRICE = Object.freeze({ inputUsdPerMillionTokens: 0.042, outputUsdPerMillionTokens: 0 });
const NO_KEY = 'gateway-holds-the-key';

/** The root agent: by-hand runs, notes, writing and fixing workflows, escalations. */
export const ROOT = Object.freeze({ model: 'claude-opus-5-5', thinking: 'high' });
/** The cheap models a workflow's agent nodes can run. deepseek-v4.1-flash thinks only at low or high (pi-ai's map). */
export const NODE_MODELS = Object.freeze({
  luna: Object.freeze({ model: 'gpt-6-luna', thinking: 'medium' }),
  deepseek: Object.freeze({ model: 'deepseek-v4.1-flash', thinking: 'high' }),
});
/** The model every workflow agent node runs on, set by the host: a workflow cannot choose. Switch it here. */
export const NODE = NODE_MODELS.luna;

export function gatewayOf(env = process.env) {
  // The root, also when given as the OpenAI base URL (`.../v1`), as a take's broker variables are. In a take
  // (take-in-docker.sh) AGENTRUN_BROKER_URL names the broker when LEARN_CLASSIFY_GATEWAY is not set.
  const root = (env.LEARN_CLASSIFY_GATEWAY || env.AGENTRUN_BROKER_URL)?.replace(/\/+$/, '').replace(/\/v1$/, '');
  if (!root) throw new Error('--live needs LEARN_CLASSIFY_GATEWAY (or, in a take, AGENTRUN_BROKER_URL): a gateway root that serves an OpenAI Responses endpoint at /v1 and Jev at /typesafe');
  return { root, key: env.LEARN_CLASSIFY_GATEWAY_KEY || NO_KEY };
}

/** How the gateway serves each model: Anthropic's over its Messages API at the gateway's root (the client adds
 *  /v1/messages; thinking comes back as thinking blocks), OpenAI's over Responses and DeepSeek's over chat completions at
 *  `<gateway>/v1`, each with pi-ai's own limits and compat for it and the price above. */
async function catalogEntry(gateway, id) {
  const price = PRICES[id];
  if (!price) throw new Error(`no price for ${id}: add it to PRICES in models.mjs`);
  if (id.startsWith('claude-')) {
    const { anthropicProvider } = await import('@earendil-works/pi-ai/providers/anthropic');
    const entry = anthropicProvider().getModels().find((m) => m.id === id);
    if (!entry) throw new Error(`pi-ai has no Anthropic model ${id}`);
    return { ...entry, provider: 'gateway', api: 'anthropic-messages', baseUrl: gateway.root, cost: { ...price } };
  }
  if (id.startsWith('deepseek-')) {
    const { deepseekProvider } = await import('@earendil-works/pi-ai/providers/deepseek');
    const like = deepseekProvider().getModels().find((m) => m.id === 'deepseek-flash');
    return { ...like, id, name: id, provider: 'gateway', api: 'openai-completions', baseUrl: `${gateway.root}/v1`, cost: { ...price } };
  }
  return {
    id, name: id, api: 'openai-responses', provider: 'gateway', baseUrl: `${gateway.root}/v1`, reasoning: true, input: ['text'],
    cost: { ...price }, contextWindow: 400_000, maxTokens: 16_000, compat: { supportsDeveloperRole: false },
  };
}

/**
 * `{ models, agent, node }`: the root agent's model and thinking (`ROOT`) and the one every workflow agent node runs on
 * (`NODE`), in one catalog through the gateway. Each conversation is priced by its own model's entry. Thinking is never off.
 */
export async function gatewayModels(gateway, { root = ROOT, node = NODE } = {}) {
  for (const [who, pick] of [['root', root], ['node', node]]) {
    if (!pick?.thinking || pick.thinking === 'off') throw new Error(`the ${who} model must think: thinking is never off`);
  }
  const [{ anthropicMessagesApi }, { openAICompletionsApi }, { openAIResponsesApi }, { createModels, createProvider }] = await Promise.all([
    import('@earendil-works/pi-ai/api/anthropic-messages.lazy'), import('@earendil-works/pi-ai/api/openai-completions.lazy'),
    import('@earendil-works/pi-ai/api/openai-responses.lazy'), import('@earendil-works/pi-ai/models'),
  ]);
  const ids = [...new Set([root.model, node.model])];
  const models = createModels();
  models.setProvider(createProvider({
    id: 'gateway',
    baseUrl: `${gateway.root}/v1`,
    auth: { apiKey: { name: 'LEARN_CLASSIFY_GATEWAY_KEY', resolve: async () => ({ auth: { apiKey: gateway.key }, source: 'LEARN_CLASSIFY_GATEWAY_KEY' }) } },
    models: await Promise.all(ids.map((id) => catalogEntry(gateway, id))),
    api: { 'anthropic-messages': anthropicMessagesApi(), 'openai-responses': openAIResponsesApi(), 'openai-completions': openAICompletionsApi() },
  }));
  const ref = (pick) => ({ model: { provider: 'gateway', modelId: pick.model }, thinkingLevel: pick.thinking });
  return { models, agent: ref(root), node: ref(node) };
}

/** Jev as the DSL's `runJudge` port, through the gateway. */
export function gatewayJev(gateway, { timeoutMs = 60_000 } = {}) {
  return createJevRunner({ apiKey: gateway.key, baseURL: `${gateway.root}/typesafe`, pricing: { ...JEV_PRICE }, timeoutMs, maxAttempts: 3 });
}
