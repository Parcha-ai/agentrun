// The browser on a Chrome on the server's own host: only where the operator starts AgentRun with one (`--browser-chrome
// PATH`, tool-plane.ts LOCAL_CHROME_ENV) and a run's browser resolves to `chrome`, never `auto`'s pick. The run's process
// starts it through pi-browser's cdp provider: headless, Chrome's own sandbox on, its own profile under the run's
// directory (removed as each session ends), on a loopback debugging port picked free for it, stopped by its exact pid;
// never a Chrome that is already running, and never one at a port anything else names. Its network is held to public addresses by
// the kernel's egress proxy (box-egress.ts browserEgress), which every request it makes goes through: loopback included
// (`<-loopback>` takes away the bypass Chrome gives it by default) but Chrome's own DevTools socket, so this server, the
// machine's other services, private networks and a cloud's metadata address are each refused. Chrome resolves no name or
// address itself but the proxy's and its own socket's, speaks no QUIC, and sends WebRTC over no UDP the proxy does not
// carry. It keeps no saved sign-in: a session that asks for a profile is refused by name, and the provider offers a
// session vault nothing, so nothing sealed is ever handed to it.
import { join } from "node:path";
import { browserEgress } from "./box-egress.js";

/** Where a run's local Chrome keeps its sessions' profiles: under the run's own directory. */
export const CHROME_PROFILES = "browser-chrome";

/** The arguments that hold a local Chrome to the proxy at `proxy` (an http URL of a loopback port), its own DevTools socket
 *  on `debuggingPort`: every request through the proxy, loopback too (`<-loopback>`), but Chrome's own socket, which
 *  Stagehand's extension in it dials (pi-browser opens it to that extension's Origin alone); and no name or address
 *  resolved by Chrome itself but those two, so even a request a page or a browser context sends around the proxy reaches
 *  nothing (the proxy resolves and checks each name); no QUIC, which goes around an HTTP proxy; WebRTC on no UDP but the
 *  proxy's (it carries none, so none). */
export function chromeFence(proxy: string, debuggingPort: number): string[] {
  const { hostname, port } = new URL(proxy);
  const own = (at: string) => `MAP ${at} ${at}`;
  return [
    `--proxy-server=${proxy}`,
    `--proxy-bypass-list=<-loopback>;${hostname}:${debuggingPort}`,
    `--host-resolver-rules=${own(`${hostname}:${port}`)}, ${own(`${hostname}:${debuggingPort}`)}, MAP * ~NOTFOUND`,
    "--disable-quic",
    "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
  ];
}

/** The provider of run `runId`'s browser on the Chrome at `executablePath`, its profiles under `root` (the run's
 *  directory), and `close`, which stops its proxy: called once the run lets its sessions go. */
export async function localChrome(options: { executablePath: string; root: string; runId: string; env: NodeJS.ProcessEnv; log: (line: string) => void }): Promise<{ provider: unknown; close(): Promise<void> }> {
  const egress = await browserEgress(options.runId, options.env, options.log);
  try {
    const { cdpProvider } = await import("@parcha/pi-browser/providers/cdp");
    // `sandbox: true` whatever PI_BROWSER_NO_SANDBOX says: a Chrome that cannot start its sandbox here does not start.
    const { vault: _vault, ...chrome } = cdpProvider({ chrome: { executablePath: options.executablePath, profileRoot: join(options.root, CHROME_PROFILES), headless: true, sandbox: true, args: ({ debuggingPort }) => chromeFence(egress.url, debuggingPort) } });
    // No saved sign-in on this machine's Chrome: a session that names a profile is refused by name (pi-browser's
    // profileRefusal), as on any provider that keeps none; and no vault target, so no session's state is captured.
    return { provider: { ...chrome, caps: { ...chrome.caps, profiles: false } }, close: () => egress.close() };
  } catch (error) {
    await egress.close();
    throw error;
  }
}
