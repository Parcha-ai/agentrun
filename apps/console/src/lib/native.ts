import type { components, operations } from "./api.generated";

/** Redacted public metadata. Native credentials and configuration stay on the source machine. */
export type NativeTarget = operations["discoverNative"]["answer"]["targets"][number];
export type NativeBinding = NonNullable<operations["getNative"]["answer"]["native"]>;
export type NativeRuntime = NativeTarget["runtime"];
export type NativeSelector = NativeTarget["selector"];
export type NativeRunMetadata = NonNullable<components["Run"]["native"]>;
export type NativeUsage = NativeRunMetadata["usage"]["reflection"][number];

export const nativeRuntimeLabel = (runtime: string) => runtime === "claude-code" ? "Claude Code" : runtime === "codex" ? "Codex" : runtime;
export const nativeSelectorLabel = (selector: NativeSelector) => selector.kind === "project" ? "Project default" : `${selector.kind === "profile" ? "Profile" : "Named agent"}: ${selector.name}`;
/** A transport reference, not source configuration or credentials. Older local-only servers omit it. */
export function nativeRemoteSource(binding: NativeBinding | undefined) {
  const remote = binding && "remote" in binding ? binding.remote : undefined;
  if (!remote || typeof remote !== "object" || !("connector_id" in remote) || !("target_id" in remote)) return undefined;
  return typeof remote.connector_id === "string" && typeof remote.target_id === "string" ? { connector_id: remote.connector_id, target_id: remote.target_id } : undefined;
}
/** Derived status belongs beside the definition. A stale remote binding alone cannot prove its worker is online. */
export function nativeReadinessOf(agent: { definition: { native?: NativeBinding }; native_status?: NativeBinding } | undefined): NativeBinding | undefined {
  const binding = agent?.definition.native;
  if (!binding || !nativeRemoteSource(binding)) return binding;
  return agent?.native_status ?? { ...binding, state: "needs_verification", capabilities: { ...binding.capabilities, launch: false }, issues: ["Check the remote worker's connection before running."] };
}
export function nativeStateLabel(target: NativeTarget | NativeBinding) {
  if ("connected" in target && !target.connected) return "Disconnected";
  return target.state === "ready" ? "Ready to run" : target.state === "needs_attention" ? "Needs attention" : "Needs verification";
}
