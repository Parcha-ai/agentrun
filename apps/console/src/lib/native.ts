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
export function nativeStateLabel(target: NativeTarget | NativeBinding) {
  if ("connected" in target && !target.connected) return "Disconnected";
  return target.state === "ready" ? "Ready to run" : target.state === "needs_attention" ? "Needs attention" : "Needs verification";
}

