import { execFile, spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, open, readdir, readFile, readlink, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BrowserFailureError } from "../core/custody.js";
import type { AttachTarget, BrowserProvider, ProviderCaps, RemoteFile } from "../core/host.js";
import type { LeaseRef, ResourceStatus } from "../core/lease.js";
import { cdpCall } from "./cdp-call.js";

export type CdpOptions =
  /** An existing browser: `http://host:port` or a `ws://` debugger URL. Release leaves it running. */
  | { endpoint: string; extensionId?: string }
  /** Start Chrome under `profileRoot/<tag>` on a loopback port Chrome picks; release kills that process by exact pid. */
  | { chrome: {
    executablePath: string; profileRoot: string; headless?: boolean; args?: string[];
    /** Chrome's own sandbox, on unless `false`; absent, `PI_BROWSER_NO_SANDBOX=1` turns it off. Turn it off only where
     *  Chrome cannot start its sandbox (root, a container, confined user namespaces), never because a run is in CI. */
    sandbox?: boolean;
  } };

/** Stagehand 4.1.0's DEFAULT_CHROME_FLAGS (packages/sdk-ts/src/browser/localBrowser.ts, MIT, see NOTICE). Without them
 *  Stagehand.create takes about 24 s on a local Chrome instead of under 100 ms. */
const CHROME_FLAGS: readonly string[] = [
  "--disable-features=Translate,OptimizationHints,MediaRouter,DialMediaRouteProvider,CalculateNativeWinOcclusion,InterestFeedContentSuggestions,CertificateTransparencyComponentUpdater,AutofillServerCommunication,PrivacySandboxSettings4,RenderDocument",
  "--disable-component-extensions-with-background-pages",
  "--disable-background-networking",
  "--disable-component-update",
  "--disable-client-side-phishing-detection",
  "--disable-sync",
  "--metrics-recording-only",
  "--disable-default-apps",
  "--mute-audio",
  "--no-default-browser-check",
  "--no-first-run",
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
  "--disable-background-timer-throttling",
  "--disable-ipc-flooding-protection",
  "--password-store=basic",
  "--use-mock-keychain",
  "--force-fieldtrials=*BackgroundTracing/default/",
  "--disable-hang-monitor",
  "--disable-prompt-on-repost",
  "--disable-domain-reliability",
  "--propagate-iph-for-testing",
  "--enable-unsafe-extension-debugging",
  "--remote-allow-origins=*",
  "--enable-features=WebMCPTesting,DevToolsWebMCPSupport",
];

const CAPS: ProviderCaps = { timeoutModel: "wall-clock", maxLifetimeS: 86_400, survivesDisconnect: true, releaseIsAsync: false, extension: "loaded-locally", settings: { proxies: false, verified: false, geolocation: false, region: false, context: false } };
const downloadsDir = (profileRoot: string, tag: string) => path.join(profileDir(profileRoot, tag) + ".downloads");
const READY_MS = 20_000;
/** The browser is gone and directories it used are not: a profile left behind holds the session's cookies, so a release that cannot remove
 *  one says so, naming every one still there (`dirs`, the first as `dir`), and is asked again. `original` is the failure of the launch that
 *  was being undone, when there was one. */
export class ProfileNotRemovedError extends Error {
  readonly code = "profile_not_removed";
  readonly dir: string;
  constructor(readonly dirs: readonly string[], readonly cause: unknown, readonly original?: unknown) {
    super(`the browser is gone but ${dirs.length === 1 ? "its directory" : "its directories"} ${dirs.join(" and ")} could not be removed (${cause instanceof Error ? cause.message : String(cause)}); ${dirs.length === 1 ? "it" : "they"} may hold the session's cookies, so remove ${dirs.length === 1 ? "it" : "them"} by hand${original === undefined ? "" : `; the launch had also failed: ${original instanceof Error ? original.message : String(original)}`}`);
    this.name = "ProfileNotRemovedError";
    this.dir = dirs[0]!;
  }
}

/** The removal a provider uses; a test hands in its own to fail it in a controlled way. */
type RemoveDir = (dir: string, options: { recursive: true; force: true }) => Promise<void>;
/** What a retry can cure: a file that arrived in the directory, or a handle or lock that is let go (the codes Node's own rm retries). */
const RETRYABLE = new Set(["ENOTEMPTY", "EBUSY", "EMFILE", "ENFILE", "EPERM"]);
const REMOVAL_RETRIES = 5;
const REMOVAL_DELAY_MS = 100;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** Removes a directory tree; what is still there afterwards is the caller's to report, never to swallow. A browser's last writes can land after its
 *  process is killed (its other processes are still exiting), and a directory a file arrives in while it is being removed fails with ENOTEMPTY: the
 *  removal is tried again, waiting a little longer each time (100, 200, ... 500 ms, about a second and a half in all). A failure a retry cannot cure
 *  (EACCES, say) is reported at once. (A link is unlinked, not followed.) */
async function removeTree(dir: string, remove: RemoveDir): Promise<{ dir: string; error: Error } | null> {
  for (let attempt = 0; ; attempt += 1) {
    try { await remove(dir, { recursive: true, force: true }); return null; } catch (failure: unknown) {
      const error = failure instanceof Error ? failure : new Error(String(failure));
      if (attempt >= REMOVAL_RETRIES || !RETRYABLE.has((error as NodeJS.ErrnoException).code ?? "")) return { dir, error };
      await sleep(REMOVAL_DELAY_MS * (attempt + 1));
    }
  }
}
/** Every directory is tried, whatever the others did; what is left is reported together. */
async function removeAll(dirs: string[], remove: RemoveDir): Promise<{ dirs: string[]; error: Error } | null> {
  const left: Array<{ dir: string; error: Error }> = [];
  for (const dir of dirs) { const stuck = await removeTree(dir, remove); if (stuck) left.push(stuck); }
  return left.length > 0 ? { dirs: left.map((l) => l.dir), error: left[0]!.error } : null;
}

/** The extension inside the browser dials the URL it is given, so it must be a `ws://` debugger URL. */
async function debuggerUrl(endpoint: string, signal?: AbortSignal): Promise<string> {
  if (/^wss?:/i.test(endpoint)) return endpoint;
  const found = await (await fetch(new URL("/json/version", endpoint), signal ? { signal } : {})).json() as { webSocketDebuggerUrl?: string };
  if (!found.webSocketDebuggerUrl) throw new Error("the endpoint did not report a debugger URL");
  return found.webSocketDebuggerUrl;
}
/** Only the Chrome running on that profile writes `DevToolsActivePort`, so it names that Chrome and no other browser on
 *  a port. */
async function ownDebugger(profile: string): Promise<{ port: number; path: string } | null> {
  const [port, browser] = (await readFile(path.join(profile, "DevToolsActivePort"), "utf8").catch(() => "")).split("\n");
  return /^\d+$/.test(port ?? "") && browser?.startsWith("/devtools/browser/") ? { port: Number(port), path: browser.trim() } : null;
}
const answeringPath = async (port: number): Promise<string | null> => debuggerUrl(`http://127.0.0.1:${port}`).then((url) => new URL(url).pathname, () => null);
/** A port that takes the probe and does not answer within this may still be a live browser's. */
const PROBE_MS = 2_000;
/** A release that does not own the lease's browser left its profile: the port the profile names took the probe and did
 *  not answer, so a live browser may still run on it. Asked again once that port answers or closes, the release decides. */
export class ProfileOwnershipUnclearError extends Error {
  readonly code = "profile_ownership_unclear";
  constructor(readonly dir: string, readonly port: number) {
    super(`the profile ${dir} was left: port ${port}, which it names, took the browser probe and did not answer within ${PROBE_MS} ms, so a live browser may still run on it; release again once that port answers or closes`);
    this.name = "ProfileOwnershipUnclearError";
  }
}
/** `local:<pid>:<port>:<tag>`. The pid is signalled only while the browser on that port reports it as its own, and the
 *  profile removed is the id's own tag's, so a ref pairing one lease's id with another's tag touches nothing. */
const parse = (id: string) => { const m = /^local:(\d+):(\d+):([A-Za-z0-9_.-]+)$/.exec(id); return m ? { pid: Number(m[1]), port: Number(m[2]), tag: m[3] } : null; };
/** A lease tag names a directory under the profile root, so it is one path segment: no separators, never `.` or `..`. */
const SAFE_TAG = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,127}$/;
const profileDir = (root: string, tag: string): string => {
  if (!SAFE_TAG.test(tag)) throw new Error("a cdp lease tag is one path segment of [A-Za-z0-9_.-]");
  return path.join(root, tag);
};
/** Chrome writes temp entries under its TMPDIR (its singleton socket directory, its url_fetcher entries) and a Chrome that is killed removes none of
 *  them, so each lease's Chrome gets a TMPDIR of its own, made under the host's, named in the profile (`.pib-tmpdir`) and removed with the lease: what
 *  Chrome writes there never lands in the host's TMPDIR. The directory carries an owner file naming the lease's tag, and only a directory that names the
 *  tag asked for is ever removed, so a profile that names another path (a copied or hand-written one) removes nothing. Chrome aborts when its socket path
 *  passes 107 bytes, so a host TMPDIR too long to leave room for the private directory's name and the socket's is left as it is (Chrome inherits it). Not
 *  made on Windows, where Chrome's temp directory is not TMPDIR. */
const TMP_MARKER = ".pib-tmpdir";
const TMP_OWNER = ".pib-owner";
const TMP_NAME = /^pib-[A-Za-z0-9]{6}$/;
const SOCKET_PATH_MAX = 107;
const SOCKET_PATH_TAIL = "/.org.chromium.Chromium.XXXXXX/SingletonSocket".length;
async function makePrivateTmp(tag: string, profile: string, remove: RemoveDir): Promise<string | null> {
  if (process.platform === "win32") return null;
  const base = os.tmpdir();
  if (Buffer.byteLength(path.join(base, "pib-XXXXXX")) + SOCKET_PATH_TAIL > SOCKET_PATH_MAX) return null;
  const dir = await mkdtemp(path.join(base, "pib-"));
  try {
    await writeFile(path.join(dir, TMP_OWNER), tag);
    await writeFile(path.join(profile, TMP_MARKER), dir);
  } catch (error) {
    // The directory is not recorded anywhere yet, so a setup that fails here removes it, and names it if it cannot.
    const left = await removeTree(dir, remove);
    throw left ? new ProfileNotRemovedError([dir], left.error, error) : error;
  }
  return dir;
}
/** The private directory the profile names, when it is one this provider made for this tag. */
async function ownedTmp(profile: string, tag: string): Promise<string | null> {
  const named = (await readFile(path.join(profile, TMP_MARKER), "utf8").catch(() => "")).trim();
  if (!named || !path.isAbsolute(named) || !TMP_NAME.test(path.basename(named))) return null;
  return (await readFile(path.join(named, TMP_OWNER), "utf8").catch(() => null)) === tag ? named : null;
}
/** Signal 0 only asks; EPERM means the process exists under another user. */
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; } };

/** The browser entry of `SystemInfo.getProcessInfo`, which every OS gives (a /proc command line exists only on Linux). */
async function browserPid(port: number, timeoutMs = 2_000): Promise<number | null> {
  try {
    const url = await Promise.race([debuggerUrl(`http://127.0.0.1:${port}`), sleep(timeoutMs).then(() => { throw new Error("no answer"); })]);
    const session = await cdpCall(url, "SystemInfo.getProcessInfo", {}, timeoutMs);
    session.close();
    const browser = (session.result?.processInfo as Array<{ type?: string; id?: number }> | undefined)?.find((p) => p.type === "browser");
    return typeof browser?.id === "number" ? browser.id : null;
  } catch { return null; }
}

/** Chrome's singleton socket directory under TMPDIR outlives every Chrome exit, a clean one included; the profile's link
 *  names it. */
async function singletonDir(profile: string): Promise<string | null> {
  const socket = await readlink(path.join(profile, "SingletonSocket")).catch(() => null);
  const dir = socket && path.basename(socket) === "SingletonSocket" ? path.dirname(socket) : null;
  return dir && /^\.?(org\.chromium\.Chromium|com\.google\.Chrome)\.[A-Za-z0-9]{6}$/.test(path.basename(dir)) ? dir : null;
}

/** Whether `pid` leads its own process group (Chrome is started detached, so it does); null where there is no /proc to ask. */
function leadsOwnGroup(pid: number): boolean | null {
  if (process.platform !== "linux") return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // pid (comm) state ppid pgrp ...: the name may hold spaces and brackets, so the fields are counted from its last ")".
    return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[2]) === pid;
  } catch { return false; }
}

/** A pid reaches here from a ref's id, which a restart reads back from a record: `kill(-1)` signals every process the user can,
 *  `kill(0)` this process's own group, so neither a pid below 2 nor our own is ever signalled, and a negative pid (a whole group)
 *  only for a process that leads one. */
export async function killTree(pid: number, io: { kill?: (pid: number, signal: "SIGKILL") => void; leadsGroup?: (pid: number) => boolean | null } = {}): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return;
  if (process.platform === "win32") return void (await new Promise<void>((resolve) => execFile("taskkill", ["/pid", String(pid), "/T", "/F"], () => resolve())));
  const kill = io.kill ?? ((target, signal) => process.kill(target, signal));
  if ((io.leadsGroup ?? leadsOwnGroup)(pid) !== false) { try { return kill(-pid, "SIGKILL"); } catch { /* no such group: the process alone */ } }
  try { kill(pid, "SIGKILL"); } catch { /* already gone */ }
}

/** `internals` is for tests: the removal a release uses. */
export function cdpProvider(options: CdpOptions, internals: { remove?: RemoveDir } = {}): BrowserProvider {
  const remove: RemoveDir = internals.remove ?? ((dir, opts) => rm(dir, opts));
  const downloads = "chrome" in options ? localDownloads(options.chrome.profileRoot) : undefined;
  // So a release can wait for the exit it caused: an unreaped child still answers `kill 0`.
  const children = new Map<number, ChildProcess>();
  /** Directories besides the profile (Chrome's socket directory, the lease's private TMPDIR) that a release could not remove: the profile that named
   *  them may go first, so the next release of the lease in this process is told them here. (A restarted process has the report's text.) */
  const extrasLeft = new Map<string, string[]>();
  /** The private TMPDIR of each lease this provider started, by tag: the profile's marker is the only record a restarted process has, and a profile
   *  that something else removed first takes it along. */
  const privateTmps = new Map<string, string>();
  /** A spawned Chrome whose handle we hold is ours (a handle cannot name a recycled pid); after a restart, only while
   *  the browser on the recorded port reports that pid. */
  const isOurs = async ({ pid, port }: { pid: number; port: number }): Promise<boolean> => {
    const child = children.get(pid);
    if (child) return child.exitCode === null && child.signalCode === null;
    return alive(pid) && (await browserPid(port)) === pid;
  };
  return {
    name: "cdp",
    caps: CAPS,
    ...(downloads ? { downloads } : {}),

    async create(spec) {
      if ("endpoint" in options) return { id: `endpoint:${spec.tag}`, tag: spec.tag };
      const { executablePath, profileRoot, headless = true, args = [] } = options.chrome;
      const sandbox = options.chrome.sandbox ?? process.env.PI_BROWSER_NO_SANDBOX !== "1";
      const dir = profileDir(profileRoot, spec.tag);
      await mkdir(path.join(dir, "Default"), { recursive: true });
      await mkdir(downloadsDir(profileRoot, spec.tag), { recursive: true });
      await writeFile(path.join(dir, "Default", "Preferences"), JSON.stringify({ download: { default_directory: downloadsDir(profileRoot, spec.tag), prompt_for_download: false }, savefile: { default_directory: downloadsDir(profileRoot, spec.tag) } }));
      // A file left by an earlier Chrome on this profile names a browser that is not this one.
      await rm(path.join(dir, "DevToolsActivePort"), { force: true });
      const tmp = await makePrivateTmp(spec.tag, dir, remove);
      if (tmp) privateTmps.set(spec.tag, tmp);
      const child = spawn(executablePath, [
        ...CHROME_FLAGS, ...(sandbox ? [] : ["--no-sandbox"]), ...(headless ? ["--headless=new"] : []), "--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1", `--user-data-dir=${dir}`,
        `--window-size=${spec.viewport.width},${spec.viewport.height}`, ...args, "about:blank",
      ], { stdio: "ignore", detached: true, ...(tmp ? { env: { ...process.env, TMPDIR: tmp } } : {}) });
      // A Chrome that cannot start emits `error`, which unhandled would end the host: it rejects create instead.
      let failed: Error | null = null;
      child.once("error", (error) => { failed = error; });
      child.once("exit", (code, signal) => {
        // A Chrome that cannot start its sandbox aborts (SIGABRT) before it opens a port: the signal is the fact, never
        // Chrome's words.
        failed ??= sandbox && signal === "SIGABRT"
          ? new BrowserFailureError({ ok: false, code: "browser_unavailable", retryable: false, effect: "none", message: `Chrome exited before it opened its debugging port (SIGABRT); on a system that cannot start Chrome's sandbox (root, a container, restricted user namespaces) start it with sandbox: false or PI_BROWSER_NO_SANDBOX=1` })
          : new Error(`Chrome exited before it opened its debugging port (${signal ?? code})`);
      });
      if (child.pid === undefined) {
        await sleep(0);
        const left = await removeAll([dir, downloadsDir(profileRoot, spec.tag), ...(tmp ? [tmp] : [])], remove);
        privateTmps.delete(spec.tag);
        const why = failed ?? new Error("Chrome could not be started");
        throw left ? new ProfileNotRemovedError(left.dirs, left.error, why) : why;
      }
      child.unref();
      children.set(child.pid, child);
      // The lease is that Chrome only once the browser answering on the port is the one its profile file names, so a
      // port another browser holds is never taken for it.
      try {
        for (const deadline = Date.now() + READY_MS; ; await sleep(100)) {
          if (failed) throw failed;
          const own = await ownDebugger(dir);
          if (own && (await answeringPath(own.port)) === own.path) return { id: `local:${child.pid}:${own.port}:${spec.tag}`, tag: spec.tag };
          if (Date.now() > deadline) throw new Error("Chrome did not open its debugging port");
        }
      } catch (error) {
        const kept = await this.release({ id: `local:${child.pid}:0:${spec.tag}`, tag: spec.tag }).then(() => null, (failure: unknown) => failure);
        const left = await removeAll([downloadsDir(profileRoot, spec.tag)], remove);
        if (kept && !(kept instanceof ProfileNotRemovedError)) throw kept;
        const dirs = [...(kept instanceof ProfileNotRemovedError ? kept.dirs : []), ...(left?.dirs ?? [])];
        throw dirs.length > 0 ? new ProfileNotRemovedError(dirs, kept instanceof ProfileNotRemovedError ? kept.cause : left!.error, error) : error;
      }
    },

    async findByTag() { return []; },

    async status(ref): Promise<ResourceStatus> {
      const local = parse(ref.id);
      // A local-shaped id this provider cannot read names no process it can vouch for: gone, never "running" unchecked.
      if (!local) return ref.id.startsWith("local:") ? "gone" : "running";
      return (await isOurs(local)) ? "running" : "gone";
    },

    async attach(ref): Promise<AttachTarget> {
      if ("endpoint" in options) return { sdkCdpUrl: await debuggerUrl(options.endpoint), ...(options.extensionId ? { extensionId: options.extensionId } : {}) };
      const local = parse(ref.id);
      if (!local) throw new Error("not a cdp lease");
      const own = await ownDebugger(profileDir(options.chrome.profileRoot, local.tag));
      if (!own || own.port !== local.port) throw new Error("this lease's profile records a different browser than the one its id names");
      const url = await debuggerUrl(`http://127.0.0.1:${local.port}`);
      if (new URL(url).pathname !== own.path) throw new Error(`the browser on port ${local.port} is not the browser this lease's profile records`);
      return { sdkCdpUrl: url };
    },

    async release(ref) {
      const local = parse(ref.id);
      if (!local || local.tag !== ref.tag) return;
      const ours = await isOurs(local);
      // A profile that a live browser this ref does not name still runs on is that browser's: nothing is removed. A port
      // that holds the probe past PROBE_MS cannot be ruled out, so the profile stays and the release says so.
      if (!ours && !("endpoint" in options) && SAFE_TAG.test(local.tag)) {
        const dir = profileDir(options.chrome.profileRoot, local.tag);
        const own = await ownDebugger(dir);
        if (own) {
          const answer = await debuggerUrl(`http://127.0.0.1:${own.port}`, AbortSignal.timeout(PROBE_MS))
            .then((url) => new URL(url).pathname, (error: unknown) => (error instanceof Error && error.name === "TimeoutError" ? undefined : null));
          if (answer === own.path) return;
          if (answer === undefined) throw new ProfileOwnershipUnclearError(dir, own.port);
        }
      }
      if (ours) {
        await killTree(local.pid);
        const child = children.get(local.pid);
        children.delete(local.pid);
        // The child is unref'd, so a bare wait on its exit could let a process whose last await is this release end
        // early (exit 13): a timer keeps the loop alive. Without a handle the pid is polled until gone.
        if (child && child.exitCode === null && child.signalCode === null) await new Promise<void>((resolve) => { const timer = setTimeout(resolve, 5_000); child.once("exit", () => { clearTimeout(timer); resolve(); }); });
        else for (const deadline = Date.now() + 5_000; alive(local.pid) && Date.now() < deadline; ) await sleep(50);
      }
      // The profile goes even after a crash; a tag that is not one path segment names nothing this provider made, so
      // nothing is removed.
      if (!("endpoint" in options) && SAFE_TAG.test(local.tag)) {
        const dir = profileDir(options.chrome.profileRoot, local.tag);
        const socketDir = await singletonDir(dir);
        const tmp = privateTmps.get(local.tag) ?? await ownedTmp(dir, local.tag);
        // All are always tried, the profile first named: the profile's link and marker are the only places the other directories' names are read, so
        // they are reported here with the profile's, not left for a later release to miss.
        const extras = [...new Set([...(socketDir ? [socketDir] : []), ...(tmp ? [tmp] : []), ...(extrasLeft.get(local.tag) ?? [])])];
        const left = await removeAll([dir, ...extras], remove);
        const stuck = extras.filter((extra) => left?.dirs.includes(extra));
        if (stuck.length > 0) extrasLeft.set(local.tag, stuck); else extrasLeft.delete(local.tag);
        if (!tmp || !stuck.includes(tmp)) privateTmps.delete(local.tag);
        if (left) throw new ProfileNotRemovedError(left.dirs, left.error);
      }
    },
  };
}

/** Finished files only: Chrome writes `.crdownload` while it works. */
function localDownloads(profileRoot: string): NonNullable<BrowserProvider["downloads"]> {
  const inside = (ref: LeaseRef, name: string) => { if (name !== path.basename(name) || !name) throw new Error("not a download name"); return path.join(downloadsDir(profileRoot, ref.tag), name); };
  return {
    async list(ref): Promise<RemoteFile[]> {
      const dir = downloadsDir(profileRoot, ref.tag);
      const rows: RemoteFile[] = [];
      for (const name of await readdir(dir).catch(() => [] as string[])) {
        if (name.endsWith(".crdownload") || name.startsWith(".")) continue;
        const info = await stat(path.join(dir, name)).catch(() => null);
        if (info?.isFile()) rows.push({ name, sizeBytes: info.size, modifiedAt: info.mtime.toISOString() });
      }
      return rows.sort((a, b) => a.name.localeCompare(b.name));
    },
    async read(ref, name, maxBytes) {
      const file = await open(inside(ref, name), "r");
      return (async function* () {
        try {
          let total = 0;
          for await (const chunk of file.createReadStream()) {
            total += (chunk as Buffer).byteLength;
            if (total > maxBytes) throw new Error(`larger than the ${maxBytes}-byte limit`);
            yield chunk as Uint8Array;
          }
        } finally { await file.close().catch(() => undefined); }
      })();
    },
  };
}
