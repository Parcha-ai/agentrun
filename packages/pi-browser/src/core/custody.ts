import { browserFailure, type BrowserFailure } from "./failures.js";
import type { EffectObserver } from "./effects.js";
import type { AttachTarget, BrowserConfig, BrowserProvider, Geo, HandoffOutcome, ProviderCaps, ReleaseReason, SentEffect, SessionRecord, SessionSpec, SessionsState } from "./host.js";
import { isLeaseTransition, type LeaseState } from "./lease.js";
import { startSpent } from "./usage.js";

export type BrowserDriver = { close(): Promise<void> };
/** A Stagehand close after a dropped and reconnected connection can hang forever; the provider ends the session anyway. */
export const DRIVER_CLOSE_MS = 5_000;
export async function closeDriver(driver: BrowserDriver): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([driver.close().catch(() => undefined), new Promise<void>((resolve) => { timer = setTimeout(resolve, DRIVER_CLOSE_MS); })]);
  clearTimeout(timer);
}
export type DriverOptions = { batchTimeoutMs: number };
export type DriverFactory<D extends BrowserDriver = BrowserDriver> = (target: AttachTarget, signal?: AbortSignal, options?: DriverOptions) => Promise<D>;

export class BrowserFailureError extends Error {
  override name = "BrowserFailureError";
  constructor(readonly failure: BrowserFailure) { super(failure.message); }
}

/** `verified: true` raises the run's Verified policy for one session; false or absent keeps the policy, which nothing
 *  here can lower. */
export type Overrides = { verified?: boolean; geolocation?: Geo | null };

export type AttachedSession<D> = {
  driver: D;
  tag: string;
  sessionId: string;
  record: SessionRecord;
  notice: string | null;
  /** The cut this call answers for: a journal entry an earlier custody process left without a committed answer. */
  interrupted: SessionRecord["pendingEffect"];
  /** Every cut in the journal chain, oldest first (`interrupted` is the one this call tells): a repeat of any is refused. */
  cuts?: Array<NonNullable<SessionRecord["pendingEffect"]>>;
  recorded: boolean;
  effects: Pick<EffectObserver, "record" | "flush" | "holding"> | null;
  downloads: BrowserProvider["downloads"] | null;
  fence: number;
  /** The session this one replaced after a release the model did not ask for (idle, close): by what and when (null while
   *  that release is in flight) and its last page. Present while this session has loaded no page. */
  replaced?: { reason: ReleaseReason; at: string | null; lastUrl: string | null } | null;
};

export interface CustodyPort<D extends BrowserDriver = BrowserDriver> {
  /** A call rerun after an interruption runs only on its first session, or fails with `session_replaced`. `signal` bounds
   *  this attach beside the call's own (a reconnect passes what is left of its budget). */
  session(signal?: AbortSignal): Promise<AttachedSession<D>>;
  /** A rerun finds the session it launched. */
  relaunch(overrides: Overrides): Promise<AttachedSession<D>>;
  /** No session, or one already released, is not an error. */
  /** `ended`: the session was released, or is being released, before this call: by what and when (null while in flight). */
  release(): Promise<{ released: boolean; sessionId: string | null; ended?: { reason: ReleaseReason; at: string | null } }>;
  /** The lease tag of the conversation's attached live session, or null: what `browser_release` and `browser_relaunch` are checked against (the live view's driving gate) before they act. */
  current?(): Promise<string | null>;
  /** Committed before a replay-unsafe action (`run`, `browser_upload`) is dispatched. */
  dispatching(effect: { callId: string; tool?: "run" | "browser_upload"; codeSha: string; url: string | null; observed: boolean; watched: boolean }): Promise<void>;
  journal(row: SentEffect): Promise<void>;
  /** A journal entry's next step, by its call: the action returned, its cut was told, or an identical action was refused. */
  mark(step: "finished" | "told" | "refused", callId: string, by?: string): Promise<void>;
  /** Clears the journal entry of that call only: another action's entry, journaled meanwhile, stays. */
  settle(callId: string): Promise<void>;
  navigated(url: string): Promise<void>;
  /** When the provider reports the session ended, custody records it and the next call opens a fresh one. */
  ended(): Promise<boolean>;
  /** The provider still runs the session: the next `session()` reconnects to it. */
  dropped(): Promise<void>;
  /** Hands the live session to a person: until `resume`, every call fails `waiting_for_human`. */
  hold(requestId: string): Promise<{ tag: string; sessionId: string }>;
  /** Gives a held session back; `notice` is told on the next call. */
  resume(notice: string | null): Promise<void>;
  /** The provider still runs the session but every reconnect within the budget failed: custody releases it as `lost` (so a
   *  stuck session stops billing) and tells the next call, which opens a fresh one. `kept`: a person holds or drives it, so
   *  it stays. */
  unreachable(): Promise<{ released: boolean; lastUrl: string | null; kept?: "held" | "viewing" | "person_driving" }>;
  /** Holds the session, asks the host's handoff port for a person, and waits for its answer; a rerun waits on the same
   *  request. */
  handoff(ask: { requestId: string; instruction: string; completionCondition: string }, signal?: AbortSignal): Promise<{ outcome: HandoffOutcome } | { refused: string }>;
}

/** `details` reach the host's UI and wraps, never the model; `usage` is pi's, for the call's spend. */
export type ToolOutput = {
  content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
  isError?: boolean;
  details?: Record<string, unknown>;
  usage?: Record<string, unknown>;
};

export const NAVIGATION_CAP = 500;
export const VIEWPORT = Object.freeze({ width: 1288, height: 711 });

export const SESSION_REPLACED: BrowserFailure = browserFailure("session_replaced", "The browser session this call was using ended in an interruption, so its page is gone. Navigate again with run, or take a snapshot, to continue in a fresh session.", { retryable: true });

export const waitingForHuman = (requestId: string): BrowserFailure =>
  browserFailure("waiting_for_human", `The browser is with a person right now (your handoff ${requestId}). Do not browse; wait for the handoff result.`);
export const HANDED_BACK: BrowserFailure = browserFailure("stale_snapshot", "A person used the browser while this call waited, so the page may have changed. Take a snapshot before acting again.", { retryable: true });
export const NO_HANDOFF: BrowserFailure = browserFailure("refused", "No person can be reached from this browser, so nothing was handed over.");
export const NOTHING_TO_HOLD: BrowserFailure = browserFailure("refused", "There is no open browser session to hand to a person. Open one with a browser call first.");

/** The fence a session is at in this process, and what a driver attached under an older one is told. */
export type FenceMark = { fence: number; failure: BrowserFailure };

/** A fenced driver's refusal: the call was made after the session moved past the driver's fence, so it never reached the page. */
export class FenceRefusal extends BrowserFailureError {}
const PASSED = Symbol("calls that passed the fence");
/** How many calls a fenced driver has let through; null for a driver that is not fenced. */
export const passedThrough = (driver: object): number | null => (driver as { [PASSED]?: number })[PASSED] ?? null;

export function fenced<D extends BrowserDriver>(driver: D, fence: number, mark: () => FenceMark | undefined): D {
  let passed = 0;
  return new Proxy(driver, {
    get(target, key) {
      if (key === PASSED) return passed;
      const value = Reflect.get(target, key);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const moved = mark();
        if (moved && moved.fence > fence) return Promise.reject(new FenceRefusal(moved.failure));
        passed += 1;
        return value.apply(target, args);
      };
    },
  });
}

export const backoffMs = (attempt: number) => Math.min(30_000, 500 * 2 ** attempt);

export const notices = {
  kept: (url: string | null) => `Your browser session survived an interruption and is still open${url ? ` on ${url}` : ""}. Take a snapshot before acting again.`,
  lost: (url: string | null) => `Your browser session ended during an interruption. The next browser call opens a fresh session with no cookies or page state${url ? `; the last page was ${url}` : ""}.`,
  ended: (url: string | null) => `Your previous browser session had ended (the provider closed it), so this call runs in a fresh session with no cookies or page state${url ? `; the last page was ${url}` : ""}.`,
  unreachable: (url: string | null) => `Your previous browser session could not be reconnected and was released, so this call runs in a fresh session with no cookies or page state${url ? `; the last page was ${url}, so navigate there again to continue` : ""}.`,
  handedBack: (outcome: HandoffOutcome, condition: string) => outcome === "done"
    ? `A person finished your handoff: verify on the page that ${condition} before acting.`
    : `Your handoff ended ${outcome} before the person finished it. Take a snapshot to see the page before acting.`,
  released: (reason: "idle" | "close", url: string | null, idleS: number) => `Your previous browser session was released ${reason === "idle" ? `after ${idleS} seconds without a browser call` : "when the host closed it"}, so this call runs in a fresh session that starts on a blank page with no cookies or page state${url ? `; the last page was ${url}, so navigate there again to continue` : ""}.`,
};

export function currentRecord(state: SessionsState | undefined, plane: string): SessionRecord | null {
  const index = state?.current[plane];
  return index === null || index === undefined ? null : state!.sessions[index] ?? null;
}

export function newSessionRecord(input: { plane: string; tag: string; provider: string; spec: SessionSpec; at: string; honours?: ProviderCaps["settings"] }): SessionRecord {
  const { spec, honours = {} } = input;
  const proxies = spec.proxies !== false && honours.proxies !== false;
  return {
    tag: input.tag, state: "creating", resourceId: null, createdAt: input.at, endedAt: null, releaseReason: null,
    plane: input.plane, provider: input.provider,
    settings: {
      proxies, verified: spec.verified && honours.verified !== false,
      geolocation: proxies && honours.geolocation !== false && typeof spec.proxies === "object" ? spec.proxies.geolocation : null,
      region: honours.region === false ? null : spec.region ?? null, contextId: honours.context === false ? null : spec.contextId ?? null, profile: spec.profile?.name ?? null,
    },
    navigation: [], lastUrl: null, pendingEffect: null, spent: startSpent(input.at),
  };
}

/** A session whose browser has loaded no page yet: nothing but about:blank was ever recorded for it (a run that loads no
 *  page records the blank page it is on). */
export const loadedNoPage = (record: SessionRecord): boolean =>
  (record.lastUrl === null || record.lastUrl === "about:blank") && record.navigation.every((step) => step.url === "about:blank");

export function moveRecord(record: SessionRecord, next: { state: LeaseState; resourceId?: string; reason?: ReleaseReason; at: string; handoff?: string }): void {
  if (record.state === next.state && next.resourceId === undefined) return;
  if (!isLeaseTransition(record.state, next.state)) throw new Error(`session ${record.tag}: ${record.state} cannot become ${next.state}`);
  if (next.state === "held" || (record.state === "held" && next.state === "live")) record.fence = (record.fence ?? 0) + 1;
  if (record.state === "held") delete record.handoff;
  if (next.handoff !== undefined) record.handoff = next.handoff;
  record.state = next.state;
  if (next.resourceId !== undefined) record.resourceId = next.resourceId;
  if (next.reason !== undefined) record.releaseReason = next.reason;
  if (next.state === "released" || next.state === "lost") record.endedAt = next.at;
}

export const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const refused = (message: string): BrowserFailure => ({ ok: false, code: "refused", retryable: false, effect: "none", message });

export function sessionSpec(config: BrowserConfig, tag: string, overrides: Overrides = {}): SessionSpec {
  const { policy } = config;
  if (policy.profile && !PROFILE_NAME.test(policy.profile.name)) throw new BrowserFailureError(refused("browser profile: a profile name is 1 to 64 characters of letters, digits, dot, underscore and dash, starting with a letter or digit. No session was started."));
  if (policy.profile && policy.contextId) throw new BrowserFailureError(refused("browser profile: a saved profile and a context id are two ways to ask for the same saved state; set one. No session was started."));
  const geolocation = overrides.geolocation === undefined ? policy.geolocation : overrides.geolocation;
  return {
    tag, maxLifetimeS: policy.sessionTimeoutS, idleTimeoutS: policy.idleReleaseS,
    proxies: !policy.proxies ? false : geolocation ? { geolocation } : true,
    verified: policy.verified || overrides.verified === true, captcha: policy.captcha,
    ...(policy.region ? { region: policy.region } : {}),
    viewport: { ...VIEWPORT },
    ...(policy.contextId ? { contextId: policy.contextId } : {}),
    ...(policy.profile ? { profile: { name: policy.profile.name, save: policy.profile.save } } : {}),
    ...(policy.navigation ? { navigation: policy.navigation } : {}),
    metadata: { run: config.run, label: config.label },
  };
}

export function profileRefusal(spec: SessionSpec, caps: ProviderCaps): BrowserFailure | null {
  return spec.profile && !caps.profiles ? refused(`browser profile: this browser provider cannot keep a saved sign-in, so profile "${spec.profile.name}" cannot be used. No session was started.`) : null;
}

/** With proxies off a geolocation is refused up front: the session would browse from the provider's default place,
 *  silently. */
/** browser_relaunch on a provider whose session the host assigned: nothing to relaunch onto, and nothing released. */
export const FIXED_SESSION_RELAUNCH: BrowserFailure = Object.freeze({ ok: false, code: "refused", retryable: false, effect: "none", message: "browser_relaunch: this task's browser is the one session its host assigned it, and there is no other to relaunch onto. Nothing was relaunched and your session is unchanged; keep using it." });

export function relaunchRefusal(policy: BrowserConfig["policy"], overrides: Overrides): BrowserFailure | null {
  if (!overrides.geolocation || policy.proxies) return null;
  return browserFailure("refused", "browser_relaunch: geolocation needs a proxy, and this run's browser policy has proxies off, so no session can browse from a chosen place. Nothing was relaunched and your session is unchanged; browser_relaunch can still change verified, with geolocation left out.");
}

/** The route's model fills every optional property with a blank, so an absent, null or all-blank object names no place. */
const unsetGeolocation = (raw: unknown): boolean =>
  raw === undefined || raw === null || (typeof raw === "object" && Object.values(raw as object).every((v) => v === undefined || v === null || (typeof v === "string" && v.trim() === "")));

/** An ISO alpha-2 country, a US state abbreviation, a city in capitals; null when the country is not two letters. */
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

const VERIFIED_KEPT = "This run's sessions are Verified, so the new one is too: a relaunch can ask for Verified with verified: true but never drop it.";
const text = (value: unknown, isError = false): ToolOutput => ({ content: [{ type: "text", text: JSON.stringify(value) }], ...(isError ? { isError } : {}) });
const failed = (error: unknown): ToolOutput => {
  if (error instanceof BrowserFailureError) return text(error.failure, true);
  throw error;
};

export const custodyTools = {
  async browser_release(_args: unknown, port: CustodyPort): Promise<ToolOutput> {
    try {
      const { released, sessionId, ended } = await port.release();
      const note = ended
        ? `The session was already ${ended.at ? `released (${ended.reason}, at ${ended.at})` : `being released (${ended.reason})`} before this call; there was nothing more to release.`
        : sessionId === null ? "no open browser session" : null;
      return text({ ok: true, released, session_id: sessionId, ...(ended ? { already_released: ended } : {}), ...(note ? { note } : {}) });
    } catch (error) { return failed(error); }
  },
  async browser_relaunch(args: { verified?: boolean; geolocation?: unknown }, port: CustodyPort): Promise<ToolOutput> {
    const geolocation = unsetGeolocation(args.geolocation) ? undefined : normalizeGeolocation(args.geolocation);
    if (geolocation === null) return text(browserFailure("refused", 'browser_relaunch: geolocation needs a two-letter ISO country code (e.g. {country: "GB"}).'), true);
    try {
      // The route's model fills every optional property, so a false is no instruction: only true is passed on.
      const { sessionId, record } = await port.relaunch({ ...(args.verified === true ? { verified: true } : {}), ...(geolocation ? { geolocation } : {}) });
      const kept = args.verified === false && record.settings.verified;
      return text({ ok: true, session: sessionId, verified: record.settings.verified, proxies: record.settings.proxies, geolocation: record.settings.geolocation, ...(kept ? { note: VERIFIED_KEPT } : {}) });
    } catch (error) { return failed(error); }
  },
  async browser_request_handoff(args: { request_id: string; instruction: string; completion_condition: string }, port: CustodyPort, call?: { signal?: AbortSignal }): Promise<ToolOutput> {
    try {
      const answer = await port.handoff({ requestId: args.request_id, instruction: args.instruction, completionCondition: args.completion_condition }, call?.signal);
      if ("refused" in answer) return text(browserFailure("refused", `No person could take the browser: ${answer.refused}. Your session is unchanged; go on without the handoff.`), true);
      const next = answer.outcome === "done" ? "Take a snapshot and verify the completion condition on the page before acting." : "The person did not finish. Take a snapshot to see the page before deciding what to do next.";
      return text({ ok: true, outcome: answer.outcome, completion_condition: args.completion_condition, next });
    } catch (error) { return failed(error); }
  },
};
