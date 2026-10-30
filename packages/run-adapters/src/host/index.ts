// What a harness adapter runs beside its harness on the host: the session's model proxy, provider-neutral, with each
// provider's rules in a `ProviderPolicy`. Written for AgentRun.
export { hostHeaderProblems, matchRoute, parseStrict, providerIdsOf, ProxyRefusal, reportedCostOf, sameKey, startModelProxy } from "./proxy.js";
export type { ModelProxy, ModelProxyHooks, ModelProxyOptions, ModelUsageReport, ProviderPolicy, ProxyRoute, ProxyUsage } from "./proxy.js";
export { processAlive } from "./alive.js";
export { serialWriter } from "./serial.js";
export { addressBytes, checkAddress, EGRESS_RANGES } from "./egress-table.js";
export type { EgressClass, EgressVerdict } from "./egress-table.js";
export { startEgressProxy } from "./egress-proxy.js";
export type { EgressLookup, EgressProxy, EgressProxyOptions } from "./egress-proxy.js";
export { PARENT_WATCH_SHIM, parentWatched, parentWatchHere, SETPRIV } from "./parent-death.js";
export type { LaunchCommand, ParentWatch } from "./parent-death.js";
