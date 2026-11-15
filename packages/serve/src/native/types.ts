/** Native connections refer to the user's installed runtime; no configuration or credential is copied. */
import type { NativeRuntime } from "./runtimes.js";
export type { NativeRuntime } from "./runtimes.js";
export type NativeSelector = { kind: "project" | "agent" | "profile"; name?: string };
export type NativeTarget = {
  runtime: NativeRuntime;
  project: string;
  selector: NativeSelector;
  machine_id: string;
  version: string | null;
  model: string | null;
  fingerprint: string;
  configuration: { path: string; sha256: string }[];
  skills: string[];
  mcp_servers: string[];
  state: "needs_verification" | "needs_attention";
  issues: string[];
  capabilities: {
    launch: boolean;
    notes: boolean;
    skills: boolean;
    workflows: false;
    approval: "native" | "unavailable";
    usage: boolean;
  };
};
export type NativeBinding = Omit<NativeTarget, "state"> & {
  state: NativeTarget["state"] | "ready";
  connected: boolean;
  verified_at?: string;
  /** A source-approved target on an outbound-only connector, never a server-selected remote path. */
  remote?: { connector_id: string; target_id: string };
};
export type NativeUsage = {
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  cost_usd: number | null;
};
export type NativeEvent =
  | { type: "session"; sessionId: string }
  | { type: "text"; text: string }
  | { type: "tool"; id: string; name: string; input?: unknown; output?: unknown; status: "started" | "completed" | "failed" }
  | { type: "approval"; id: string; tool: string; input?: unknown }
  | { type: "usage"; usage: NativeUsage };
export type NativeResult = {
  sessionId: string;
  answer: string;
  model?: string;
  usage: NativeUsage;
  permission_denials?: string[];
};
export type NativeSendOptions = { signal?: AbortSignal; reflection?: boolean; timeoutMs?: number };
export type NativeSession = {
  send(prompt: string, options?: NativeSendOptions): Promise<NativeResult>;
  close(): Promise<void>;
};
