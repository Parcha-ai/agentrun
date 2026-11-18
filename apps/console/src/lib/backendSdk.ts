export const BACKEND_SDK_RUNTIMES = ['claude-agent-sdk', 'codex-sdk', 'openclaw', 'capy', 'openai-agents-sdk', 'langgraph'] as const;
export type BackendSdkRuntime = (typeof BACKEND_SDK_RUNTIMES)[number];

/** Execution stays in the application's SDK. The public binding holds no credentials or source-machine paths. */
export function backendSdkOf(value: unknown): { runtime: BackendSdkRuntime } | undefined {
  const sdk = value && typeof value === 'object' ? (value as { sdk?: { runtime?: unknown } }).sdk : undefined;
  return (BACKEND_SDK_RUNTIMES as readonly unknown[]).includes(sdk?.runtime) ? { runtime: sdk!.runtime as BackendSdkRuntime } : undefined;
}

const LABELS: Record<BackendSdkRuntime, string> = { 'claude-agent-sdk': 'Claude Agent SDK', 'codex-sdk': 'Codex SDK', openclaw: 'OpenClaw', capy: 'Capy', 'openai-agents-sdk': 'OpenAI Agents SDK', langgraph: 'LangGraph' };
export const backendSdkLabel = (runtime: BackendSdkRuntime) => LABELS[runtime];
