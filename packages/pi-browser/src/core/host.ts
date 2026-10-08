// What a host gives the package and what it gets back: the provider interface, the per-conversation configuration,
// the session records custody commits, and the rows it reports. Nothing here carries a secret: every value of these
// types may be committed, logged or shown.
import type { LeaseRef, LeaseState, ResourceStatus } from "./lease.js";
import type { PriceState, ToolUsage } from "./usage.js";

export type Geo = { country: string; state?: string; city?: string };

/** Written by the host in the conversation's creating commit. */
export type BrowserConfig = {
  /** The host's name for the conversation's work (agentrun: the node label); names evidence directories. */
  label: string;
  /** The run id, part of every session tag. */
  run: string;
  policy: BrowserPolicy;
};

export type BrowserPolicy = {
  proxies: boolean;
  verified: boolean;
  captcha: boolean;
  geolocation: Geo | null;
  region: string | null;
  /** A raw provider context id; naming contexts is the host's business. */
  contextId: string | null;
  sessionTimeoutS: number;
  idleReleaseS: number;
  batchTimeoutMs: number;
  navigation?: { allow?: string[]; block?: string[] };
  /** Observe what each session sends, and what a request the judge calls irreversible, or cannot judge, meets: sent,
   *  refused, or the host's answer. Absent: no observer, and a cut run's effect is unknown. */
  actions?: "allow" | "deny" | "ask";
};

export type SessionSpec = {
  tag: string;
  maxLifetimeS: number;
  idleTimeoutS: number;
  proxies: boolean | { geolocation: Geo };
  verified: boolean;
  captcha: boolean;
  region?: string;
  viewport: { width: number; height: number };
  contextId?: string;
  navigation?: { allow?: string[]; block?: string[] };
  /** Stamped on the provider's session (Browserbase `userMetadata`), the tag among them. */
  metadata: Record<string, string>;
};

/** What the driver is given, and what the process dials: a provider may hand the driver one URL and have the process
 *  dial another (a credential proxy, a broker relay). Held in memory only. */
export type AttachTarget = { sdkCdpUrl: string; dial?: { url: string; headers?: Record<string, string> }; extensionId?: string };

export type ProviderCaps = {
  timeoutModel: "wall-clock" | "inactivity";
  maxLifetimeS: number;
  /** Whether a session outlives the client's disconnect, so a new process can reattach to it. */
  survivesDisconnect: boolean;
  releaseIsAsync: boolean;
  extension: "uploaded-per-launch" | "preinstalled" | "loaded-locally";
};

export type LiveView = { fullscreen: string | null; framed: string | null; pages: Array<{ id: string | null; url: string | null; title: string | null; fullscreen: string | null }> };
export type Recording = { id: string; startedAt: string | null; durationS: number | null };
export type RemoteFile = { name: string; sizeBytes: number; modifiedAt: string | null };

export type FetchRequest = { url: string; format: "markdown" | "raw"; proxies: boolean };
export type FetchResult = { finalUrl: string | null; statusCode: number | null; contentType: string | null; content: string; /** What the call cost, when the provider knows its plan. */ usage?: ToolUsage };
export type SearchRequest = { query: string; n: number };
export type SearchResult = { results: Array<{ url: string; title: string | null; author?: string | null; published?: string | null }>; /** What the call cost, when the provider knows its plan. */ usage?: ToolUsage };

export interface BrowserProvider {
  readonly name: string;
  readonly caps: ProviderCaps;
  /** At most once: SDK retries off, and `spec.tag` stamped on the provider's side so `findByTag` finds a session whose
   *  create answer was lost. */
  create(spec: SessionSpec, signal: AbortSignal): Promise<LeaseRef>;
  /** Every live session carrying `tag`. */
  findByTag(tag: string, signal?: AbortSignal): Promise<LeaseRef[]>;
  status(ref: LeaseRef, signal?: AbortSignal): Promise<ResourceStatus>;
  /** What the driver is given; held in memory, never committed. */
  attach(ref: LeaseRef, signal?: AbortSignal): Promise<AttachTarget>;
  /** Idempotent; a session already gone counts as released. */
  release(ref: LeaseRef, signal?: AbortSignal): Promise<void>;
  /** The host channel only (`onSession`); never in a result, a document or a log. */
  liveView?(ref: LeaseRef): Promise<LiveView | null>;
  recordings?: { list(ref: LeaseRef): Promise<Recording[]>; open(ref: LeaseRef, id: string): Promise<ReadableStream<Uint8Array>> };
  downloads?: { list(ref: LeaseRef): Promise<RemoteFile[]>; read(ref: LeaseRef, name: string, maxBytes: number): Promise<AsyncIterable<Uint8Array>> };
  fetch?(request: FetchRequest, signal?: AbortSignal): Promise<FetchResult>;
  search?(request: SearchRequest, signal?: AbortSignal): Promise<SearchResult>;
}

export type ReleaseReason = "tool" | "idle" | "relaunch" | "close" | "ended" | "lost" | "create_failed";

/** One browser session of one conversation, as custody commits it. */
export type SessionRecord = {
  tag: string;
  state: LeaseState;
  /** The provider's session id, once a create answered or a reconcile bound the tag. */
  resourceId: string | null;
  createdAt: string;
  endedAt: string | null;
  releaseReason: ReleaseReason | null;
  plane: string;
  provider: string;
  settings: { proxies: boolean; verified: boolean; geolocation: Geo | null; region: string | null; contextId: string | null };
  /** Every page the session moved to, in order; the last 500 kept. */
  navigation: Array<{ at: string; url: string }>;
  lastUrl: string | null;
  /** A `run` dispatched and not yet answered: what the model is told after a crash cut it. */
  pendingEffect: PendingEffect | null;
  spent: { seconds: number; usd: number; chargedThrough: string; /** Set by the release's charge: nothing is charged after it. */ final?: true;
    /** The price state of its charges (the session meter): an unpriced or invalid price records seconds and no dollars, which
     *  a cost view shows as unknown, never $0. Absent on a record charged before it was written. */
    state?: PriceState;
    /** The bill's sub-picodollar remainder (milliseconds x picodollars an hour, below 3,600,000), carried to the next
     *  charge: one rate's total is exact however many calls it was charged in. Absent when there is none. */
    carry?: number };
};

/** A request a `run` sent that can change something, as journaled while the run executes: method, origin, path, and
 *  the hold's decision when it was held. Never a body, a header or a query value. */
export type SentEffect = { requestId: string; method: string; origin: string; path: string; at: string; held: "pending" | "allowed" | "denied" | null; irreversible: number | null };
/** A `run` dispatched and not yet answered; `observed` when a holding observer journaled what it sent, each request
 *  committed before it could leave the browser. */
export type PendingEffect = { callId: string; codeSha: string; url: string | null; at: string; observed?: boolean; sent?: SentEffect[] };

/** The conversation's custody document. */
export type SessionsState = {
  /** Index into `sessions` of each plane's current session. */
  current: Record<string, number | null>;
  /** Every session this conversation opened, in order. */
  sessions: SessionRecord[];
  /** Told to the model on its next browser call, then cleared. */
  notice: string | null;
};

/** The run-wide inventory, one row per tag, so run open finds every session of every conversation. */
export type InventoryRow = { tag: string; conversationId: number; plane: string; provider: string; resourceId: string | null; state: SessionRecord["state"] };

/** What the host's channel receives on `onSession`. `label` is the conversation's configured label, so a row emitted by
 *  a release resumed after a restart still names the work it belonged to. */
export type SessionRow = { conversationId: number; label: string; session: SessionRecord; liveView: LiveView | null };
export type SessionChange = "launched" | "updated" | "released";

/** Why the effect observer could not attach, as a code and never as text: an attach error's message can hold the
 *  endpoint it dialed (a connect URL carries its token) or text the browser sent, so nothing of it leaves the package.
 *  attach_refused: the socket never opened. cdp_closed: it closed while the observer was setting up. cdp_error: the
 *  browser answered a setup command with an error. attach_failed: anything else. */
export type ObserverFailure = "attach_refused" | "cdp_closed" | "cdp_error" | "attach_failed";

/** What the host's channel receives on `onObserver`: a session whose conversation asked for the effect observer (its
 *  action policy is set) runs without it because it could not attach. Under `allow` the run goes on, so a crash during a
 *  `run` leaves its effect unknown; under `deny` and `ask` the call fails instead, and no row is sent. Once per attach.
 *  Scalars only, and no free text: `code` says why (see `ObserverFailure`). */
export type ObserverRow = { conversationId: number; label: string; tag: string; session_id: string; policy: "allow"; code: ObserverFailure };

/** What a run-open reconcile did, by tag: released (the conversation is done), kept (it continues on the same session),
 *  lost (the provider had ended it, or its create never landed), unreachable (the provider did not answer; left as is). */
export type ReconcileReport = { released: string[]; kept: string[]; lost: string[]; unreachable: string[] };

/** List prices by default; a host that knows its plan sets its own. A null price records the quantity unpriced. */
export type PriceTable = { sessionUsdPerHour: number | null; sessionMinimumS: number; fetchUsd: number; fetchProxiedUsd: number; searchUsd: number };

/** Browserbase list prices, read 2026-10-06 (session time at the Developer overage rate, one-minute minimum). */
export const LIST_PRICES: PriceTable = Object.freeze({ sessionUsdPerHour: 0.12, sessionMinimumS: 60, fetchUsd: 0.001, fetchProxiedUsd: 0.004, searchUsd: 0.007 });
