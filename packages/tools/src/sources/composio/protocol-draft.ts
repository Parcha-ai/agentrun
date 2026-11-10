// The tool-source protocol as the sprint's design states it (tools-protocol §2.2), copied here only until the protocol
// package (TP-01, `packages/tools/src/protocol.ts`) lands: this adapter then imports that one and this file goes. Nothing
// here is the adapter's own; change the design, not this copy.

export type ActionId = `${string}:${string}/${string}`;
export type Risk = { level: "read" | "write" | "destructive"; from: "source_hint" | "owner_mark" | "unknown" };
export type Price =
  | { kind: "metered"; usdPerCall: number | "quoted"; holdUsd: number }
  | { kind: "not_metered" }
  | { kind: "free" };
export type Replay = "safe" | "never" | "recoverable";
export type Custody =
  | { kind: "none" }
  | { kind: "sealed_key"; keyRef: string; boundTo: string }
  | { kind: "oauth"; holder: "local" | "provider"; connectionRef: string; boundTo: string };

export interface ActionSpec {
  id: ActionId;
  title: string;
  description: string;
  inputSchema: object;
  outputSchema?: object;
  risk: Risk;
  price: Price;
  replay: Replay;
  custody: Custody;
  resultMaxChars: number;
  grantable: true | { reason: string };
  version: string;
}
export interface Toolkit { id: `${string}:${string}`; label: string; actions: number | "unknown"; needsConnection: boolean }

export interface Credential { header(name: string, scheme?: "Bearer"): [string, string]; connection(): string }
export interface Ctx { signal: AbortSignal; fetch: typeof fetch; credential?: Credential; settings: Readonly<Record<string, string>> }
export interface CallCtx extends Ctx { callId: string; attempt: number; file(name: string, body: string | Uint8Array): Promise<string> }

export type RefusalCode = "key_refused" | "needs_connection" | "connection_expired" | "quota_exhausted"
  | "rate_limited" | "timeout" | "stopped" | "blocked_address" | "upstream_error" | "unsupported";
export interface CallOutcome {
  text: string;
  isError: boolean;
  images?: { mime: string; data: string }[];
  chargedUsd?: number | null;
  upstreamRef?: string;
  refusal?: RefusalCode;
}

export type Cap = true | { unsupported: string };
export interface ToolSource {
  id: string;
  label: string;
  caps: Record<"connect" | "quote" | "recover" | "triggers" | "search", Cap>;
  settings: { fields: { name: string; secret: boolean }[] };
  check(ctx: Ctx): Promise<{ state: "ok" | "refused" | "unknown"; words: string }>;
  toolkits(ctx: Ctx, query?: string): Promise<Toolkit[]>;
  actions(toolkit: Toolkit["id"], ctx: Ctx, only?: string[]): Promise<ActionSpec[]>;
  search?(query: string, ctx: Ctx): Promise<ActionSpec[]>;
  quote?(spec: ActionSpec, args: unknown, ctx: Ctx): Promise<number | undefined>;
  call(spec: ActionSpec, args: unknown, ctx: CallCtx): Promise<CallOutcome>;
  recover?(spec: ActionSpec, upstreamRef: string, ctx: CallCtx): Promise<CallOutcome | undefined>;
  connect?: {
    start(toolkit: string, ctx: Ctx): Promise<{ url: string; connectionRef: string; expiresAt: string }>;
    status(ref: string, ctx: Ctx): Promise<"pending" | "active" | "expired" | "revoked" | "failed">;
    revoke?(ref: string, ctx: Ctx): Promise<void>;
  };
  triggers?: unknown;
}
