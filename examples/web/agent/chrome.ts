// The agent's own Chrome, for `AGENT_BROWSER=chrome`: start-run.mjs starts one Chrome for the run, headless, on a
// loopback debugging port Chrome picks, and pi-browser attaches to it by endpoint. Its profile directory is the
// sign-in: `<home>/chrome/<profile key>`, owner-only and outside every run's `work/`, so the model's file tools never
// reach it, and a sign-in made in it is still there for the next run. Only the run that holds the profile's save lease
// (or the first run, when the agent has no such profile yet) opens it; any other run gets a profile of its own beside
// the run, signed out, and removed with the Chrome.
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type BrowserKind = "browserbase" | "chrome";
/** The agent's local Chrome profile, as a key in the agent home's `browser.profiles` (its save lease decides who opens it). */
export const CHROME_PROFILE = "local-chrome";

/** `AGENT_BROWSER`: `browserbase` (default) or `chrome`. */
export function browserOf(env: NodeJS.ProcessEnv): BrowserKind {
  const kind = env.AGENT_BROWSER || "browserbase";
  if (kind !== "browserbase" && kind !== "chrome") throw new Error(`AGENT_BROWSER is browserbase or chrome, not ${kind}`);
  return kind;
}

export const chromeProfileDir = (home: string, key = CHROME_PROFILE) => join(home, "chrome", key);

/** The profile directory a run may start Chrome on. `shared`: the agent's, so the run records it for the home. */
export function chromeProfileFor(home: string, run: { runId: string; dir: string }, state: { profiles: Record<string, unknown>; leases: Record<string, { runId: string }> }): { dir: string; shared: boolean } {
  const holds = Object.hasOwn(state.leases, CHROME_PROFILE) ? state.leases[CHROME_PROFILE]!.runId === run.runId : !Object.hasOwn(state.profiles, CHROME_PROFILE);
  return holds ? { dir: chromeProfileDir(home), shared: true } : { dir: join(run.dir, "chrome-profile"), shared: false };
}

/** pi-browser's cdp provider starts Chrome with these (Stagehand's defaults, MIT): without them a Stagehand attach takes
 *  far longer, and its extension cannot be loaded over the debugging socket. */
export const CHROME_FLAGS: readonly string[] = [
  "--disable-features=Translate,OptimizationHints,MediaRouter,DialMediaRouteProvider,CalculateNativeWinOcclusion,InterestFeedContentSuggestions,CertificateTransparencyComponentUpdater,AutofillServerCommunication,PrivacySandboxSettings4,RenderDocument",
  "--disable-component-extensions-with-background-pages", "--disable-background-networking", "--disable-component-update",
  "--disable-client-side-phishing-detection", "--disable-sync", "--metrics-recording-only", "--disable-default-apps", "--mute-audio",
  "--no-default-browser-check", "--no-first-run", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding",
  "--disable-background-timer-throttling", "--disable-ipc-flooding-protection", "--password-store=basic", "--use-mock-keychain",
  "--force-fieldtrials=*BackgroundTracing/default/", "--disable-hang-monitor", "--disable-prompt-on-repost", "--disable-domain-reliability",
  "--propagate-iph-for-testing", "--enable-unsafe-extension-debugging", "--remote-allow-origins=*", "--enable-features=WebMCPTesting,DevToolsWebMCPSupport",
];

/** The arguments Chrome is started with: headless, a debugging port on 127.0.0.1 that Chrome picks, the profile given. */
export function chromeArgs(userDataDir: string, options: { sandbox?: boolean } = {}): string[] {
  return [...CHROME_FLAGS, ...(options.sandbox === false ? ["--no-sandbox"] : []), "--headless=new", "--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1", `--user-data-dir=${userDataDir}`, "--window-size=1288,711", "about:blank"];
}

export type RunChrome = { pid: number; endpoint: string; stop(): Promise<void> };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The profile restores its last session, so Chrome keeps a site's session cookies (a sign-in that ends "when the
 *  browser closes") across the runs that open it. Chrome rewrites Preferences; only this one setting is changed. */
async function keepSessionCookies(userDataDir: string): Promise<void> {
  const file = join(userDataDir, "Default", "Preferences");
  await mkdir(join(userDataDir, "Default"), { recursive: true, mode: 0o700 });
  const prefs = JSON.parse(await readFile(file, "utf8").catch(() => "{}")) as { session?: Record<string, unknown> };
  if (prefs.session?.restore_on_startup === 1) return;
  await writeFile(file, JSON.stringify({ ...prefs, session: { ...prefs.session, restore_on_startup: 1 } }), { mode: 0o600 });
}

/** Ask the browser to close itself over its debugging socket: Chrome writes its cookies to disk only on a clean close. */
async function closeGracefully(endpoint: string): Promise<void> {
  const { webSocketDebuggerUrl } = (await (await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(2_000) })).json()) as { webSocketDebuggerUrl?: string };
  if (!webSocketDebuggerUrl) return;
  const socket = new WebSocket(webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => ((socket.onopen = () => resolve()), (socket.onerror = () => reject(new Error("the browser's socket did not open")))));
  socket.send(JSON.stringify({ id: 1, method: "Browser.close" }));
}

/** Start Chrome on `userDataDir` (created 0700) and wait for its debugging port, read from the profile's own
 *  `DevToolsActivePort`. `stop` closes that browser cleanly, then ends that process by its pid if it is still there,
 *  and no other. An abort of `signal` before the port is known stops the Chrome being started, by its pid, and rejects:
 *  a launcher told to stop while Chrome starts leaves no Chrome holding the profile. */
export async function startChrome(executablePath: string, userDataDir: string, options: { sandbox?: boolean; readyMs?: number; signal?: AbortSignal } = {}): Promise<RunChrome> {
  options.signal?.throwIfAborted();
  await mkdir(userDataDir, { recursive: true, mode: 0o700 });
  await keepSessionCookies(userDataDir);
  const portFile = join(userDataDir, "DevToolsActivePort");
  // A file left by an earlier Chrome names a browser that is not this one.
  await rm(portFile, { force: true });
  const child = spawn(executablePath, chromeArgs(userDataDir, options), { stdio: "ignore" });
  let exited: string | null = null;
  child.once("error", (error) => void (exited = error.message));
  child.once("exit", (code, signal) => void (exited ??= `Chrome exited (${signal ?? code})`));
  let endpoint = "";
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const gone = new Promise((resolve) => child.once("exit", resolve));
    const within = (ms: number) => Promise.race([gone.then(() => true), sleep(ms).then(() => false)]);
    const asked = endpoint ? await closeGracefully(endpoint).then(() => true, () => false) : false;
    if (!asked || !(await within(5_000))) {
      child.kill("SIGTERM");
      if (!(await within(5_000))) child.kill("SIGKILL");
    }
    await gone;
  };
  for (const deadline = Date.now() + (options.readyMs ?? 20_000); ; await sleep(100)) {
    if (exited) throw new Error(`Chrome did not start: ${exited}`);
    if (options.signal?.aborted) {
      await stop();
      throw options.signal.reason;
    }
    const port = Number((await readFile(portFile, "utf8").catch(() => "")).split("\n")[0]);
    if (Number.isInteger(port) && port > 0) {
      endpoint = `http://127.0.0.1:${port}`;
      return { pid: child.pid!, endpoint, stop };
    }
    if (Date.now() > deadline) {
      await stop();
      throw new Error("Chrome did not open its debugging port");
    }
  }
}
