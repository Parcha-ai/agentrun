/** Installed native CLIs are source-owned execution protocols, separate from the managed harness registry.
 * Their public connection identifiers stay stable; this table owns executable, selector and observation facts. */
type ObservationProtocol = {
  readonly id: string;
  readonly activityEvents: Readonly<Record<string, "working" | "unknown">>;
  readonly usageEvents: readonly string[];
  readonly requireCacheUsage: boolean;
};

export const NATIVE_RUNTIME_FACTS = Object.freeze({
  "claude-code": Object.freeze({
    binary: "claude", label: "Claude Code CLI", minimumVersion: "2.1.322", namedSelector: "agent",
    protocol: "claude-json", authStatus: Object.freeze(["auth", "status", "--json"]),
    authStatusJson: true, loginCommand: "claude auth login",
    observation: Object.freeze({
      id: "claude",
      activityEvents: Object.freeze({
        user_prompt: "working", api_request: "working", tool_result: "working",
        "claude_code.user_prompt": "working", "claude_code.api_request": "working", "claude_code.tool_result": "working",
      }),
      usageEvents: Object.freeze(["api_request", "claude_code.api_request"]),
      requireCacheUsage: true,
    } as const satisfies ObservationProtocol),
  } as const),
  codex: Object.freeze({
    binary: "codex", label: "Codex CLI", minimumVersion: "0.167.2", namedSelector: "profile",
    protocol: "codex-json", authStatus: Object.freeze(["login", "status"]),
    authStatusJson: false, loginCommand: "codex login",
    observation: Object.freeze({
      id: "codex",
      activityEvents: Object.freeze({
        "codex.user_prompt": "working", "codex.api_request": "working", "codex.tool_result": "working",
        "codex.response_usage": "working", "codex.conversation_starts": "unknown",
      }),
      usageEvents: Object.freeze(["codex.response_usage"]),
      requireCacheUsage: false,
    } as const satisfies ObservationProtocol),
  } as const),
});

export type NativeRuntime = keyof typeof NATIVE_RUNTIME_FACTS;
export const NATIVE_RUNTIMES = Object.freeze(Object.keys(NATIVE_RUNTIME_FACTS) as NativeRuntime[]);
export const NATIVE_MINIMUM_VERSION: Readonly<Record<NativeRuntime, string>> = Object.freeze(
  Object.fromEntries(NATIVE_RUNTIMES.map(runtime => [runtime, NATIVE_RUNTIME_FACTS[runtime].minimumVersion])) as Record<NativeRuntime, string>,
);
export const isNativeRuntime = (value: unknown): value is NativeRuntime =>
  typeof value === "string" && Object.hasOwn(NATIVE_RUNTIME_FACTS, value);

/** Native telemetry names are wire identifiers, independent of the managed harness that would execute a run. */
export type NativeObservationHarness = (typeof NATIVE_RUNTIME_FACTS)[NativeRuntime]["observation"]["id"];
export const NATIVE_OBSERVATION_HARNESSES = Object.freeze(
  NATIVE_RUNTIMES.map(runtime => NATIVE_RUNTIME_FACTS[runtime].observation.id),
);
const OBSERVATION_PROTOCOLS: Readonly<Record<string, ObservationProtocol>> = Object.freeze(
  Object.fromEntries(NATIVE_RUNTIMES.map(runtime => {
    const protocol = NATIVE_RUNTIME_FACTS[runtime].observation;
    return [protocol.id, protocol];
  })),
);
export const nativeObservationProtocol = (value: unknown): ObservationProtocol | undefined =>
  typeof value === "string" && Object.hasOwn(OBSERVATION_PROTOCOLS, value) ? OBSERVATION_PROTOCOLS[value] : undefined;
