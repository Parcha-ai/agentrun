/** Installed native CLIs are source-owned execution protocols, separate from the managed harness registry.
 * Their public connection identifiers stay stable; only this table maps them to executable and selector facts. */
export const NATIVE_RUNTIME_FACTS = Object.freeze({
  "claude-code": Object.freeze({
    binary: "claude", label: "Claude Code CLI", minimumVersion: "2.1.322", namedSelector: "agent",
    protocol: "claude-json", authStatus: Object.freeze(["auth", "status", "--json"]),
    authStatusJson: true, loginCommand: "claude auth login",
  } as const),
  codex: Object.freeze({
    binary: "codex", label: "Codex CLI", minimumVersion: "0.167.2", namedSelector: "profile",
    protocol: "codex-json", authStatus: Object.freeze(["login", "status"]),
    authStatusJson: false, loginCommand: "codex login",
  } as const),
});

export type NativeRuntime = keyof typeof NATIVE_RUNTIME_FACTS;
export const NATIVE_RUNTIMES = Object.freeze(Object.keys(NATIVE_RUNTIME_FACTS) as NativeRuntime[]);
export const NATIVE_MINIMUM_VERSION: Readonly<Record<NativeRuntime, string>> = Object.freeze(
  Object.fromEntries(NATIVE_RUNTIMES.map(runtime => [runtime, NATIVE_RUNTIME_FACTS[runtime].minimumVersion])) as Record<NativeRuntime, string>,
);
export const isNativeRuntime = (value: unknown): value is NativeRuntime =>
  typeof value === "string" && Object.hasOwn(NATIVE_RUNTIME_FACTS, value);
