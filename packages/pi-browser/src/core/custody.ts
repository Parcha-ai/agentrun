// Session custody, the host-neutral half: the port every session tool asks for its browser, the session record's
// state changes, the notices custody tells the model, and the two custody tools. The durable adapter implements the
// port on pi-durable documents and tasks; another host implements the same port on its own state.
import type { BrowserFailure } from "./failures.js";
import type { EffectObserver } from "./effects.js";
import type { AttachTarget, BrowserConfig, Geo, ReleaseReason, SentEffect, SessionRecord, SessionSpec, SessionsState } from "./host.js";
import { isLeaseTransition, type LeaseState } from "./lease.js";

/** What custody needs of a driver; the tools use the rest of it. */
export type BrowserDriver = { close(): Promise<void> };
/** How long custody waits on a driver's close: a Stagehand close after its connection dropped and was reconnected can
 *  wait forever, and the provider ends the session whether or not the close came back. */
export const DRIVER_CLOSE_MS = 5_000;
/** Close `driver`, failing quietly and giving up after DRIVER_CLOSE_MS. */
export async function closeDriver(driver: BrowserDriver): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([driver.close().catch(() => undefined), new Promise<void>((resolve) => { timer = setTimeout(resolve, DRIVER_CLOSE_MS); })]);
  clearTimeout(timer);
}
/** What a driver takes from the conversation's policy: `batchTimeoutMs` limits one run call's batch. */
export type DriverOptions = { batchTimeoutMs: number };
export type DriverFactory<D extends BrowserDriver = BrowserDriver> = (target: AttachTarget, signal?: AbortSignal, options?: DriverOptions) => Promise<D>;

/** A port operation that ends in a typed failure; the tool returns `failure` as its result. */
export class BrowserFailureError extends Error {
  override name = "BrowserFailureError";
  constructor(readonly failure: BrowserFailure) { super(failure.message); }
}

export type Overrides = { verified?: boolean; geolocation?: Geo | null };

export type AttachedSession<D> = {
  driver: D;
  tag: string;
  /** The provider's session id. */
  sessionId: string;
  record: SessionRecord;
  /** Custody's news for the model, told once: the session was kept or lost in an interruption. */
  notice: string | null;
  /** A `run` that was dispatched on this conversation and never answered: an interruption cut it. */
  interrupted: SessionRecord["pendingEffect"];
  /** Whether the provider records sessions, so a read can say where in the recording it happened. */
  recorded: boolean;
  /** The session's effect observer, when one could attach: it journals and holds what a `run` sends. */
  effects: Pick<EffectObserver, "record" | "flush" | "holding"> | null;
};

/** What a session tool may ask of custody, for one call. */
export interface CustodyPort<D extends BrowserDriver = BrowserDriver> {
  /** The conversation's live session, launched when there is none. A call rerun after an interruption runs only on the
   *  session it first ran on: when that one is gone, this fails with `session_replaced` and launches nothing. */
  session(): Promise<AttachedSession<D>>;
  /** Release the current session and launch one with `overrides`; a rerun finds the session it launched. */
  relaunch(overrides: Overrides): Promise<AttachedSession<D>>;
  /** Release the current session; none, or one already released, is not an error. */
  release(): Promise<{ released: boolean; sessionId: string | null }>;
  /** Commit that a `run` is about to dispatch, before it does. */
  dispatching(effect: { callId: string; codeSha: string; url: string | null; observed: boolean }): Promise<void>;
  /** Commit one request the dispatched `run` sent, as the observer journals it (again with its decision when held). */
  journal(row: SentEffect): Promise<void>;
  /** Clear the dispatched `run`: it answered, or the model has been told it was interrupted. */
  settle(): Promise<void>;
  /** Record a page the session moved to. */
  navigated(url: string): Promise<void>;
  /** Whether the provider reports the current session ended; when it did, custody records it so, and the next call
   *  opens a fresh one. */
  ended(): Promise<boolean>;
  /** The connection to the current session dropped while the provider still runs it (a closed CDP socket): custody lets
   *  the dead driver go, so the next `session()` reconnects to the same session, its pages and cookies kept. */
  dropped(): Promise<void>;
}

/** A tool's result. `details` reach the host's UI and wraps, never the model; `usage` is pi's, for the call's spend. */
export type ToolOutput = {
  content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
  isError?: boolean;
  details?: Record<string, unknown>;
  usage?: Record<string, unknown>;
};

export const NAVIGATION_CAP = 500;
export const VIEWPORT = Object.freeze({ width: 1288, height: 711 });

export const SESSION_REPLACED: BrowserFailure = {
  ok: false, code: "session_replaced", retryable: true, effect: "none",
  message: "The browser session this call was using ended in an interruption, so its page is gone. Navigate again with run, or take a snapshot, to continue in a fresh session.",
};

export const notices = {
  kept: (url: string | null) => `Your browser session survived an interruption and is still open${url ? ` on ${url}` : ""}. Take a snapshot before acting again.`,
  lost: (url: string | null) => `Your browser session ended during an interruption. The next browser call opens a fresh session with no cookies or page state${url ? `; the last page was ${url}` : ""}.`,
  ended: (url: string | null) => `Your previous browser session had ended (the provider closed it), so this call runs in a fresh session with no cookies or page state${url ? `; the last page was ${url}` : ""}.`,
  /** A release the model did not ask for, told on the call that opens the next session. */
  released: (reason: "idle" | "close", url: string | null, idleS: number) => `Your previous browser session was released ${reason === "idle" ? `after ${idleS} seconds without a browser call` : "when the host closed it"}, so this call runs in a fresh session that starts on a blank page with no cookies or page state${url ? `; the last page was ${url}, so navigate there again to continue` : ""}.`,
};

export function currentRecord(state: SessionsState | undefined, plane: string): SessionRecord | null {
  const index = state?.current[plane];
  return index === null || index === undefined ? null : state!.sessions[index] ?? null;
}

export function newSessionRecord(input: { plane: string; tag: string; provider: string; spec: SessionSpec; at: string }): SessionRecord {
  const { spec } = input;
  return {
    tag: input.tag, state: "creating", resourceId: null, createdAt: input.at, endedAt: null, releaseReason: null,
    plane: input.plane, provider: input.provider,
    settings: { proxies: spec.proxies !== false, verified: spec.verified, geolocation: typeof spec.proxies === "object" ? spec.proxies.geolocation : null, region: spec.region ?? null, contextId: spec.contextId ?? null },
    navigation: [], lastUrl: null, pendingEffect: null, spent: { seconds: 0, usd: 0, chargedThrough: input.at },
  };
}

/** Move `record` (a draft) to `next`, refusing any change the lease state machine does not allow. */
export function moveRecord(record: SessionRecord, next: { state: LeaseState; resourceId?: string; reason?: ReleaseReason; at: string }): void {
  if (record.state === next.state && next.resourceId === undefined) return;
  if (!isLeaseTransition(record.state, next.state)) throw new Error(`session ${record.tag}: ${record.state} cannot become ${next.state}`);
  record.state = next.state;
  if (next.resourceId !== undefined) record.resourceId = next.resourceId;
  if (next.reason !== undefined) record.releaseReason = next.reason;
  if (next.state === "released" || next.state === "lost") record.endedAt = next.at;
}

export function sessionSpec(config: BrowserConfig, tag: string, overrides: Overrides = {}): SessionSpec {
  const { policy } = config;
  const geolocation = overrides.geolocation === undefined ? policy.geolocation : overrides.geolocation;
  return {
    tag, maxLifetimeS: policy.sessionTimeoutS, idleTimeoutS: policy.idleReleaseS,
    proxies: !policy.proxies ? false : geolocation ? { geolocation } : true,
    verified: overrides.verified ?? policy.verified, captcha: policy.captcha,
    ...(policy.region ? { region: policy.region } : {}),
    viewport: { ...VIEWPORT },
    ...(policy.contextId ? { contextId: policy.contextId } : {}),
    ...(policy.navigation ? { navigation: policy.navigation } : {}),
    metadata: { run: config.run, label: config.label },
  };
}

/** What a relaunch may not ask of this run's policy, or null when it can go ahead. A place is reached through a proxy,
 *  so under a policy with proxies off a geolocation is refused before anything is released or created: the new session
 *  would browse from the provider's default place and the answer would not say so. */
export function relaunchRefusal(policy: BrowserConfig["policy"], overrides: Overrides): BrowserFailure | null {
  if (!overrides.geolocation || policy.proxies) return null;
  return { ok: false, code: "refused", retryable: false, effect: "none", message: "browser_relaunch: geolocation needs a proxy, and this run's browser policy has proxies off, so no session can browse from a chosen place. Nothing was relaunched and your session is unchanged; browser_relaunch can still change verified, with geolocation left out." };
}

/** A geolocation as providers take it: an ISO alpha-2 country, a US state abbreviation, a city in capitals; null when
 *  the country is not two letters. */
export function normalizeGeolocation(raw: unknown): Geo | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const country = String(r.country ?? "").trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(country)) return null;
  const out: Geo = { country };
  const state = String(r.state ?? "").trim().toUpperCase();
  if (/^[A-Z]{2}$/.test(state)) out.state = state;
  const city = String(r.city ?? "").trim().toUpperCase().replace(/[\s-]+/g, "_").replace(/[^A-Z_]/g, "");
  if (city) out.city = city;
  return out;
}

const text = (value: unknown, isError = false): ToolOutput => ({ content: [{ type: "text", text: JSON.stringify(value) }], ...(isError ? { isError } : {}) });
const failed = (error: unknown): ToolOutput => {
  if (error instanceof BrowserFailureError) return text(error.failure, true);
  throw error;
};

/** `browser_release` and `browser_relaunch`: custody verbs, nothing else. */
export const custodyTools = {
  async browser_release(_args: unknown, port: CustodyPort): Promise<ToolOutput> {
    try {
      const { released, sessionId } = await port.release();
      return text({ ok: true, released, session_id: sessionId, ...(sessionId === null ? { note: "no open browser session" } : {}) });
    } catch (error) { return failed(error); }
  },
  async browser_relaunch(args: { verified?: boolean; geolocation?: unknown }, port: CustodyPort): Promise<ToolOutput> {
    const geolocation = args.geolocation === undefined ? undefined : normalizeGeolocation(args.geolocation);
    if (geolocation === null) return text({ ok: false, code: "refused", retryable: false, effect: "none", message: 'browser_relaunch: geolocation needs a two-letter ISO country code (e.g. {country: "GB"}).' }, true);
    try {
      const { sessionId, record } = await port.relaunch({ verified: args.verified === true, ...(geolocation ? { geolocation } : {}) });
      return text({ ok: true, session: sessionId, verified: record.settings.verified, proxies: record.settings.proxies, geolocation: record.settings.geolocation });
    } catch (error) { return failed(error); }
  },
};
