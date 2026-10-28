// How an adapter uses a host's session vault (core/vault.ts): restore a kept sign-in when a session is created, before the driver attaches, and capture
// it when the session is released or a person hands it back. The state stays in memory and crosses only the host's port: nothing here logs a value, and
// a provider's context id is registered with the run's redactor the moment it is seen. A restore or capture that fails never fails the browser: the session
// starts signed out, or ends without a fresh capture, and a process warning says which, with no value in it.
import { randomBytes } from "node:crypto";
import { BrowserFailureError } from "./core/custody.js";
import { browserFailure } from "./core/failures.js";
import type { AttachTarget, BrowserProvider, SessionSpec } from "./core/host.js";
import type { LeaseRef } from "./core/lease.js";
import { MIN_REDACTED_VALUE_LENGTH } from "./core/redact.js";
import { keptFor, type DrivingGate } from "./core/driving.js";
import { clampSessionCookieAgeMs, coversEveryOrigin, vaultTarget, type SessionVaultPort, type VaultTarget } from "./core/vault.js";
import { captureCdpState, connectCdp, restoreCdpState } from "./providers/cdp-session.js";

export type VaultOptions = {
  /** Keeps a signed-in browser session for the host (encrypted, per-item keys). Absent: nothing is captured or restored. */
  sessionVault?: SessionVaultPort;
  /** The oldest a session cookie may be at restore. Absent, 24 h; above 24 h it is clamped to 24 h; zero or negative is refused when the extension is made. */
  sessionVaultMaxSessionCookieAgeMs?: number;
};

export type VaultRuntime = { port: SessionVaultPort; maxAgeMs: number; track(secret: string): void; warn(message: string): void; now(): Date; /** The newest capture attempt per vault key: an older one that is still reading when a newer one starts writes nothing. */ latest: Map<string, number>; attempts: { next: number }; /** How long a restore, and a capture, may take (20 s each); tests shorten them. */ restoreMs: number; captureMs: number };

/** `null` when the host gave no vault. A bad age cap throws here, so a host learns at setup. */
export function vaultRuntime(options: VaultOptions, track: (secret: string) => void, warn: (message: string) => void, now: () => Date = () => new Date(), limits: { restoreMs?: number; captureMs?: number } = {}): VaultRuntime | null {
  if (!options.sessionVault) return null;
  return { port: options.sessionVault, maxAgeMs: clampSessionCookieAgeMs(options.sessionVaultMaxSessionCookieAgeMs), track, warn, now, latest: new Map(), attempts: { next: 0 }, restoreMs: limits.restoreMs ?? RESTORE_MS, captureMs: limits.captureMs ?? CAPTURE_MS };
}

/** Waits, up to `ms`, for a person to stop driving a session: a capture reads only once they have handed back. True when the gate is free. */
export async function untilQuiet(gate: DrivingGate | null, ms = 5000): Promise<boolean> {
  const until = Date.now() + ms;
  while (gate && keptFor(gate) === "person_driving" && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 200));
  return !gate || keptFor(gate) !== "person_driving";
}

const kindOf = (error: unknown) => (error instanceof Error ? error.name : "Error");
const CAPTURE_MS = 20_000;
const RESTORE_MS = 20_000;
/** `work`'s value, or a TimeoutError once `ms` pass (`onTimeout` runs then, to stop what `work` is still doing). The work is never left holding a caller. */
async function within<T>(work: Promise<T>, ms: number, onTimeout: () => void = () => {}): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => { onTimeout(); reject(Object.assign(new Error("timed out"), { name: "TimeoutError" })); }, ms); })]);
  } finally { clearTimeout(timer); work.catch(() => undefined); }
}
const refused = (message: string) => new BrowserFailureError(browserFailure("refused", message));

/** A secret too short for the redactor to scrub is not used as one: the redactor ignores values under its minimum, so it would leak. */
function trackSecret(rt: VaultRuntime, secret: string, what: string): boolean {
  if (secret.length < MIN_REDACTED_VALUE_LENGTH) { rt.warn(`the session vault's ${what} is too short for the redactor to scrub, so it is not used`); return false; }
  rt.track(secret);
  return true;
}

/** `vaulted`: this session was created under the host's vault plan (a context kind asked the provider for a saved context or profile), so it may be captured; a session that
 *  started with no target cannot be given one later, because its provider holds no context for it. `fresh`: nothing was kept, so a new context was made and its id is
 *  given to the vault right after the create (a restart then still finds it). */
export type RestorePlan = {
  spec: SessionSpec; afterAttach: ((target: AttachTarget) => Promise<void>) | null; vaulted: boolean; fresh: boolean;
  /** Set when the vault may hold a saved sign-in this session did not take (the read failed, or what it holds could not be used here): this session is NOT captured, so it
   *  can never replace what is saved. The text is the warning given once at the first capture. */
  holdBack?: string;
};

const HELD_FAILED = "the vault could not be read at the start, so a saved sign-in may exist under this key and is left untouched: this session's sign-in is not captured";
const HELD_UNUSED = "the vault holds a saved sign-in this session could not use, and it is left untouched: this session's sign-in is not captured";

/** What the create does with the vault: the spec the provider is asked for (a kept context or profile for Browserbase and Kernel) and a step that runs after the
 *  browser is attached and before the driver is (a local Chrome's cookies and local storage). The record the adapter stores is made from the ORIGINAL spec, never this one. */
export async function planRestore(rt: VaultRuntime | null, target: VaultTarget | undefined, provider: BrowserProvider, spec: SessionSpec): Promise<RestorePlan> {
  const plain: RestorePlan = { spec, afterAttach: null, vaulted: false, fresh: false };
  if (!rt || !target) return plain;
  let checked: { sessionKey: string; origins: string[] };
  try { checked = vaultTarget(target); } catch (error) { throw refused(`browser vault: ${error instanceof Error ? error.message : "a bad target"}. No session was started.`); }
  const vault = provider.vault;
  if (!vault) { rt.warn("this browser provider cannot keep a session in a vault (a Chrome attached by endpoint is offered only when the host sets ownBrowser: true), so nothing was restored or will be captured"); return plain; }
  if (vault.kind === "context" && vault.contextIdsInClear) throw refused("browser vault: this provider writes its context ids to a clear file, so a vault cannot use it. Give it a profile store that keeps ids in memory (memoryProfileStore). No session was started.");
  // A vault that stops answering never holds the session back: it starts signed out.
  let kept = null as Awaited<ReturnType<SessionVaultPort["restore"]>>;
  let holdBack: string | undefined;
  try { kept = await within(Promise.resolve().then(() => rt.port.restore(checked)), rt.restoreMs); } catch (error) { holdBack = HELD_FAILED; rt.warn(`the session vault could not restore (${kindOf(error)}); the session starts signed out`); }
  if (vault.kind === "context") {
    if (kept && (kept.kind !== "provider-context" || kept.provider !== vault.provider)) { rt.warn(`the vault holds a ${kept.kind} state this ${vault.provider} provider cannot use; it was ignored`); kept = null; holdBack = HELD_UNUSED; }
    // A context is a whole browser profile: it comes back only for a request that covers every origin it was saved for, never for some of them.
    if (kept?.kind === "provider-context" && !coversEveryOrigin(checked.origins, kept.origins)) { rt.warn("the vault holds a context whose saved origins this request does not cover every origin of (or records none); it was not restored"); kept = null; holdBack = HELD_UNUSED; }
    if (kept?.kind === "provider-context" && !trackSecret(rt, kept.contextId, "context id")) { kept = null; holdBack = HELD_UNUSED; }
    if (kept?.kind === "provider-context") return { spec: vault.provider === "browserbase" ? { ...spec, contextId: kept.contextId, profile: undefined } : { ...spec, profile: { name: kept.contextId, save: true } }, afterAttach: null, vaulted: true, fresh: false };
    // A saved sign-in may exist that this session did not take: nothing persists for it, and it is never captured.
    if (holdBack) return { spec, afterAttach: null, vaulted: true, fresh: false, holdBack };
    // Nothing kept: a context that persists is made for this session, its id held in memory and given to the vault right after the create.
    return { spec: { ...spec, contextId: undefined, profile: { name: `vault-${randomBytes(9).toString("hex")}`, save: true } }, afterAttach: null, vaulted: true, fresh: true };
  }
  if (!kept) return { ...plain, vaulted: true, ...(holdBack ? { holdBack } : {}) };
  if (kept.kind !== "cdp") { rt.warn(`the vault holds a ${kept.kind} state a local Chrome cannot use; it was ignored`); return { ...plain, vaulted: true, holdBack: HELD_UNUSED }; }
  return {
    spec,
    vaulted: true,
    fresh: false,
    afterAttach: async (attached) => {
      let link: Awaited<ReturnType<typeof connectCdp>> | undefined;
      try {
        await within((async () => {
          link = await connectCdp(attached.sdkCdpUrl);
          const counts = await restoreCdpState(link, kept, checked.origins, rt.now(), rt.maxAgeMs);
          rt.warn(`the session vault restored ${counts.cookies} cookies and ${counts.origins} origins of local storage (dropped: ${counts.droppedExpired} expired, ${counts.droppedAged} aged, ${counts.droppedOutside} outside the origins)`);
        })(), rt.restoreMs, () => link?.close());
      } catch (error) {
        // Cookies are written before local storage, so a failure part-way leaves what was written: the session may be signed in only in part.
        rt.warn(`the session vault restore failed (${kindOf(error)}); the session may start signed out, or signed in only in part`);
      } finally { link?.close(); }
    },
  };
}

export type CaptureOptions = {
  /** Whether the session was created under the vault plan (RestorePlan.vaulted). A context kind session that was not cannot be captured. */
  vaulted: boolean;
  /** The session's driving gate, read when the capture runs: a person who begins driving while the browser is being read voids that read. */
  gate?: () => DrivingGate | null;
  /** RestorePlan.holdBack: a saved sign-in may exist that this session did not take, so it is never captured; the text is warned once. */
  holdBack?: string;
};

/** A capture of one session, to run while its browser still exists. Never throws: a failure is a warning. Bounded in time from its first step: the target, the
 *  browser's DevTools socket and the host's port all sit inside the deadline, and when it passes the socket is closed and nothing more is read or written.
 *  `target` is read AT THE CAPTURE, so a host that learns the site and its origins mid-run (the person is asked to sign in first) is captured under what it set
 *  last; a target that reads as absent means the host no longer wants this session kept, and nothing is captured. */
export function captureFor(rt: VaultRuntime, target: VaultTarget | undefined | (() => Promise<VaultTarget | undefined> | VaultTarget | undefined), provider: BrowserProvider, ref: LeaseRef, options: CaptureOptions = { vaulted: true }): () => Promise<void> {
  let warnedLate = false;
  return async () => {
    const vault = provider.vault;
    if (!vault) return;
    if (options.holdBack) { if (!warnedLate) { warnedLate = true; rt.warn(options.holdBack); } return; }
    if (vault.kind === "context" && !options.vaulted) {
      if (!warnedLate) { warnedLate = true; rt.warn("this session started with no vault target, so its provider holds no saved context for it: its sign-in cannot be kept. Set the target before the session starts"); }
      return;
    }
    const stop = new AbortController();
    let link: Awaited<ReturnType<typeof connectCdp>> | undefined;
    // Numbered when it starts: an older capture that is still reading when a newer one of the same key begins writes nothing.
    const attempt = ++rt.attempts.next;
    const work = (async () => {
      const wanted = typeof target === "function" ? await target() : target;
      if (!wanted) return;
      const checked = vaultTarget(wanted);
      const key = checked.sessionKey;
      if ((rt.latest.get(key) ?? 0) < attempt) rt.latest.set(key, attempt);
      const capturedAt = rt.now();
      let state: Parameters<SessionVaultPort["capture"]>[0]["state"];
      if (vault.kind === "context") {
        const id = vault.contextOf(ref);
        if (!id) { rt.warn("this provider no longer knows the context this session runs on (the run restarted), so its sign-in was not captured; the context the vault holds stands"); return; }
        if (!trackSecret(rt, id, "context id")) return;
        state = { kind: "provider-context", capturedAt: capturedAt.toISOString(), provider: vault.provider, contextId: id, origins: [...checked.origins] };
      } else {
        const gate = options.gate?.() ?? null;
        let interrupted = false;
        const off = gate?.onChange((now) => { if (now === "person") interrupted = true; });
        try {
          const attached = await provider.attach(ref, stop.signal);
          link = await connectCdp(attached.sdkCdpUrl);
          if (stop.signal.aborted) { link.close(); return; }
          state = await captureCdpState(link, checked.origins, capturedAt);
        } finally { off?.(); }
        if (interrupted || (gate && keptFor(gate) === "person_driving")) { rt.warn("a person began driving while the session was being read, so that capture was discarded; the last capture stands"); return; }
      }
      // Nothing is written once the deadline has passed or a newer capture of this key has begun: an older read never replaces a newer one.
      if (stop.signal.aborted || rt.latest.get(key) !== attempt) return;
      await rt.port.capture({ ...checked, state });
    })();
    try {
      await within(work, rt.captureMs, () => { stop.abort(); link?.close(); });
    } catch (error) { rt.warn(`the session vault could not capture this session (${kindOf(error)}); the last capture stands`); } finally { link?.close(); }
  };
}
