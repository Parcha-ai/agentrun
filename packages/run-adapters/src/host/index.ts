// What a harness adapter runs beside its harness on the host: the session's model proxy, provider-neutral, with each
// provider's rules in a `ProviderPolicy`. Written for AgentRun.
export { ANTHROPIC_IMAGE_TOKENS_MAX, ANTHROPIC_TOOL_USE_SYSTEM_PROMPT_TOKENS, ASSUMED_TOOL_PROMPT_TOKENS, INPUT_OVERHEAD_APIS, OPENAI_IMAGE_TOKENS_MAX, providerInputOverhead, type InputShape } from "./overhead.js";
export { hostHeaderProblems, inputTokensMaxOf, matchRoute, parseStrict, providerIdsOf, ProxyRefusal, reportedCostOf, sameKey, startModelProxy } from "./proxy.js";
export type { ModelProxy, ModelProxyHooks, ModelProxyOptions, ModelUsageReport, ProviderPolicy, ProxyRoute, ProxyUsage } from "./proxy.js";
export { processAlive } from "./alive.js";
export { serialWriter } from "./serial.js";
