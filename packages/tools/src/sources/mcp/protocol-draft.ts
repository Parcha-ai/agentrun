// Stands in for ../../protocol.ts until the tools protocol package lands: the types below are the protocol's draft, copied
// as written, and every file of this adapter imports its protocol types from here alone, so the switch is one import path.
// The part after "Asks" is what the MCP adapter needs that the draft lacks, kept apart so the switch shows each one.

export type ActionId = `${string}:${string}/${string}`; // "<source>:<toolkit>/<action>"; built-ins stay bare
export type Risk = { level: "read" | "write" | "destructive"; from: "source_hint" | "owner_mark" | "unknown" };
export type Price =
  | { kind: "metered"; usdPerCall: number | "quoted"; holdUsd: number } // holdUsd: the most one call may cost
  | { kind: "not_metered" } // allowed, labelled on card and usage
  | { kind: "free" }; // a known $0
export type Replay = "safe" | "never" | "recoverable"; // recoverable = never resend, but recover()
export type Custody =
  | { kind: "none" }
  | { kind: "sealed_key"; keyRef: string; boundTo: string } // boundTo: the only origin it may be sent to
  | { kind: "oauth"; holder: "local" | "provider"; connectionRef: string; boundTo: string };

export interface ActionSpec {
  id: ActionId; title: string; description: string;
  inputSchema: object; outputSchema?: object;
  risk: Risk; price: Price; replay: Replay; custody: Custody;
  resultMaxChars: number;
  grantable: true | { reason: string }; // meta tools: never
  version: string; // a dated version, a snapshot hash, a quote time
}
export interface Toolkit { id: `${string}:${string}`; label: string; actions: number | "unknown"; needsConnection: boolean }

export interface Credential { header(name: string, scheme?: "Bearer"): [string, string]; connection(): string } // never readable as text
export interface Ctx { signal: AbortSignal; fetch: typeof fetch; credential?: Credential; settings: Readonly<Record<string, string>> }
export interface CallCtx extends Ctx { callId: string; attempt: number; file(name: string, body: string | Uint8Array): Promise<string> }

export type RefusalCode = "key_refused" | "needs_connection" | "connection_expired" | "quota_exhausted"
  | "rate_limited" | "timeout" | "stopped" | "blocked_address" | "upstream_error" | "unsupported";
export interface CallOutcome {
  text: string; isError: boolean; images?: { mime: string; data: string }[];
  chargedUsd?: number | null; // number: what the vendor says; null: may have charged, unknown; absent: charged nothing
  upstreamRef?: string; // recorded by the kernel so recover() can find the call
  refusal?: RefusalCode;
}

/** The trigger face a source may offer; delivery stays the trigger plane's. Opaque here: no MCP server has one. */
export type TriggerFace = unknown;

export interface ToolSource {
  id: string; label: string;
  caps: Record<"connect" | "quote" | "recover" | "triggers" | "search", true | { unsupported: string }>;
  settings: { fields: { name: string; secret: boolean }[] }; // what the owner saves (keys, base URL)
  check(ctx: Ctx): Promise<{ state: "ok" | "refused" | "unknown"; words: string }>; // must hit a free endpoint only
  toolkits(ctx: Ctx, query?: string): Promise<Toolkit[]>; // the console's catalog
  actions(toolkit: Toolkit["id"], ctx: Ctx, only?: string[]): Promise<ActionSpec[]>; // expansion pinned at save
  search?(query: string, ctx: Ctx): Promise<ActionSpec[]>; // when a toolkit cannot be listed whole
  quote?(spec: ActionSpec, args: unknown, ctx: Ctx): Promise<number | undefined>;
  call(spec: ActionSpec, args: unknown, ctx: CallCtx): Promise<CallOutcome>; // never throws
  recover?(spec: ActionSpec, upstreamRef: string, ctx: CallCtx): Promise<CallOutcome | undefined>;
  connect?: { start(toolkit: string, ctx: Ctx): Promise<{ url: string; connectionRef: string; expiresAt: string }>;
              status(ref: string, ctx: Ctx): Promise<"pending" | "active" | "expired" | "revoked" | "failed">;
              revoke?(ref: string, ctx: Ctx): Promise<void> };
  triggers?: TriggerFace;
}

// Asks: what the MCP adapter needs that the draft above lacks. Each is used by the adapter as written here; the protocol
// owner takes it into protocol.ts (or an equivalent), and this block goes.

/** Ask 1: a credential that can cut its own values out of a text without handing them over. The adapter scrubs what it
 *  read through header() while a call was out; a value it never read (a refresh token, a client secret, a token the
 *  kernel refreshed between two requests) only the credential knows. Optional: without it the adapter's own scrub stands. */
export interface ScrubbingCredential extends Credential { scrub?(text: string): string }

/** Ask 2: how the kernel's fetch says it refused an address unsent (a private network, a metadata address), so an adapter
 *  can answer `blocked_address` rather than `upstream_error`: it rejects with an error carrying this code (on the error
 *  or anywhere down its causes). */
export const ADDRESS_REFUSED = "blocked_address";

/** Ask 3: `Ctx.settings` is the settings of the toolkit a call is for, when a source's toolkits are each saved by the
 *  owner (an MCP server, a ContextForge virtual server): its URL, auth type and prices differ per toolkit. No type change;
 *  the kernel hands `actions`, `call` and `check` the toolkit's own settings. */
export type ToolkitSettings = Ctx["settings"];
