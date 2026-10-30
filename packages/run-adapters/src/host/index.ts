// What a harness adapter runs beside its harness on the host: the session's local machine, and its model proxy,
// provider-neutral, with each provider's rules in a `ProviderPolicy`. Written for AgentRun.
export { hostHeaderProblems, matchRoute, parseStrict, providerIdsOf, ProxyRefusal, reportedCostOf, sameKey, startModelProxy } from "./proxy.js";
export type { ModelProxy, ModelProxyHooks, ModelProxyOptions, ModelUsageReport, ProviderPolicy, ProxyRoute, ProxyUsage } from "./proxy.js";
export { processAlive } from "./alive.js";
export { serialWriter } from "./serial.js";
export { BOX_EGRESS_SOCKET, BOX_MODEL_SOCKET, childEnv, confined, INHERITED_ENV, openLocalMachine, startChild } from "./machine.js";
export { listenSocket } from "./socket.js";
export { BOX_FORWARD, BOX_LOOPBACK, forward, forwardChild, parseForward } from "./box-forward.js";
export type { ForwardListen } from "./box-forward.js";
export type { CacheFile, ChildCommand, ConfineChild, KillSignal, LocalMachine, LocalMachineSpec, MachineBox, MachineChild, MachineSpawn, MachineTail } from "./machine.js";
export { BoxError } from "./box.js";
export type { Box, BoxedChild, BoxErrorCode, BoxRecord, BoxRecorder, BoxSpec, Isolation, Reaped } from "./box.js";
export { boxSlot } from "./box-slot.js";
export type { BoxSlot, BoxSlotState, BoxStart, SlotChild } from "./box-slot.js";
