// What a harness adapter runs beside its harness on the host: the session's local machine, and its model proxy,
// provider-neutral, with each provider's rules in a `ProviderPolicy`. Written for AgentRun.
export { hostHeaderProblems, matchRoute, parseStrict, providerIdsOf, ProxyRefusal, reportedCostOf, sameKey, startModelProxy } from "./proxy.js";
export type { ModelProxy, ModelProxyHooks, ModelProxyOptions, ModelUsageReport, ProviderPolicy, ProxyRoute, ProxyUsage } from "./proxy.js";
export { processAlive } from "./alive.js";
export { serialWriter } from "./serial.js";
export { childEnv, confined, INHERITED_ENV, openLocalMachine, startChild } from "./machine.js";
export type { CacheFile, ChildCommand, ConfineChild, KillSignal, LocalMachine, LocalMachineSpec, MachineChild, MachineSpawn, MachineTail } from "./machine.js";
