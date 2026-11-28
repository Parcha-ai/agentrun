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
    captureRuntime: "claude-code-cli",
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
    captureRuntime: "codex-cli",
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
export const NATIVE_CLAUDE_POLICY_UNRESOLVED = "Claude policy sources include settings or agent definitions whose effective selection could not be fully captured. Native tasks remain available; automatic learning is unavailable.";
export const NATIVE_CLAUDE_ADDITIONAL_POLICY_UNRESOLVED = "Claude policy sources may include additional instruction files or selection settings whose effective policy was not captured. Native tasks remain available; automatic learning is unavailable.";
export const NATIVE_RUNTIMES = Object.freeze(Object.keys(NATIVE_RUNTIME_FACTS) as NativeRuntime[]);
export const NATIVE_MINIMUM_VERSION: Readonly<Record<NativeRuntime, string>> = Object.freeze(
  Object.fromEntries(NATIVE_RUNTIMES.map(runtime => [runtime, NATIVE_RUNTIME_FACTS[runtime].minimumVersion])) as Record<NativeRuntime, string>,
);
export const isNativeRuntime = (value: unknown): value is NativeRuntime =>
  typeof value === "string" && Object.hasOwn(NATIVE_RUNTIME_FACTS, value);

/** Portable setup sources include runtimes without a native execution or observation bridge.
 * Profile locations and capture formats belong here; native admission still uses NATIVE_RUNTIME_FACTS. */
export const SOURCE_RUNTIME_FACTS = Object.freeze({
  "claude-code": Object.freeze({ ...NATIVE_RUNTIME_FACTS["claude-code"], homeEnvironment: "CLAUDE_CONFIG_DIR", homeOption: "claudeHome" } as const),
  codex: Object.freeze({ ...NATIVE_RUNTIME_FACTS.codex, homeEnvironment: "CODEX_HOME", homeOption: "codexHome" } as const),
  pi: Object.freeze({ binary: "pi", protocol: "pi-settings", namedSelector: null, homeEnvironment: "PI_CODING_AGENT_DIR", homeOption: "piHome" } as const),
});
export type SourceRuntime = keyof typeof SOURCE_RUNTIME_FACTS;
export type SourceRuntimeProtocol = (typeof SOURCE_RUNTIME_FACTS)[SourceRuntime]["protocol"];
export const SOURCE_RUNTIMES = Object.freeze(Object.keys(SOURCE_RUNTIME_FACTS) as SourceRuntime[]);
export const isSourceRuntime = (value: unknown): value is SourceRuntime =>
  typeof value === "string" && Object.hasOwn(SOURCE_RUNTIME_FACTS, value);
export const sourceRuntimeProtocol = (runtime: SourceRuntime): SourceRuntimeProtocol => SOURCE_RUNTIME_FACTS[runtime].protocol;

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
