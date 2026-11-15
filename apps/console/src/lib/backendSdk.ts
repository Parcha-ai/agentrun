export type BackendSdkRuntime = 'claude-agent-sdk' | 'codex-sdk';

/** Execution stays in the application's SDK. The public binding holds no credentials or source-machine paths. */
export function backendSdkOf(value: unknown): { runtime: BackendSdkRuntime } | undefined {
  const sdk = value && typeof value === 'object' ? (value as { sdk?: { runtime?: unknown } }).sdk : undefined;
  return sdk?.runtime === 'claude-agent-sdk' || sdk?.runtime === 'codex-sdk' ? { runtime: sdk.runtime } : undefined;
}

export const backendSdkLabel = (runtime: BackendSdkRuntime) => runtime === 'claude-agent-sdk' ? 'Claude Agent SDK' : 'Codex SDK';
