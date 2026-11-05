// The browser on a Chrome on the server's own host: only where the operator starts AgentRun with one (`--browser-chrome
// PATH`, tool-plane.ts LOCAL_CHROME_ENV) and a run's browser resolves to `chrome`, never `auto`'s pick. The run's process
// starts it through pi-browser's cdp provider: headless, Chrome's own sandbox on, a fresh profile of its own under the
// run's directory (removed as each session ends; nothing is loaded into it), on a loopback debugging port picked free
// for it, stopped by its exact pid; never a Chrome that is already running, and never one at a port anything else names.
// Its sandbox is never turned off: a Chrome that cannot start it here is refused at the server's start (checkChrome),
// and a session whose Chrome cannot start it later is refused in words that say so. Its network is held to public
// addresses by the kernel's egress proxy (box-egress.ts browserEgress), which every request it makes goes through:
// loopback included (`<-loopback>` takes away the bypass Chrome gives it by default) but Chrome's own DevTools socket,
// so this server, the machine's other services, private networks and a cloud's metadata address are each refused.
// Chrome resolves no name or address itself but the proxy's and its own socket's, speaks no QUIC, and sends WebRTC over
// no UDP. It keeps no saved sign-in: a session that asks for a profile is refused by name, and the provider offers a
// session vault nothing, so nothing sealed is ever handed to it.
import { spawn } from "node:child_process";
import { constants, existsSync } from "node:fs";
import { access, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { browserEgress } from "./box-egress.js";
import { LOCAL_CHROME_ENV } from "./tool-plane.js";

/** Where a run's local Chrome keeps its sessions' profiles: under the run's own directory. */
export const CHROME_PROFILES = "browser-chrome";

/** The arguments that hold a local Chrome to the proxy at `proxy` (an http URL of a loopback port), its own DevTools socket
 *  on `debuggingPort`: every request through the proxy, loopback too (`<-loopback>`), but Chrome's own socket, which
 *  Stagehand's extension in it dials (pi-browser opens it to that extension's Origin alone); and no name or address
 *  resolved by Chrome itself but those two, so even a request a page or a browser context sends around the proxy reaches
 *  nothing (the proxy resolves and checks each name); no QUIC, which goes around an HTTP proxy; and WebRTC on no UDP but
 *  the proxy's, which carries none, so no ICE candidate is gathered and no STUN packet leaves. That last is
 *  `--webrtc-ip-handling-policy`: Chrome 155 and 156 ignore the `--force-` spelling (measured: a STUN server on loopback
 *  is sent its binding requests under it). */
export function chromeFence(proxy: string, debuggingPort: number): string[] {
  const { hostname, port } = new URL(proxy);
  const own = (at: string) => `MAP ${at} ${at}`;
  return [
    `--proxy-server=${proxy}`,
    `--proxy-bypass-list=<-loopback>;${hostname}:${debuggingPort}`,
    `--host-resolver-rules=${own(`${hostname}:${port}`)}, ${own(`${hostname}:${debuggingPort}`)}, MAP * ~NOTFOUND`,
    "--disable-quic",
    "--webrtc-ip-handling-policy=disable_non_proxied_udp",
  ];
}

/** What a session whose Chrome could not start its sandbox is told (the model, and through it the person): never to turn
 *  it off, which no one here can. */
export const NO_SANDBOX = "This server's Chrome could not start its sandbox, and the local Chrome never runs without it, so no session was started. Ask the server's operator to let Chrome start its sandbox on this machine.";

/** How long the start's sandbox check may take: one headless Chrome that loads a blank page and exits. */
export const CHECK_MS = 30_000;

/** The Chrome the operator gives the browser (`--browser-chrome`), resolved, or none: refused, before anything starts,
 *  unless it is an executable file that starts here with Chrome's sandbox on. As root it does not (Chrome refuses root
 *  with its sandbox on); on a machine that confines unprivileged user namespaces (Ubuntu 23.10 and later) a Chrome with
 *  no AppArmor profile does not either. The check starts it once, headless, on a blank page, in a profile of its own
 *  that goes with it, with a proxy no name or address reaches, so nothing leaves the machine. The words never offer to
 *  turn the sandbox off. `uid`: the user the server runs as (a test's seam). */
export async function checkChrome(path: string | undefined, { uid = process.getuid?.() }: { uid?: number } = {}): Promise<string | undefined> {
  if (path === undefined || path === "") return undefined;
  const at = resolve(path);
  const runs = (await stat(at).then((info) => info.isFile(), () => false)) && (await access(at, constants.X_OK).then(() => true, () => false));
  if (!runs) throw new Error(`the browser's Chrome ${at} is not an executable file: name a Chrome or Chromium binary with --browser-chrome (or ${LOCAL_CHROME_ENV}), or leave it out`);
  const fix = `the local Chrome never runs without Chrome's sandbox: let it start here, or leave --browser-chrome (and ${LOCAL_CHROME_ENV}) out`;
  if (uid === 0) throw new Error(`the browser's Chrome cannot start its sandbox while AgentRun runs as root, and ${fix}: run AgentRun as a user that is not root`);
  // A short directory: Chrome's singleton socket under it must stay within a Unix socket's 107 bytes.
  const dir = await mkdtemp(join(existsSync("/tmp") ? "/tmp" : tmpdir(), "agentrun-chrome-check-"));
  try {
    const said = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }>((done) => {
      const child = spawn(at, ["--headless=new", `--user-data-dir=${join(dir, "profile")}`, "--no-first-run", "--proxy-server=http://agentrun-check.invalid:9", "--host-resolver-rules=MAP * ~NOTFOUND", "--dump-dom", "about:blank"], { stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, TMPDIR: dir }, timeout: CHECK_MS, killSignal: "SIGKILL" });
      let stderr = "";
      child.stderr.on("data", (chunk) => void (stderr = (stderr + chunk).slice(-8_192)));
      child.once("error", (error) => done({ code: null, signal: null, stderr: error.message }));
      child.once("exit", (code, signal) => done({ code, signal, stderr }));
    });
    if (said.code === 0) return at;
    // Chrome's own words name the sandbox, and go on to offer --no-sandbox: only the first are passed on.
    const why = /No usable sandbox/.test(said.stderr) ? "No usable sandbox" : said.signal ? `it ended on ${said.signal}` : `it exited ${said.code ?? "without starting"}`;
    throw new Error(`the browser's Chrome ${at} did not start here with its sandbox on (${why}), and ${fix}: on Ubuntu 23.10 and later, give this Chrome an AppArmor profile that allows it user namespaces, or use a Chrome whose setuid sandbox helper is installed`);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** The provider of run `runId`'s browser on the Chrome at `executablePath`, its profiles under `root` (the run's
 *  directory), and `close`, which stops its proxy: called once the run lets its sessions go. */
export async function localChrome(options: { executablePath: string; root: string; runId: string; env: NodeJS.ProcessEnv; log: (line: string) => void }): Promise<{ provider: unknown; close(): Promise<void> }> {
  const egress = await browserEgress(options.runId, options.env, options.log);
  try {
    const [{ cdpProvider }, { BrowserFailureError, browserFailure }] = await Promise.all([import("@parcha/pi-browser/providers/cdp"), import("@parcha/pi-browser")]);
    // `sandbox: true` whatever PI_BROWSER_NO_SANDBOX says, and no seam turns it off.
    const { vault: _vault, ...chrome } = cdpProvider({ chrome: { executablePath: options.executablePath, profileRoot: join(options.root, CHROME_PROFILES), headless: true, sandbox: true, args: ({ debuggingPort }) => chromeFence(egress.url, debuggingPort) } });
    // A session whose Chrome cannot start its sandbox: pi-browser's failure offers to turn it off, which this server
    // never does, so the session is refused in words of its own, and Chrome's own go to the run's log for the operator.
    const create: typeof chrome.create = async (spec, signal) => {
      try {
        return await chrome.create(spec, signal);
      } catch (error) {
        if (!(error instanceof BrowserFailureError && /PI_BROWSER_NO_SANDBOX/.test(error.message))) throw error;
        options.log(`chrome sandbox failed ${error.message.split("\n")[0]}`);
        throw new BrowserFailureError(browserFailure("browser_unavailable", NO_SANDBOX));
      }
    };
    // No saved sign-in on this machine's Chrome: a session that names a profile is refused by name (pi-browser's
    // profileRefusal), as on any provider that keeps none; and no vault target, so no session's state is captured.
    return { provider: { ...chrome, create, caps: { ...chrome.caps, profiles: false } }, close: () => egress.close() };
  } catch (error) {
    await egress.close();
    throw error;
  }
}
