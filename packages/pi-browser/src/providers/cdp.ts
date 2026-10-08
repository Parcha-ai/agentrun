// The cdp provider: a browser the host already runs (any CDP endpoint), or a local Chrome this provider starts. For tests
// and development: it has no proxies, no search or fetch, and no tag search (a crash can orphan a local Chrome).
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdir, open, readdir, rm, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { BrowserFailureError } from "../core/custody.js";
import type { AttachTarget, BrowserProvider, ProviderCaps, RemoteFile } from "../core/host.js";
import type { LeaseRef, ResourceStatus } from "../core/lease.js";
import { cdpCall } from "./cdp-call.js";

export type CdpOptions =
  /** An existing browser: `http://host:port` or a `ws://` debugger URL. Release leaves it running. */
  | { endpoint: string; extensionId?: string }
  /** Start Chrome under `profileRoot/<tag>` on a free loopback port; release kills that process by exact pid. */
  | { chrome: {
    executablePath: string; profileRoot: string; headless?: boolean; args?: string[];
    /** Chrome's own sandbox, on unless this is `false`. Absent, `PI_BROWSER_NO_SANDBOX=1` turns it off. Turn it off only where
     *  Chrome cannot start its sandbox (root, a container, restricted user namespaces, an unpackaged Chrome for Testing on a
     *  distribution that confines unprivileged user namespaces); never because a run is in CI. */
    sandbox?: boolean;
  } };

/** Stagehand 4.1.0's own Chrome launch flags (DEFAULT_CHROME_FLAGS, packages/sdk-ts/src/browser/localBrowser.ts, MIT, see NOTICE).
 *  Without them Stagehand.create takes about 24 s on a local Chrome (measured 24.8 s and 22.1 s) instead of under 100 ms
 *  (78 ms and 93 ms), and `--remote-allow-origins` and `--enable-unsafe-extension-debugging` are among them. */
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

const CAPS: ProviderCaps = { timeoutModel: "wall-clock", maxLifetimeS: 86_400, survivesDisconnect: true, releaseIsAsync: false, extension: "loaded-locally" };
/** Where a local session's downloads land; it outlives the release, like the provider's own storage would. */
const downloadsDir = (profileRoot: string, tag: string) => path.join(profileDir(profileRoot, tag) + ".downloads");
const READY_MS = 20_000;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const freePort = () => new Promise<number>((resolve, reject) => {
  const server = net.createServer().once("error", reject).listen(0, "127.0.0.1", () => { const { port } = server.address() as net.AddressInfo; server.close(() => resolve(port)); });
});
/** A `ws://` debugger URL for an endpoint: the extension inside the browser dials the URL it is given, so it must be one. */
async function debuggerUrl(endpoint: string): Promise<string> {
  if (/^wss?:/i.test(endpoint)) return endpoint;
  const found = await (await fetch(new URL("/json/version", endpoint))).json() as { webSocketDebuggerUrl?: string };
  if (!found.webSocketDebuggerUrl) throw new Error("the endpoint did not report a debugger URL");
  return found.webSocketDebuggerUrl;
}
/** `local:<pid>:<port>:<tag>`: the pid is signalled only while the browser on that port reports that pid as its own, and
 *  the profile removed is the one of the tag the id itself carries, so a ref pairing one lease's id with another's tag
 *  touches nothing. */
const parse = (id: string) => { const m = /^local:(\d+):(\d+):([A-Za-z0-9_.-]+)$/.exec(id); return m ? { pid: Number(m[1]), port: Number(m[2]), tag: m[3] } : null; };
/** A lease tag names a directory under the profile root, so it is one path segment: no separators, never `.` or `..`. */
const SAFE_TAG = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,127}$/;
const profileDir = (root: string, tag: string): string => {
  if (!SAFE_TAG.test(tag)) throw new Error("a cdp lease tag is one path segment of [A-Za-z0-9_.-]");
  return path.join(root, tag);
};
/** Whether a process id is alive (any OS): signal 0 only asks. EPERM means it exists under another user. */
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; } };

/** Which process serves the CDP endpoint on `port`: the browser entry of `SystemInfo.getProcessInfo`, a fact every OS gives
 *  (a /proc command line exists only on Linux). Null when nothing answers or the answer has no browser process. */
async function browserPid(port: number, timeoutMs = 2_000): Promise<number | null> {
  try {
    const url = await Promise.race([debuggerUrl(`http://127.0.0.1:${port}`), sleep(timeoutMs).then(() => { throw new Error("no answer"); })]);
    const session = await cdpCall(url, "SystemInfo.getProcessInfo", {}, timeoutMs);
    session.close();
    const browser = (session.result?.processInfo as Array<{ type?: string; id?: number }> | undefined)?.find((p) => p.type === "browser");
    return typeof browser?.id === "number" ? browser.id : null;
  } catch { return null; }
}

/** Stop a process and its children: a process group where there are groups, `taskkill /T` on Windows. */
async function killTree(pid: number): Promise<void> {
  if (process.platform === "win32") return void (await new Promise<void>((resolve) => execFile("taskkill", ["/pid", String(pid), "/T", "/F"], () => resolve())));
  try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
}

export function cdpProvider(options: CdpOptions): BrowserProvider {
  const downloads = "chrome" in options ? localDownloads(options.chrome.profileRoot) : undefined;
  // Chromes this process started, so a release can wait for the exit it caused (an unreaped child still answers `kill 0`).
  const children = new Map<number, ChildProcess>();
  /** A Chrome this process spawned and still holds the handle of is its own (the handle cannot name a recycled pid); after a
   *  restart, a pid is ours only while the browser answering on the recorded port reports that pid. */
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
      // Chrome saves page downloads where the profile says, so the files of one session are the files of one directory.
      await writeFile(path.join(dir, "Default", "Preferences"), JSON.stringify({ download: { default_directory: downloadsDir(profileRoot, spec.tag), prompt_for_download: false }, savefile: { default_directory: downloadsDir(profileRoot, spec.tag) } }));
      const port = await freePort();
      const child = spawn(executablePath, [
        ...CHROME_FLAGS, ...(sandbox ? [] : ["--no-sandbox"]), ...(headless ? ["--headless=new"] : []), `--remote-debugging-port=${port}`, "--remote-debugging-address=127.0.0.1", `--user-data-dir=${dir}`,
        `--window-size=${spec.viewport.width},${spec.viewport.height}`, ...args, "about:blank",
      ], { stdio: "ignore", detached: true });
      // A Chrome that cannot start reports it as an `error` event, which unhandled would end the host: it rejects create instead.
      let failed: Error | null = null;
      child.once("error", (error) => { failed = error; });
      child.once("exit", (code, signal) => {
        // Chrome that cannot start its sandbox aborts (SIGABRT) before it opens a port. The signal is the typed fact; Chrome's
        // own words are never read, so the failure is typed here and names the knob.
        failed ??= sandbox && signal === "SIGABRT"
          ? new BrowserFailureError({ ok: false, code: "browser_unavailable", retryable: false, effect: "none", message: `Chrome exited before it opened its debugging port (SIGABRT); on a system that cannot start Chrome's sandbox (root, a container, restricted user namespaces) start it with sandbox: false or PI_BROWSER_NO_SANDBOX=1` })
          : new Error(`Chrome exited before it opened its debugging port (${signal ?? code})`);
      });
      if (child.pid === undefined) { await sleep(0); await rm(dir, { recursive: true, force: true }).catch(() => undefined); await rm(downloadsDir(profileRoot, spec.tag), { recursive: true, force: true }).catch(() => undefined); throw failed ?? new Error("Chrome could not be started"); }
      child.unref();
      children.set(child.pid, child);
      const ref = { id: `local:${child.pid}:${port}:${spec.tag}`, tag: spec.tag };
      try {
        for (const deadline = Date.now() + READY_MS; ; await sleep(100)) {
          if (failed) throw failed;
          if (await debuggerUrl(`http://127.0.0.1:${port}`).then(() => true, () => false)) return ref;
          if (Date.now() > deadline) throw new Error("Chrome did not open its debugging port");
        }
      } catch (error) { await this.release(ref); await rm(downloadsDir(profileRoot, spec.tag), { recursive: true, force: true }).catch(() => undefined); throw error; }
    },

    async findByTag() { return []; },

    async status(ref): Promise<ResourceStatus> {
      const local = parse(ref.id);
      // An endpoint lease names a browser the host runs; a local-shaped id this provider cannot read names no process it can
      // vouch for, so it is gone, never "running" unchecked.
      if (!local) return ref.id.startsWith("local:") ? "gone" : "running";
      return (await isOurs(local)) ? "running" : "gone";
    },

    async attach(ref): Promise<AttachTarget> {
      if ("endpoint" in options) return { sdkCdpUrl: await debuggerUrl(options.endpoint), ...(options.extensionId ? { extensionId: options.extensionId } : {}) };
      const local = parse(ref.id);
      if (!local) throw new Error("not a cdp lease");
      return { sdkCdpUrl: await debuggerUrl(`http://127.0.0.1:${local.port}`) };
    },

    async release(ref) {
      const local = parse(ref.id);
      if (!local || local.tag !== ref.tag) return; // not a lease this provider made, or its id and tag are from two leases
      if (await isOurs(local)) {
        await killTree(local.pid);
        const child = children.get(local.pid);
        children.delete(local.pid);
        // The child is unref'd, so a bare wait on its exit would let a process whose last await is this release end early
        // (exit 13): a timer keeps the loop alive until the exit arrives, or gives up on it. Without a handle (a release
        // after a restart) the pid is polled until it is gone.
        if (child && child.exitCode === null && child.signalCode === null) await new Promise<void>((resolve) => { const timer = setTimeout(resolve, 5_000); child.once("exit", () => { clearTimeout(timer); resolve(); }); });
        else for (const deadline = Date.now() + 5_000; alive(local.pid) && Date.now() < deadline; ) await sleep(50);
      }
      // The profile goes whether Chrome was running or had already exited (a crash leaves it behind); a tag that is not one
      // path segment names nothing this provider created, so nothing is removed for it.
      if (!("endpoint" in options) && SAFE_TAG.test(local.tag)) await rm(profileDir(options.chrome.profileRoot, local.tag), { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

/** The files of a local session's download directory, finished ones only (Chrome writes `.crdownload` while it works). */
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
