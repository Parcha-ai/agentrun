// The live parts, through one model gateway: the agent and the workflow's nodes on an OpenAI Responses endpoint at
// `<gateway>/v1`, and Jev at `<gateway>/typesafe`. A gateway that holds the keys needs none from this process.
//   LEARN_CLASSIFY_GATEWAY      the gateway's root URL, or its /v1 base (required for --live outside a take)
//   AGENTRUN_BROKER_URL         a take's broker (take-in-docker.sh sets it), used when the one above is not set
//   LEARN_CLASSIFY_GATEWAY_KEY  the key the gateway wants, if it wants one
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy';
import { createModels, createProvider } from '@earendil-works/pi-ai/models';
import { createJevRunner } from '@parcha/agentrun-jev';

/** USD per million tokens. Estimates from list prices, for the spend guard and the rows; the gateway's ledger is the bill.
 *  A cache read is priced as input, so the guard errs high. */
export const LUNA_PRICE = Object.freeze({ input: 0.1, output: 0.5, cacheRead: 0.1, cacheWrite: 0.1 });
export const JEV_PRICE = Object.freeze({ inputUsdPerMillionTokens: 0.042, outputUsdPerMillionTokens: 0 });
const NO_KEY = 'gateway-holds-the-key';

export function gatewayOf(env = process.env) {
  // The root, also when given as the OpenAI base URL (`.../v1`), as a take's broker variables are. In a take
  // (take-in-docker.sh) AGENTRUN_BROKER_URL names the broker when LEARN_CLASSIFY_GATEWAY is not set.
  const root = (env.LEARN_CLASSIFY_GATEWAY || env.AGENTRUN_BROKER_URL)?.replace(/\/+$/, '').replace(/\/v1$/, '');
  if (!root) throw new Error('--live needs LEARN_CLASSIFY_GATEWAY (or, in a take, AGENTRUN_BROKER_URL): a gateway root that serves an OpenAI Responses endpoint at /v1 and Jev at /typesafe');
  return { root, key: env.LEARN_CLASSIFY_GATEWAY_KEY || NO_KEY };
}

/** `{ models, agent }` for the root agent; the workflow's nodes take the same model at their own thinking level. */
export function gatewayModel(gateway, { model = 'gpt-6-luna', thinking = 'medium', price = LUNA_PRICE } = {}) {
  const baseUrl = `${gateway.root}/v1`;
  const models = createModels();
  models.setProvider(createProvider({
    id: 'gateway',
    baseUrl,
    auth: { apiKey: { name: 'LEARN_CLASSIFY_GATEWAY_KEY', resolve: async () => ({ auth: { apiKey: gateway.key }, source: 'LEARN_CLASSIFY_GATEWAY_KEY' }) } },
    models: [{
      id: model, name: model, api: 'openai-responses', provider: 'gateway', baseUrl, reasoning: true, input: ['text'],
      cost: { ...price }, contextWindow: 400_000, maxTokens: 16_000, compat: { supportsDeveloperRole: false },
    }],
    api: openAIResponsesApi(),
  }));
  return { models, agent: { model: { provider: 'gateway', modelId: model }, thinkingLevel: thinking } };
}

/** Jev as the DSL's `runJudge` port, through the gateway. */
export function gatewayJev(gateway, { timeoutMs = 60_000 } = {}) {
  return createJevRunner({ apiKey: gateway.key, baseURL: `${gateway.root}/typesafe`, pricing: { ...JEV_PRICE }, timeoutMs, maxAttempts: 3 });
}
