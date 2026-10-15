// Nothing here carries a secret: every value of these types may be committed, logged or shown.
import type { LeaseRef, LeaseState, ResourceStatus } from "./lease.js";

export type PriceState = "priced" | "unpriced" | "invalid";
export type PiUsage = { input: 0; output: 0; cacheRead: 0; cacheWrite: 0; totalTokens: 0; cost: { input: 0; output: 0; cacheRead: 0; cacheWrite: 0; total: number } };
export type ToolUsage = { usage: PiUsage; state: PriceState };

export type Geo = { country: string; state?: string; city?: string };

export type BrowserConfig = {
  /** The host's name for the conversation's work; names evidence directories. */
  label: string;
  run: string;
  policy: BrowserPolicy;
};

export type BrowserPolicy = {
  proxies: boolean;
  verified: boolean;
  captcha: boolean;
  geolocation: Geo | null;
  region: string | null;
  contextId: string | null;
  sessionTimeoutS: number;
  idleReleaseS: number;
  batchTimeoutMs: number;
  navigation?: { allow?: string[]; block?: string[] };
  /** A request judged irreversible (or not judged) is sent, refused or put to the host. Absent: no observer. */
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
  metadata: Record<string, string>;
};

/** The driver may be handed one URL while the process dials another (a credential proxy, a broker relay). Held in
 *  memory only. */
export type AttachTarget = { sdkCdpUrl: string; dial?: { url: string; headers?: Record<string, string> }; extensionId?: string };

export type ProviderCaps = {
  timeoutModel: "wall-clock" | "inactivity";
  maxLifetimeS: number;
  survivesDisconnect: boolean;
  releaseIsAsync: boolean;
  extension: "uploaded-per-launch" | "preinstalled" | "loaded-locally";
  /** The session settings this provider applies; a setting left out is applied. */
  settings?: Partial<SessionSettingsSupport>;
};

export type SessionSettingsSupport = { proxies: boolean; verified: boolean; geolocation: boolean; region: boolean; context: boolean };

export type LiveView = { fullscreen: string | null; framed: string | null; pages: Array<{ id: string | null; url: string | null; title: string | null; fullscreen: string | null }> };
export type Recording = { id: string; startedAt: string | null; durationS: number | null };
export type RemoteFile = { name: string; sizeBytes: number; modifiedAt: string | null };

export type FetchRequest = { url: string; format: "markdown" | "raw"; proxies: boolean };
export type FetchResult = { finalUrl: string | null; statusCode: number | null; contentType: string | null; content: string; usage?: ToolUsage };
export type SearchRequest = { query: string; n: number };
export type SearchResult = { results: Array<{ url: string; title: string | null; author?: string | null; published?: string | null }>; usage?: ToolUsage };

export interface BrowserProvider {
  readonly name: string;
  readonly caps: ProviderCaps;
  /** At most once: SDK retries off, and `spec.tag` stamped provider-side so `findByTag` finds a session whose create
   *  answer was lost. */
  create(spec: SessionSpec, signal: AbortSignal): Promise<LeaseRef>;
  findByTag(tag: string, signal?: AbortSignal): Promise<LeaseRef[]>;
  status(ref: LeaseRef, signal?: AbortSignal): Promise<ResourceStatus>;
  /** Held in memory, never committed. */
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

/** A site use_website can open: configuration, never model input. */
export type SiteInfo = { site: string; title: string; description: string };
/** Runs one child agent that has the browser tools and no use_website, and answers its final text. The adapter supplies
 *  it: a pi session for the coding agent, a task-owned conversation for pi-durable. */
export type ChildRunner = (task: { site: string; requestId: string; prompt: string }, signal: AbortSignal) => Promise<string>;
/** Runs a granted site's task and reports it, idempotent by `requestId`: exactly one of `run` (a task started elsewhere)
 *  or `report` (the result). A port that runs the child itself uses `ctx.runChild`; a broker ignores it. */
export interface SiteRunPort {
  list(signal: AbortSignal): Promise<SiteInfo[]>;
  use(input: { site: string; requestId: string; instructions: string }, ctx: { signal: AbortSignal; runChild: ChildRunner }): Promise<{ run: { id: string; state: string } } | { report: string }>;
}

export type ReleaseReason = "tool" | "idle" | "relaunch" | "close" | "ended" | "lost" | "create_failed";

export type SessionRecord = {
  tag: string;
  state: LeaseState;
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
  pendingEffect: PendingEffect | null;
  spent: { seconds: number; usd: number; chargedThrough: string; /** Set by the release's charge: nothing is charged after it. */ final?: true;
    /** An unpriced or invalid price records seconds and no dollars, shown as unknown, never $0. */
    state?: PriceState;
    /** The sub-picodollar remainder carried to the next charge, so one rate's total is exact however many calls charged
     *  it. */
    carry?: number };
};

/** A request a `run` sent that can change something: method, origin, path, the hold's decision. Never a body, a header
 *  or a query value. */
export type SentEffect = { requestId: string; method: string; origin: string; path: string; at: string; held: "pending" | "allowed" | "denied" | null; irreversible: number | null };
/** A replay-unsafe page action's journal entry. `observed`: a holding observer committed each request before it left the
 *  browser; `watched`: an observer recorded the requests it sent, holding them or not. `incarnation`: the custody process that wrote it; an entry from an earlier one belongs to a resumed run.
 *  `after`: the conversation's newest entry when it was journaled, where a resumed run's look for its answer starts.
 *  `finished`: the action returned. `told` and `refused`: how far a cut has been answered. */
export type PendingEffect = {
  callId: string; codeSha: string; url: string | null; at: string; observed?: boolean; sent?: SentEffect[];
  watched?: boolean; incarnation?: string; after?: number; finished?: boolean; told?: boolean; refused?: boolean;
};
/** A cut action's facts, beside the notice in the call's `details.pendingEffect`. `sent` is null when no observer ran, so
 *  an unknown never reads as none. */
export type PendingEffectFacts = {
  callId: string; urlAtDispatch: string | null; urlNow: string; observed: boolean;
  sent: Array<{ method: string; url: string; held: SentEffect["held"] }> | null;
};

export type SessionsState = {
  /** Index into `sessions` of each plane's current session. */
  current: Record<string, number | null>;
  sessions: SessionRecord[];
  /** Told to the model on its next browser call, then cleared. */
  notice: string | null;
};

export type InventoryRow = { tag: string; conversationId: number; plane: string; provider: string; resourceId: string | null; state: SessionRecord["state"] };

export type SessionRow = { conversationId: number; label: string; session: SessionRecord; liveView: LiveView | null };
export type SessionChange = "launched" | "updated" | "released";

/** A code, never text: an attach error's message can hold the endpoint it dialed, whose URL carries a token.
 *  attach_refused: never opened; cdp_closed: closed in setup; cdp_error: a setup command failed. */
export type ObserverFailure = "attach_refused" | "cdp_closed" | "cdp_error" | "attach_failed";

/** Sent once per attach when the observer cannot attach under `allow` (`deny` and `ask` fail the call instead). Scalars
 *  only, no free text. */
export type ObserverRow = { conversationId: number; label: string; tag: string; session_id: string; policy: "allow"; code: ObserverFailure };

/** released: conversation done; kept: same session; lost: ended or never created; unreachable: left as is. */
export type ReconcileReport = { released: string[]; kept: string[]; lost: string[]; unreachable: string[] };

/** A null price records the quantity unpriced. */
export type PriceTable = { sessionUsdPerHour: number | null; sessionMinimumS: number; fetchUsd: number; fetchProxiedUsd: number; searchUsd: number };

/** Browserbase list prices as of 2026-10-06: the Developer overage rate, one-minute minimum. */
export const LIST_PRICES: PriceTable = Object.freeze({ sessionUsdPerHour: 0.12, sessionMinimumS: 60, fetchUsd: 0.001, fetchProxiedUsd: 0.004, searchUsd: 0.007 });
