// What a harness adapter runs beside its harness on the host: the session's model proxy, provider-neutral, with each
// provider's rules in a `ProviderPolicy`. Written for AgentRun.
export { ANTHROPIC_IMAGE_TOKENS_MAX, ANTHROPIC_TOOL_USE_SYSTEM_PROMPT_TOKENS, ASSUMED_TOOL_PROMPT_TOKENS, INPUT_OVERHEAD_APIS, OPENAI_IMAGE_TOKENS_MAX, providerInputOverhead, type InputShape } from "./overhead.js";
export { hostHeaderProblems, inputTokensMaxOf, matchRoute, parseStrict, providerIdsOf, ProxyRefusal, reportedCostOf, sameKey, startModelProxy } from "./proxy.js";
export type { ModelProxy, ModelProxyHooks, ModelProxyOptions, ModelUsageReport, ProviderPolicy, ProxyRoute, ProxyUsage } from "./proxy.js";
export { processAlive } from "./alive.js";
export { serialWriter } from "./serial.js";
export { addressBytes, checkAddress, EGRESS_RANGES } from "./egress-table.js";
export type { EgressClass, EgressVerdict } from "./egress-table.js";
export { startEgressProxy } from "./egress-proxy.js";
export type { EgressLookup, EgressProxy, EgressProxyOptions } from "./egress-proxy.js";
export { PARENT_WATCH_SHIM, parentWatched, parentWatchHere, SETPRIV } from "./parent-death.js";
export type { LaunchCommand, ParentWatch } from "./parent-death.js";
export { BoxError } from "./box.js";
export type { Box, BoxedChild, BoxErrorCode, BoxRecord, BoxRecorder, BoxSpec, Isolation, Reaped } from "./box.js";
export { boxSlot } from "./box-slot.js";
export type { BoxSlot, BoxSlotState, BoxStart, SlotChild } from "./box-slot.js";
