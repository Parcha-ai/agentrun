// The browser tool's sessions on the computer protocol: pi-browser's BrowserProvider (what its custody drives) over a
// ClaimBrowser (workspace/resolve-computer.ts), a browser computer provider of the computer registry. One stack: the
// claim's, where the agent's computer is a browser, else one over the tool plane's vendor (planeBrowser), the same
// provider an agent's browser computer is, made with the run's tool keys. Every session is a browser computer made at
// the tool's call, under its tag and the run's labels, and driven over its CDP URL by pi-browser's raw-CDP driver
// (@parcha/pi-browser/driver/cdp), with nothing loaded into the browser. It lives in serve, the host of both, since
// pi-browser may not import the computer package (check-direction.mjs). Nothing here names a vendor.
//
// What the provider declares (capabilities().browser) says what a session is opened with (spec.browser): the viewport,
// stealth where custody asks a Verified session and the provider offers it, headless where it offers it, and the run's
// saved sign-in (`profile`, the vendor's object the agent's sign-in points to). Its CDP URL is the provider's connect,
// read again at each attach and held in memory for the driver and the live view alone. Where the provider keeps a
// session's downloads, the browser is told to save into the declared folder over one CDP socket per session, held open
// until the session is released (the setting lasts as long as that socket), and the downloads are read through the
// provider.
//
// The one-saver rule: within this process one session at a time saves to a saved sign-in (the vendors keep the last
// writer's state and none locks), and a session that saved is waited out for the provider's settle time (Browserbase
// writes its context back after the session ends) before the next may open on it. Custody builds a provider per call,
// so what a session holds (its socket, its saver's claim) is kept per process, by provider and session.
//
// Errors carry the provider's own words, which name no key, URL or pointer; a refusal (denied) carries status 403, so
// custody ends a create it refused at once.
import type { AttachTarget, BrowserProvider, LeaseRef, ProviderCaps, RemoteFile, ResourceStatus, SessionSpec } from "@parcha/pi-browser";
import { BrowserFailureError, browserFailure, cdpCall, type CdpSession } from "@parcha/pi-browser";
import { BROWSER_IMAGE, type BrowserSpec, type ComputerProvider, isBrowserProvider, PROVIDERS, providerFor, releaseOlder, runLabels } from "@parcha/agentrun-computer";
import { KEY_TABLE, providerOptions } from "./computer-keys.js";
import { claimBrowser } from "./workspace/computer-for-claim.js";
import type { ClaimBrowser } from "./workspace/resolve-computer.js";

/** Custody's own refusal of a second saver, in its words: no session was started. */
const ONE_SAVER = "one session at a time may save to this agent's saved sign-in, and another session is saving to it now. Wait for it to end, or start without saving. No session was started.";
const STILL_ENDING = "the session that was saving to this agent's saved sign-in is still ending. Try again in a moment. No session was started.";
const SAVER_WAIT_MS = 20_000;

/** What the adapter opens every session with, beside custody's spec. */
export interface BrowserComputerOptions {
  /** The run's saved sign-in: the vendor's object a session asking for the profile `name` opens on. */
  readonly signIn?: { readonly name: string; readonly pointer: string };
  /** A headless browser where the provider offers one. */
  readonly headless?: boolean;
  /** Where a server behind a browser gateway holds the sockets of Browserbase's connect hosts (BROWSERBASE_CONNECT_BASE_URL). */
  readonly connectBaseUrl?: string;
  readonly sleep?: (ms: number) => Promise<void>;
}

/** A failure custody reads: the provider's words, and a status where the code is one custody tells apart. */
function withStatus(error: unknown): unknown {
  const code = (error as { code?: unknown } | null)?.code;
  const status = code === "denied" ? 403 : code === "not_found" ? 404 : code === "limit" ? 429 : undefined;
  return status === undefined || typeof error !== "object" || error === null ? error : Object.assign(error, { status });
}
const statused = async <T>(work: Promise<T>): Promise<T> => {
  try {
    return await work;
  } catch (error) {
    throw withStatus(error);
  }
};
const goneCode = (error: unknown) => {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "gone" || code === "not_found";
};

/** What a session holds in this process, by provider and session id: its download-behaviour socket. */
const sockets = new Map<string, CdpSession>();
const opening = new Map<string, Promise<void>>();
/** Who saves to a saved sign-in now, by provider and pointer. */
type Saver = { tag: string; owner: string; running?: () => Promise<boolean>; settle?: () => Promise<void> };
const savers = new Map<string, Saver>();

const freeSaver = (tag: string) => {
  for (const [key, held] of savers) if (held.tag === tag) savers.delete(key);
};
const isSaver = (tag: string) => [...savers.values()].some((held) => held.tag === tag);

/** True when `work` ends within `ms`; false at the deadline. */
async function within(work: Promise<void>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([work.then(() => true), new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), Math.max(0, ms)); })]);
  } finally {
    clearTimeout(timer);
  }
}

/** The one-saver rule: a holder that no longer runs is replaced once its settle time is waited out; the same tag keeps it;
 *  the same owner's successor (a relaunch asks for its replacement while the old session is still being released) waits
 *  for the release; any other is refused. */
async function claimSaver(key: string, tag: string, owner: string, signal: AbortSignal | undefined, sleep: (ms: number) => Promise<void>): Promise<void> {
  for (const end = Date.now() + SAVER_WAIT_MS; ; ) {
    const held = savers.get(key);
    if (!held || held.tag === tag) return void savers.set(key, { tag, owner });
    const running = held.running ? await held.running().catch(() => true) : true;
    if (running) {
      if (held.owner !== owner) throw new BrowserFailureError(browserFailure("refused", `browser profile: ${ONE_SAVER}`));
      if (Date.now() > end) throw new BrowserFailureError(browserFailure("refused", `browser profile: ${STILL_ENDING}`));
      signal?.throwIfAborted();
      await sleep(100);
      continue;
    }
    if (held.settle && !(await within(held.settle(), end - Date.now()))) throw new BrowserFailureError(browserFailure("refused", `browser profile: ${STILL_ENDING}`));
    if (savers.get(key) === held) savers.delete(key);
    signal?.throwIfAborted();
    await sleep(0);
  }
}

/** pi-browser's provider over `computer`, a browser computer the claim or the plane opened. */
export function claimBrowserProvider(computer: ClaimBrowser, options: BrowserComputerOptions = {}): BrowserProvider {
  const features = computer.features;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const held = (id: string) => `${computer.provider}|${id}`;
  const caps: ProviderCaps = {
    profiles: features.profiles !== undefined && options.signIn !== undefined,
    // What a session is created with that its record may say: Verified where the provider offers stealth; no proxy,
    // place, region or context by id (serve's policy asks none).
    settings: { proxies: false, verified: features.stealth === true, geolocation: false, region: false, context: false },
  };

  const status = async (ref: LeaseRef, signal?: AbortSignal): Promise<ResourceStatus> => ((await statused(computer.running(ref.id, signal))) ? "running" : "gone");
  const running = (ref: LeaseRef) => async () => (await status(ref, AbortSignal.timeout(2_000))) === "running";
  const settle = features.profiles?.settleMs ? () => sleep(features.profiles!.settleMs) : undefined;
  const holdSaver = (ref: LeaseRef) => {
    for (const one of savers.values()) if (one.tag === ref.tag) Object.assign(one, { running: running(ref), ...(settle ? { settle } : {}) });
  };
  const endSocket = (id: string) => {
    sockets.get(held(id))?.close();
    sockets.delete(held(id));
  };

  const provider: BrowserProvider = {
    name: computer.provider,
    caps,

    async create(spec: SessionSpec, signal: AbortSignal) {
      signal?.throwIfAborted();
      const profile = spec.profile;
      if (profile && (!options.signIn || profile.name !== options.signIn.name || !features.profiles)) {
        throw new BrowserFailureError(browserFailure("refused", `browser profile: this run has no saved sign-in named "${profile.name}" to open. No session was started.`));
      }
      const pointer = profile ? options.signIn!.pointer : undefined;
      if (profile?.save && pointer) await claimSaver(`${computer.provider}|${pointer}`, spec.tag, `${spec.metadata.run}|${spec.metadata.label}`, signal, sleep);
      const session: BrowserSpec = {
        viewport: { width: spec.viewport.width, height: spec.viewport.height },
        ...(features.stealth && spec.verified ? { stealth: true } : {}),
        ...(features.headless && options.headless ? { headless: true } : {}),
        ...(pointer ? { profile: { pointer, save: profile!.save } } : {}),
      };
      // The vendor ends a session at its lifetime from create (wall-clock) or after that long with no client
      // (inactivity): custody's session timeout for the one, its idle release for the other (the session timeout where
      // idle release is off, 0). Never below the vendor's shortest (Kernel's 10 s), which it would refuse.
      const asked = features.timeout === "inactivity" && spec.idleTimeoutS > 0 ? spec.idleTimeoutS : spec.maxLifetimeS;
      const lifetimeS = Math.max(asked, Math.ceil((features.minLifetimeMs ?? 0) / 1000));
      let id: string;
      try {
        id = await computer.open(spec.tag, lifetimeS, session, signal);
      } catch (error) {
        // A refusal made nothing, so no session saves. Any other failure may have left its computer running (the provider
        // looks it up by its create label and releases it, and may fail at that too): the claim stays, held by whether the
        // tag still finds a computer, so the next saver replaces it only once none is left.
        if ((error as { code?: unknown } | null)?.code === "denied") freeSaver(spec.tag);
        else if (isSaver(spec.tag)) {
          for (const one of savers.values()) {
            if (one.tag === spec.tag) Object.assign(one, { running: async () => (await computer.find(spec.tag, AbortSignal.timeout(2_000))).length > 0, ...(settle ? { settle } : {}) });
          }
        }
        throw withStatus(error);
      }
      const ref = { id, tag: spec.tag };
      if (isSaver(spec.tag)) holdSaver(ref);
      return ref;
    },

    async findByTag(tag, signal) {
      const found = (await statused(computer.find(tag, signal))).map((id) => ({ id, tag }));
      if (found.length === 0) freeSaver(tag);
      for (const ref of found) if (isSaver(ref.tag)) holdSaver(ref);
      return found;
    },

    status,

    async attach(ref, signal): Promise<AttachTarget> {
      signal?.throwIfAborted();
      const url = rewriteConnectUrl(await statused(computer.url(ref.id)), options.connectBaseUrl);
      // A provider that keeps a session's downloads keeps only what the browser was told to save into its folder, and
      // that lasts as long as the socket that told it: one per session, held until its release. A failure costs the
      // files, not the session.
      const downloads = features.downloads;
      if (downloads && computer.downloads && !sockets.get(held(ref.id))?.open) {
        let pending = opening.get(held(ref.id));
        if (!pending) {
          pending = (async () => {
            const socket = await cdpCall(url, "Browser.setDownloadBehavior", { behavior: "allow", downloadPath: downloads.path, eventsEnabled: true }).catch(() => undefined);
            if (socket) sockets.set(held(ref.id), socket);
          })().finally(() => opening.delete(held(ref.id)));
          opening.set(held(ref.id), pending);
        }
        await pending;
      }
      return { sdkCdpUrl: url };
    },

    // The protocol's release takes no signal: a release is never cut short, so no session is left billing.
    async release(ref) {
      await opening.get(held(ref.id));
      endSocket(ref.id);
      try {
        await computer.close(ref.id);
      } catch (error) {
        // Already gone is released.
        if (!goneCode(error)) throw withStatus(error);
      }
      if (isSaver(ref.tag) && settle) await settle();
      freeSaver(ref.tag);
    },
  };

  const kept = computer.downloads;
  if (kept) {
    provider.downloads = {
      async list(ref): Promise<RemoteFile[]> {
        return (await statused(kept.list(ref.id))).map((file) => ({ name: file.name, sizeBytes: file.sizeBytes, modifiedAt: file.modifiedAt }));
      },
      read: (ref, name, maxBytes) => statused(kept.read(ref.id, name, maxBytes)),
    };
  }
  return provider;
}

/** The plane's vendor as a computer provider of the registry, made with the run's tool keys by the registry's names
 *  (computer-keys.ts providerOptions): the same provider an agent's browser computer is, on the keys the tool plane
 *  resolved it by. */
export async function planeComputer(vendor: string, env: NodeJS.ProcessEnv): Promise<ComputerProvider> {
  const keys = Object.fromEntries((KEY_TABLE.keys[vendor] ?? []).flatMap((key) => (typeof env[key.name] === "string" && env[key.name] !== "" ? [[key.name, env[key.name] as string]] : [])));
  const options = providerOptions(vendor, keys);
  if (!options.ok) throw new BrowserFailureError(browserFailure("browser_unavailable", `The browser does not run here: ${options.error.message}.`));
  // The server's own variables the provider's descriptor says it reads (hostEnv: the gateway a server behind one reaches
  // the vendor through), as the claim's providers get them (workspace/computer-deps.ts): the key checks and the sign-in
  // creation already go through that gateway, so the browser's sessions do too.
  const names = PROVIDERS.find((one) => one.id === vendor)?.hostEnv;
  const hostEnv = names ? { env: Object.fromEntries(names.flatMap((name) => (env[name] === undefined ? [] : [[name, String(env[name])]]))) } : {};
  return providerFor(vendor as never, { ...(options.options as object), ...hostEnv } as never);
}

/** The run's browser sessions of a lower claim epoch released, as a computer's are when a claim starts it (the janitor's
 *  releaseOlder): a runner that died after the vendor made a session and before its id was kept left one this claim's
 *  labels would never find. One that ended may have been saving to the run's sign-in, and this process holds no saver
 *  for it, so when any was ended the provider's settle time is waited out before the plane's browser opens a session. */
export async function releaseOlderBrowsers(
  provider: ComputerProvider,
  run: { readonly runId: string; readonly epoch: number },
  { signal, sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)) }: { readonly signal?: AbortSignal; readonly sleep?: (ms: number) => Promise<void> } = {},
): Promise<void> {
  const older = await releaseOlder(provider, run.runId, run.epoch, signal ? { signal } : {});
  if (!older.ok) throw new BrowserFailureError(browserFailure("browser_unavailable", `The browser does not run here: ${older.error.message}.`));
  const settleMs = provider.capabilities().browser?.profiles?.settleMs ?? 0;
  if (settleMs > 0 && older.value.released.length + older.value.detached.length > 0) await sleep(settleMs);
}

/** A Browserbase connect URL moved onto the credential proxy that fronts its sockets: only `*.browserbase.com` hosts, with
 *  the signing query kept. */
export function rewriteConnectUrl(connectUrl: string, connectBaseUrl: string | undefined): string {
  if (!connectBaseUrl) return connectUrl;
  try {
    const target = new URL(connectBaseUrl);
    const url = new URL(connectUrl);
    if (!/(?:^|\.)browserbase\.com$/i.test(url.hostname)) return connectUrl;
    url.protocol = target.protocol;
    url.host = target.host;
    url.pathname = target.pathname.replace(/\/$/, "") + url.pathname;
    return url.toString();
  } catch {
    return connectUrl;
  }
}

/** A run's browser over `provider`, a browser computer provider (the plane's vendor, or a test's stand-in), as the claim
 *  opens an agent's browser computer: each session made under the run's labels (`run`, when the run holds a claim, so a
 *  sweep finds what it left), for at most the provider's longest lifetime. A provider of another kind is refused. */
export function planeBrowser(provider: ComputerProvider, run: { readonly runId: string; readonly epoch: number } | undefined): ClaimBrowser {
  if (!isBrowserProvider(provider)) throw new BrowserFailureError(browserFailure("browser_unavailable", `The browser does not run here: the ${provider.id} provider gives no browser.`));
  const spec = { image: BROWSER_IMAGE, lifetimeMs: provider.capabilities().maxLifetimeMs, network: "open" as const, labels: run ? runLabels(run.runId, run.epoch) : {} };
  return claimBrowser(provider, spec).browser;
}

/** Tests only: forgets every session's socket and saver this process holds. */
export function resetBrowserComputerHoldings(): void {
  for (const socket of sockets.values()) socket.close();
  sockets.clear();
  opening.clear();
  savers.clear();
}
