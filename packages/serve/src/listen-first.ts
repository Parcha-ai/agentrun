// The address first. The server's CLI binds its port here, before it loads the rest of the server: on a slow disk (a cold
// start, a loaded machine), loading the server's modules is most of a start, and the store, the harness probes and Docker
// come after it. Until the server takes this socket over (ServeOptions.listener), every request is answered here: the
// server is warming. GET /v2/health says so (503, status "warming", the store "opening"), the API answers 503
// `unavailable` with a Retry-After, and a browser gets a page that reloads itself. Only node's own modules load here.
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { statfs } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { networkInterfaces } from "node:os";
import type { Duplex } from "node:stream";

/** The port a server takes when none is named: the first free one from here (cli.ts). */
export const DEFAULT_PORT = 7340;
/** The address a server listens on when none is named: this machine only. */
export const DEFAULT_HOST = "127.0.0.1";
/** The free disk under the data directory below which GET /v2/health fails, in MiB, unless AGENTRUN_MIN_FREE_MB says. */
export const MIN_FREE_MIB = 64;
/** How long a warming answer asks its caller to wait before it asks again (Retry-After), and the page's reload. */
export const WARMING_RETRY_S = 2;

/** AGENTRUN_MIN_FREE_MB as MiB (MIN_FREE_MIB when unset), or undefined when it is no number of MiB, 0 or more. */
export function minFreeMibOf(env: NodeJS.ProcessEnv): number | undefined {
  const mib = env.AGENTRUN_MIN_FREE_MB ? Number(env.AGENTRUN_MIN_FREE_MB) : MIN_FREE_MIB;
  return Number.isFinite(mib) && mib >= 0 ? mib : undefined;
}

/** `server` listening on `host`, from port `first`; with `nextFreePort`, a taken port passes to the next, up to 99 past
 *  `first`. Each attempt takes off both its handlers when it ends, so a taken port leaves no listener behind. */
export async function listenOn(server: Server, host: string, first: number, nextFreePort: boolean): Promise<void> {
  const last = nextFreePort && first !== 0 ? Math.min(first + 99, 65_535) : first;
  for (let port = first; ; port++) {
    try {
      await new Promise<void>((done, reject) => {
        const onError = (error: Error) => (server.off("listening", onListening), reject(error));
        const onListening = () => (server.off("error", onError), done());
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, host);
      });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
      if (port < last) continue;
      throw last > first ? Object.assign(new Error(`every port from ${first} to ${last} on ${host} is taken`), { code: "EADDRINUSE" }) : error;
    }
  }
}

// A container network's bridge (Docker's, a VM's) is this machine's alone: no other machine reaches it there.
const BRIDGES = /^(docker|br-|veth|virbr|cni|flannel|vmnet|bridge\d)/;
const inContainer = () => existsSync("/.dockerenv") || existsSync("/run/.containerenv");

/** Where a server listening on every address (`host` 0.0.0.0 or ::) at `port` is reached from another machine: this
 *  machine's own IPv4 addresses, loopback, link-local and container bridges left out, at most three. None for a server on one address, and
 *  none in a container, whose addresses are its own network's, not the ones its host publishes the port on. The
 *  addresses are read (`interfaces`) only for a server that prints them, and one whose machine cannot list them prints
 *  none: the links are a convenience, never a reason not to start. */
export function elsewhereOf(
  host: string,
  port: number,
  { interfaces = networkInterfaces, container = inContainer }: { interfaces?: () => ReturnType<typeof networkInterfaces>; container?: () => boolean } = {},
): string[] {
  if (host !== "0.0.0.0" && host !== "::") return [];
  let found: ReturnType<typeof networkInterfaces>;
  try {
    if (container()) return [];
    found = interfaces();
  } catch {
    return [];
  }
  const addresses = Object.entries(found).filter(([name]) => !BRIDGES.test(name)).flatMap(([, list]) => (list ?? []).filter((one) => one.family === "IPv4" && !one.internal && !one.address.startsWith("169.254.")).map((one) => one.address));
  return [...new Set(addresses)].slice(0, 3).map((address) => `http://${address}:${port}`);
}

/** The URL a listening `server` on `host` is reached at on this machine: an address of every interface at its loopback one. */
export function urlOf(server: Server, host: string): string {
  const shown = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  return `http://${shown.includes(":") ? `[${shown}]` : shown}:${(server.address() as AddressInfo).port}`;
}

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta http-equiv="refresh" content="${WARMING_RETRY_S}"><meta name="color-scheme" content="light dark"><title>AgentRun is starting</title></head>
<body style="font-family: ui-monospace, SFMono-Regular, Menlo, monospace; margin: 3rem"><p>AgentRun is starting. This page reloads until it is ready.</p></body></html>
`;

/** The warming answer to one request: health, a browser's page, or the API's 503. Nothing in it is the server's: no
 *  token, no data, so it needs no Host check. */
function warming(data: string, minFreeBytes: number | undefined) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    res.setHeader("x-request-id", `req_${randomBytes(8).toString("hex")}`);
    res.setHeader("retry-after", String(WARMING_RETRY_S));
    res.setHeader("cache-control", "no-store");
    const path = (req.url ?? "/").split("?")[0]!;
    const json = (body: unknown) => {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    req.resume();
    if (path === "/v2/health") {
      void statfs(data).then((fs) => fs.bavail * fs.bsize, () => undefined).then((free) => {
        const disk = free === undefined || minFreeBytes === undefined ? "cannot_check" : free >= minFreeBytes ? "ok" : "below_floor";
        json({ status: "warming", checks: { store: "opening", disk } });
      });
      return;
    }
    if (req.method === "GET" && !path.startsWith("/v2/") && /\btext\/html\b/i.test(String(req.headers.accept ?? ""))) {
      res.writeHead(503, { "content-type": "text/html; charset=utf-8" });
      res.end(PAGE);
      return;
    }
    json({ error: { code: "unavailable", message: `AgentRun is starting: its store is opening. Send the request again in ${WARMING_RETRY_S} s.`, retryable: true, request_id: res.getHeader("x-request-id") } });
  };
}

/** A WebSocket asked for while warming: refused, to be asked again. */
function warmingUpgrade(_req: IncomingMessage, socket: Duplex): void {
  socket.on("error", () => socket.destroy());
  socket.end(`HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nRetry-After: ${WARMING_RETRY_S}\r\nContent-Length: 0\r\n\r\n`);
}

/** A server bound on `host` at `port`, answering warming (above) until `takeOver`. Undefined when that port is taken: the
 *  port is then left to the start's own listen, which waits for a server it replaces (a restart, a redeploy) to let go of
 *  the data directory first, and only then takes the port, or passes to the next free one, as it always has. Any other
 *  failure to listen throws. */
export async function listenFirst(o: { host: string; port: number; data: string; env: NodeJS.ProcessEnv }): Promise<Server | undefined> {
  const mib = minFreeMibOf(o.env);
  const server = createServer(warming(o.data, mib === undefined ? undefined : mib * 2 ** 20));
  // A request's headers come within 10 s, as the server's own listener has them.
  server.headersTimeout = 10_000;
  server.on("upgrade", warmingUpgrade);
  try {
    await listenOn(server, o.host, o.port, false);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") return undefined;
    throw error;
  }
  return server;
}

/** The server's own handlers on `server` from now on, in place of the warming ones: a request already being answered
 *  finishes as it began. */
export function takeOver(server: Server, onRequest: (req: IncomingMessage, res: ServerResponse) => void, onUpgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => void): void {
  server.removeAllListeners("request");
  server.removeAllListeners("upgrade");
  server.on("request", onRequest);
  server.on("upgrade", onUpgrade);
}
