/** Execution stays with the caller. External platforms report through the same API without becoming a managed
 *  harness or acquiring a workflow bridge. Their platform is a display label, never a capability selector. */
export const SDK_RUNTIMES = ["claude-agent-sdk", "codex-sdk", "eve", "external"] as const;
export type SdkRuntime = (typeof SDK_RUNTIMES)[number];
export type SdkBinding =
  | { runtime: Exclude<SdkRuntime, "external">; platform?: never }
  | { runtime: "external"; platform: string };
/** Only these integrations supply a backend workflow bridge. */
export const SDK_WORKFLOW_RUNTIMES: readonly SdkRuntime[] = ["claude-agent-sdk", "codex-sdk", "eve"];
export const isSdkRuntime = (value: unknown): value is SdkRuntime =>
  typeof value === "string" && (SDK_RUNTIMES as readonly string[]).includes(value);

export const SDK_PLATFORM_MAX_LENGTH = 80;
// Unicode mode treats a surrogate pair as one character; the range rejects only a lone half. Keep the schema and
// runtime check identical, including the refusal to trim a label that participates in an agent's identity.
export const SDK_PLATFORM_PATTERN = "^(?!\\s)(?![\\s\\S]*\\s$)[^\\u0000-\\u001f\\u007f-\\u009f\\ud800-\\udfff]+$";
const platformPattern = new RegExp(SDK_PLATFORM_PATTERN, "u");
export const isSdkPlatform = (value: unknown): value is string =>
  typeof value === "string" && [...value].length <= SDK_PLATFORM_MAX_LENGTH && platformPattern.test(value);

/** Read just the source identity from a binding, start body or persisted launch. Callers check their own extra keys. */
export function sdkBindingOf(value: unknown): SdkBinding | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const { runtime, platform } = value as { runtime?: unknown; platform?: unknown };
  if (!isSdkRuntime(runtime)) return undefined;
  if (runtime === "external") return isSdkPlatform(platform) ? { runtime, platform } : undefined;
  return platform === undefined ? { runtime } : undefined;
}
