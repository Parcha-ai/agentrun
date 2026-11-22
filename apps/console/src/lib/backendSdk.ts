export const BACKEND_SDK_RUNTIMES = ['claude-agent-sdk', 'codex-sdk', 'eve', 'external'] as const;
export type BackendSdkRuntime = (typeof BACKEND_SDK_RUNTIMES)[number];
export type BackendSdkBinding =
  | { runtime: Exclude<BackendSdkRuntime, 'external'>; platform?: never }
  | { runtime: 'external'; platform: string };

/** Execution stays in the source application. A platform label is display data, never a managed harness name. */
export function backendSdkOf(value: unknown): BackendSdkBinding | undefined {
  const sdk = value && typeof value === 'object' ? (value as { sdk?: { runtime?: unknown; platform?: unknown } }).sdk : undefined;
  if (sdk?.runtime === 'external') {
    const platform = sdk.platform;
    // This reads public snapshots, not registration input. Redaction can expand a valid label beyond its input
    // limit; missing or malformed display metadata must never expose managed execution controls for external runs.
    return typeof platform === 'string' && platform.length > 0 && platform.trim() === platform
      && [...platform].length <= 80 && !/[\u0000-\u001f\u007f-\u009f\uD800-\uDFFF]/u.test(platform)
      ? { runtime: 'external', platform } : { runtime: 'external', platform: 'External platform' };
  }
  return sdk?.platform === undefined && (sdk?.runtime === 'claude-agent-sdk' || sdk?.runtime === 'codex-sdk' || sdk?.runtime === 'eve')
    ? { runtime: sdk.runtime } : undefined;
}

const LABELS = { 'claude-agent-sdk': 'Claude Agent SDK', 'codex-sdk': 'Codex SDK', eve: 'Vercel eve' };
export const backendSdkLabel = (sdk: BackendSdkBinding) => sdk.runtime === 'external' ? sdk.platform : LABELS[sdk.runtime];
