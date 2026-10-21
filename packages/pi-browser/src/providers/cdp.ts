import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createReadStream, createWriteStream, readFileSync } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readdir, readFile, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { BrowserFailureError, PROFILE_NAME } from "../core/custody.js";
import type { AttachTarget, BrowserProvider, ProviderCaps, RemoteFile, SavedProfile } from "../core/host.js";
import type { LeaseRef, ResourceStatus } from "../core/lease.js";
import { cdpCall } from "./cdp-call.js";
import { claimWriter, freeWriter, noteWriter } from "./profiles.js";

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

const CAPS: ProviderCaps = { timeoutModel: "wall-clock", maxLifetimeS: 86_400, survivesDisconnect: true, releaseIsAsync: false, profiles: false, extension: "loaded-locally", settings: { proxies: false, verified: false, geolocation: false, region: false, context: false } };
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
/** Bounded: a Chrome that takes the connection and never answers must not hold a start past its deadline. */
const answeringPath = async (port: number): Promise<string | null> => debuggerUrl(`http://127.0.0.1:${port}`, AbortSignal.timeout(2_000)).then((url) => new URL(url).pathname, () => null);
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
const savedDir = (root: string, name: string): string => path.join(root, ".profiles", name);
const refusal = (message: string) => new BrowserFailureError({ ok: false, code: "refused", retryable: false, effect: "none", message });

/** A copy of a profile another Chrome is writing: that Chrome renames, truncates and deletes its journals and temp files
 *  all the time. A file gone by the time it is reached is skipped. `fs.cp` fails the whole copy on it, and `fs.copyFile`
 *  never returns for a file truncated while it copies (libuv's sendfile loop makes no progress and does not stop), so
 *  files go through streams, which end where the file ends. A cancelled `signal` stops the copy at the next file or chunk. */
export async function copyProfile(from: string, to: string, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  await mkdir(to, { recursive: true });
  const entries = await readdir(from, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return []; throw error; });
  for (const entry of entries) {
    signal?.throwIfAborted();
    if (/^(Singleton|DevToolsActivePort|lockfile)/.test(entry.name) || entry.name === TMP_MARKER) continue;
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    try {
      if (entry.isDirectory()) await copyProfile(source, target, signal);
      else if (entry.isSymbolicLink()) await symlink(await readlink(source), target);
      else if (entry.isFile()) {
        // The mode is read before either stream exists: a stream made first and left waiting on this await has nobody listening for its error if the file is gone
        // by then, and a failed open with no listener is an unhandled 'error' event that ends the process. Inside pipeline, a failure of either stream is the pipeline's.
        const mode = (await stat(source)).mode & 0o777;
        await pipeline(createReadStream(source), createWriteStream(target, { mode }), signal ? { signal } : {});
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT" || signal?.aborted) throw error; }
  }
}

/** A saved profile lives in `.profiles/<name>`, which no lease tag can name. Saving, the lease's own directory is a link to
 *  it, so release removes the link and never the profile; not saving, it is a copy that leaves the profile as it was. */
async function prepareProfile(root: string, dir: string, profile: SavedProfile, tag: string, owner: string, signal: AbortSignal, remove: RemoveDir): Promise<void> {
  if (!PROFILE_NAME.test(profile.name)) throw refusal("browser profile: a profile name is 1 to 64 characters of letters, digits, dot, underscore and dash, starting with a letter or digit. No session was started.");
  const saved = savedDir(root, profile.name);
  await rm(dir, { recursive: true, force: true });
  if (!profile.save) {
    const exists = await stat(saved).then((s) => s.isDirectory(), () => false);
    if (exists) {
      // A copy cut short (cancelled, a full disk) is no lease: nothing else knows this directory, so it goes here, and is said if it stays.
      try { await copyProfile(saved, dir, signal); } catch (error) {
        const left = await removeAll([dir], remove);
        throw left ? new ProfileNotRemovedError(left.dirs, left.error, error) : error;
      }
    }
    return;
  }
  await claimWriter(`${path.resolve(root)}|${profile.name}`, profile.name, tag, owner, signal);
  try {
    const lock = await readlink(path.join(saved, "SingletonLock")).then((value) => /^(.*)-(\d+)$/.exec(value), () => null);
    if (lock && lock[1] === os.hostname() && alive(Number(lock[2]))) throw refusal(`browser profile "${profile.name}": a Chrome process (${lock[2]}) is using this profile. No session was started.`);
    await mkdir(path.join(saved, "Default"), { recursive: true });
    await symlink(path.resolve(saved), dir, "dir");
  } catch (error) { freeWriter(tag); throw error; }
}

/** Chrome writes temp entries under its TMPDIR (its singleton socket directory, its url_fetcher entries) and a Chrome that is killed removes none of
 *  them, so each lease's Chrome gets a TMPDIR of its own, made under the host's, named in the profile (`.pib-tmpdir`) and removed with the lease: what
 *  Chrome writes there never lands in the host's TMPDIR. The directory carries an owner file naming the lease's tag, and only a directory that names the
 *  tag asked for is ever removed, so a profile that names another path (a copied or hand-written one) removes nothing. Chrome aborts when its socket path
 *  passes 107 bytes, so a host TMPDIR too long to leave room for the private directory's name and the socket's is left as it is (Chrome inherits it). Not
 *  made on Windows, where Chrome's temp directory is not TMPDIR. */
const TMP_MARKER = ".pib-tmpdir";
const TMP_OWNER = ".pib-owner";
/** A saved lease's own record of its private TMPDIR, `<profileRoot>/.profiles/.leases/<tag>` (no profile name starts with a dot): the profile's marker is
 *  shared by every lease that runs on the saved profile (a replacement for a crashed browser overwrites it) and a restarted provider has no map, so this is
 *  the one place a later release finds it. A copied profile is the lease's own, and its marker is not shared. */
const leaseRecord = (root: string, tag: string): string => path.join(root, ".profiles", ".leases", tag);
const TMP_NAME = /^pib-[A-Za-z0-9]{6}$/;
const SOCKET_PATH_MAX = 107;
const SOCKET_PATH_TAIL = "/.org.chromium.Chromium.XXXXXX/SingletonSocket".length;
async function makePrivateTmp(tag: string, profile: string, record: string | null, remove: RemoveDir): Promise<string | null> {
  if (process.platform === "win32") return null;
  const base = os.tmpdir();
  if (Buffer.byteLength(path.join(base, "pib-XXXXXX")) + SOCKET_PATH_TAIL > SOCKET_PATH_MAX) return null;
  const dir = await mkdtemp(path.join(base, "pib-"));
  try {
    await writeFile(path.join(dir, TMP_OWNER), tag);
    await writeFile(path.join(profile, TMP_MARKER), dir);
    if (record) {
      await mkdir(path.dirname(record), { recursive: true });
      await writeFile(record, dir);
    }
  } catch (error) {
    if (record) await rm(record, { force: true }).catch(() => undefined);
    // The directory is not recorded anywhere yet, so a setup that fails here removes it, and names it if it cannot.
    const left = await removeTree(dir, remove);
    throw left ? new ProfileNotRemovedError([dir], left.error, error) : error;
  }
  return dir;
}
/** The private directory the profile names, when it is one this provider made for this tag. */
async function ownedTmp(profile: string, tag: string): Promise<string | null> {
  return ownedBy((await readFile(path.join(profile, TMP_MARKER), "utf8").catch(() => "")).trim(), tag);
}
/** The private directory this lease's own record names, when it is one this provider made for this tag. */
async function recordedTmp(root: string, tag: string): Promise<string | null> {
  return ownedBy((await readFile(leaseRecord(root, tag), "utf8").catch(() => "")).trim(), tag);
}
async function ownedBy(named: string, tag: string): Promise<string | null> {
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

export async function closeGracefully(port: number, pid: number, children: Map<number, ChildProcess>): Promise<void> {
  try {
    const session = await cdpCall(await debuggerUrl(`http://127.0.0.1:${port}`, AbortSignal.timeout(2_000)), "Browser.close", {}, 2_000);
    session.close();
  } catch { /* the browser may close its socket before it answers */ }
  const child = children.get(pid);
  for (const deadline = Date.now() + 8_000; Date.now() < deadline; ) {
    if (child ? child.exitCode !== null || child.signalCode !== null : !alive(pid)) return;
    await sleep(50);
  }
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
  /** A lease whose private TMPDIR is gone (or never made) keeps neither its map entry nor its record. */
  const forgetTmp = async (root: string, tag: string): Promise<void> => {
    privateTmps.delete(tag);
    await rm(leaseRecord(root, tag), { force: true }).catch(() => undefined);
  };
  /** A spawned Chrome whose handle we hold is ours (a handle cannot name a recycled pid); after a restart, only while
   *  the browser on the recorded port reports that pid. */
  const isOurs = async ({ pid, port }: { pid: number; port: number }): Promise<boolean> => {
    const child = children.get(pid);
    if (child) return child.exitCode === null && child.signalCode === null;
    return alive(pid) && (await browserPid(port)) === pid;
  };
  return {
    name: "cdp",
    caps: { ...CAPS, profiles: "chrome" in options, ...("endpoint" in options ? { sharedBrowser: true } : {}) },
    ...(downloads ? { downloads } : {}),

    async create(spec, signal) {
      if ("endpoint" in options) return { id: `endpoint:${spec.tag}`, tag: spec.tag };
      const { executablePath, profileRoot, headless = true, args = [] } = options.chrome;
      const sandbox = options.chrome.sandbox ?? process.env.PI_BROWSER_NO_SANDBOX !== "1";
      const dir = profileDir(profileRoot, spec.tag);
      if (spec.profile) await prepareProfile(profileRoot, dir, spec.profile, spec.tag, `${spec.metadata.run}|${spec.metadata.label}`, signal, remove);
      try {
        signal?.throwIfAborted();
        await mkdir(path.join(dir, "Default"), { recursive: true });
        await mkdir(downloadsDir(profileRoot, spec.tag), { recursive: true });
        const prefsFile = path.join(dir, "Default", "Preferences");
        type Prefs = { download?: object; savefile?: object; session?: object };
        const prefs = await readFile(prefsFile, "utf8").then((text) => { try { return JSON.parse(text) as Prefs; } catch { return {} as Prefs; } }, () => ({} as Prefs));
        // A saved profile is a browser the next session picks up. A session cookie (no Expires, like rack.session) survives a restart only when Chrome is told to
        // "continue where you left off" (session.restore_on_startup = 1) before it starts, so a profile that is kept sets it; the other keys stay as they are.
        const keeping = spec.profile ? { session: { ...prefs.session, restore_on_startup: 1 } } : {};
        // "Continue where you left off" would also reopen the previous tabs, and each would load its old URL at launch, before the driver, its navigation policy or an
        // egress guard is attached. The tab-restore files are removed before Chrome starts (the session cookies live in the cookie store, not in them), so only the
        // startup page opens. Chrome writes them again as it closes, and they are removed again at the next start.
        if (spec.profile) {
          await rm(path.join(dir, "Default", "Sessions"), { recursive: true, force: true });
          for (const legacy of ["Current Session", "Current Tabs", "Last Session", "Last Tabs"]) await rm(path.join(dir, "Default", legacy), { force: true });
        }
        await writeFile(prefsFile, JSON.stringify({ ...prefs, ...keeping, download: { ...prefs.download, default_directory: downloadsDir(profileRoot, spec.tag), prompt_for_download: false }, savefile: { ...prefs.savefile, default_directory: downloadsDir(profileRoot, spec.tag) } }));
        // A file left by an earlier Chrome on this profile names a browser that is not this one.
        await rm(path.join(dir, "DevToolsActivePort"), { force: true });
        const tmp = await makePrivateTmp(spec.tag, dir, spec.profile?.save ? leaseRecord(profileRoot, spec.tag) : null, remove);
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
          await forgetTmp(profileRoot, spec.tag);
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
            if (own && (await answeringPath(own.port)) === own.path) {
              const pid = child.pid;
              noteWriter(spec.tag, () => isOurs({ pid, port: own.port }));
              return { id: `local:${pid}:${own.port}:${spec.tag}`, tag: spec.tag };
            }
            if (Date.now() > deadline) throw new Error("Chrome did not open its debugging port");
          }
        } catch (error) {
          const kept = await this.release({ id: `local:${child.pid}:0:${spec.tag}`, tag: spec.tag }).then(() => null, (failure: unknown) => failure);
          const left = await removeAll([downloadsDir(profileRoot, spec.tag)], remove);
          if (kept && !(kept instanceof ProfileNotRemovedError)) throw kept;
          const dirs = [...(kept instanceof ProfileNotRemovedError ? kept.dirs : []), ...(left?.dirs ?? [])];
          throw dirs.length > 0 ? new ProfileNotRemovedError(dirs, kept instanceof ProfileNotRemovedError ? kept.cause : left!.error, error) : error;
        }
      } catch (error) {
        freeWriter(spec.tag);
        if (spec.profile) {
          // A reader's copy of the saved cookies stays on disk when this fails: the caller is told, with the start's own failure kept.
          const left = await removeAll([dir], remove);
          if (left) throw new ProfileNotRemovedError(error instanceof ProfileNotRemovedError ? [...error.dirs, ...left.dirs] : left.dirs, left.error, error);
        }
        throw error;
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
      const saved = !("endpoint" in options) && SAFE_TAG.test(local.tag) && (await lstat(profileDir(options.chrome.profileRoot, local.tag)).then((info) => info.isSymbolicLink(), () => false));
      // A profile that a live browser this ref does not name still runs on is that browser's: nothing is removed. A port
      // that holds the probe past PROBE_MS cannot be ruled out, so the profile stays and the release says so.
      if (!ours && !("endpoint" in options) && SAFE_TAG.test(local.tag)) {
        const dir = profileDir(options.chrome.profileRoot, local.tag);
        const own = await ownDebugger(dir);
        if (own) {
          const answer = await debuggerUrl(`http://127.0.0.1:${own.port}`, AbortSignal.timeout(PROBE_MS))
            .then((url) => new URL(url).pathname, (error: unknown) => (error instanceof Error && error.name === "TimeoutError" ? undefined : null));
          if (answer === own.path) {
            if (!saved) return;
            // A saved lease's directory is a link to the profile the live browser runs on, so that browser is another lease's (a replacement
            // for a crashed one): this lease's own link and private TMPDIR are still its to remove, and nothing the browser holds is.
            freeWriter(local.tag);
            // Not the profile's marker, which the replacement has overwritten: the lease's own record names its directory, also after a restart.
            const mine = privateTmps.get(local.tag) ?? await recordedTmp(options.chrome.profileRoot, local.tag);
            const left = await removeAll([dir, ...(mine ? [mine] : [])], remove);
            if (!mine || !left?.dirs.includes(mine)) await forgetTmp(options.chrome.profileRoot, local.tag);
            if (left) throw new ProfileNotRemovedError(left.dirs, left.error);
            return;
          }
          if (answer === undefined) throw new ProfileOwnershipUnclearError(dir, own.port);
        }
      }
      if (ours) {
        // Chrome writes its cookies out on a timer and when it exits on its own: a saved profile gets the chance, then the kill.
        if (saved) await closeGracefully(local.port, local.pid, children);
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
      freeWriter(local.tag);
      if (!("endpoint" in options) && SAFE_TAG.test(local.tag)) {
        const dir = profileDir(options.chrome.profileRoot, local.tag);
        const socketDir = await singletonDir(dir);
        const tmp = privateTmps.get(local.tag) ?? await recordedTmp(options.chrome.profileRoot, local.tag) ?? await ownedTmp(dir, local.tag);
        // All are always tried, the profile first named: the profile's link and marker are the only places the other directories' names are read, so
        // they are reported here with the profile's, not left for a later release to miss.
        const extras = [...new Set([...(socketDir ? [socketDir] : []), ...(tmp ? [tmp] : []), ...(extrasLeft.get(local.tag) ?? [])])];
        const left = await removeAll([dir, ...extras], remove);
        const stuck = extras.filter((extra) => left?.dirs.includes(extra));
        if (stuck.length > 0) extrasLeft.set(local.tag, stuck); else extrasLeft.delete(local.tag);
        if (!tmp || !stuck.includes(tmp)) await forgetTmp(options.chrome.profileRoot, local.tag);
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
