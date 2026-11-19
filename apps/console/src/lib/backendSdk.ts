export type BackendSdkRuntime = 'claude-agent-sdk' | 'codex-sdk' | 'eve';

/** Execution stays in the application's SDK. The public binding holds no credentials or source-machine paths. */
export function backendSdkOf(value: unknown): { runtime: BackendSdkRuntime } | undefined {
  const sdk = value && typeof value === 'object' ? (value as { sdk?: { runtime?: unknown } }).sdk : undefined;
  return sdk?.runtime === 'claude-agent-sdk' || sdk?.runtime === 'codex-sdk' || sdk?.runtime === 'eve' ? { runtime: sdk.runtime } : undefined;
}

export const backendSdkLabel = (runtime: BackendSdkRuntime) => ({ 'claude-agent-sdk': 'Claude Agent SDK', 'codex-sdk': 'Codex SDK', eve: 'Vercel eve' })[runtime];
