// The owner watches a run's browser live. The run's process serves pi-browser's own viewer (createLiveView, read-only) on
// an ephemeral loopback port of its own, for every provider: the vendors' own live-view URLs never leave that process.
// As each session launches, the process hands its viewer to the server in one file in the run's directory, outside work/
// (BROWSER_LIVE_FILE, 0600, written whole and renamed into place): the port, the viewer's path id, its token and the
// session's tag. The file goes when the session is released, and the token dies with it (pi-browser kills it then).
//
// The server reads the file for the owner alone (GET /v2/runs/{id}/browser) and proxies the viewer under the run's path
// (/v2/runs/{id}/browser/live/*), HTTP and the WebSocket upgrade, to that port alone, and to nothing else: the viewer's
// page under a CSP whose frame-ancestors is 'self' (the console's own origin), the upgrade only from this server's own
// origin. The token is never in a record, a timeline row, a run's view, its files (work/ alone is served), the model's
// context, a home, an export or an archive: only this file and the owner's answer hold it.
import { randomBytes } from "node:crypto";
import { lstat, readFile, rename, rm, writeFile } from "node:fs/promises";
import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { connect } from "node:net";
import { join } from "node:path";
import type { Duplex } from "node:stream";

/** The hand-over file in the run's directory (never in work/). */
export const BROWSER_LIVE_FILE = "browser-live.json";
/** What the run's process hands the server for its newest session's viewer. */
export type LiveHandover = { port: number; id: string; token: string; tag: string };

/** Where the run's own viewer listens: its process's loopback address alone. */
const LOOPBACK = "127.0.0.1"; // key-gate: loopback-rule the one address the run process viewer listens on
/** pi-browser's viewer path id and token. */
const VIEWER_ID = /^[A-Za-z0-9_-]{22}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const TAG = /^[A-Za-z0-9._:-]{1,200}$/;

/** The viewer `fullscreen` URL pi-browser's live view gives (an http URL on the loopback address, /v/<id>#t=<token>) for session `tag`, as
 *  a hand-over; undefined for any other shape (a vendor's own URL never is one). */
export function handoverOf(fullscreen: string, tag: string): LiveHandover | undefined {
  let url: URL;
  try {
    url = new URL(fullscreen);
  } catch {
    return undefined;
  }
  const id = /^\/v\/([^/]+)$/.exec(url.pathname)?.[1];
  const token = new URLSearchParams(url.hash.slice(1)).get("t") ?? "";
  const port = Number(url.port);
  if (url.protocol !== "http:" || url.hostname !== LOOPBACK || !Number.isInteger(port) || port < 1 || port > 65_535 || !id || !VIEWER_ID.test(id) || !TOKEN.test(token) || !TAG.test(tag)) return undefined;
  return { port, id, token, tag };
}

/** Writes `handover` into `runDir`: whole, 0600, under a name of its own first, then renamed over the last. */
export async function writeHandover(runDir: string, handover: LiveHandover): Promise<void> {
  const making = join(runDir, `.${BROWSER_LIVE_FILE}.${randomBytes(6).toString("hex")}`);
  await writeFile(making, `${JSON.stringify(handover)}\n`, { mode: 0o600, flag: "wx" });
  try {
    await rename(making, join(runDir, BROWSER_LIVE_FILE));
  } catch (error) {
    await rm(making, { force: true });
    throw error;
  }
}

/** Removes the hand-over when it is session `tag`'s (any, with none given): a later session's stays. */
export async function dropHandover(runDir: string, tag?: string): Promise<void> {
  if (tag !== undefined && (await readHandover(runDir))?.tag !== tag) return;
  await rm(join(runDir, BROWSER_LIVE_FILE), { force: true });
}

/** The hand-over in `runDir`, or undefined: none, not a plain file of this user's (a link, another mode), or not one. */
export async function readHandover(runDir: string): Promise<LiveHandover | undefined> {
  const file = join(runDir, BROWSER_LIVE_FILE);
  try {
    const at = await lstat(file);
    if (!at.isFile() || (at.mode & 0o077) !== 0 || (process.getuid && at.uid !== process.getuid())) return undefined;
    const value = JSON.parse(await readFile(file, "utf8")) as Partial<LiveHandover>;
    const ok = Number.isInteger(value.port) && value.port! > 0 && value.port! < 65_536 && VIEWER_ID.test(String(value.id)) && TOKEN.test(String(value.token)) && TAG.test(String(value.tag));
    return ok ? { port: value.port!, id: value.id!, token: value.token!, tag: value.tag! } : undefined;
  } catch {
    return undefined;
  }
}

/** Where the viewer answers through the server, for run `runId`: the owner's link, its token in the fragment. */
export const viewerLink = (runId: string, handover: LiveHandover): string => `/v2/runs/${encodeURIComponent(runId)}/browser/live/v/${handover.id}#t=${handover.token}`;

/** The run's viewer answers at its port for this session: its page is there (200), not released (404). Bounded: a dead
 *  process's port answers nothing, or another listener's 404. */
export function viewerAnswers(handover: LiveHandover, ms = 1_000): Promise<boolean> {
  return new Promise((resolve) => {
    const req = httpRequest({ host: LOOPBACK, port: handover.port, method: "HEAD", path: `/v/${handover.id}`, timeout: ms }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(false));
    req.end();
  });
}

/** The viewer's page and files under the run's path: only `rest` ("/v/<id>", "/viewer.js", "/viewer.css") reaches the run's
 *  port, with no header of the owner's (no cookie, no Authorization); the answer carries this route's own CSP, framed by
 *  this server's own origin alone. */
export const LIVE_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";
const LIVE_REST = /^\/(v\/[A-Za-z0-9_-]{22}|viewer\.js|viewer\.css)$/;
export const liveRest = (rest: string): boolean => LIVE_REST.test(rest);

export function proxyLiveHttp(req: IncomingMessage, res: ServerResponse, handover: LiveHandover, rest: string): Promise<void> {
  return new Promise((resolve) => {
    const upstream = httpRequest({ host: LOOPBACK, port: handover.port, method: req.method === "HEAD" ? "HEAD" : "GET", path: rest, headers: { host: `${LOOPBACK}:${handover.port}` }, timeout: 10_000 }, (answer) => {
      const type = String(answer.headers["content-type"] ?? "text/plain");
      res.writeHead(answer.statusCode ?? 502, { "content-type": type, "content-security-policy": LIVE_CSP, "referrer-policy": "no-referrer", "cache-control": "no-store", "x-content-type-options": "nosniff" });
      answer.pipe(res);
      answer.once("end", () => resolve());
      answer.once("error", () => (res.destroy(), resolve()));
    });
    upstream.on("timeout", () => upstream.destroy());
    // A client that leaves mid-answer takes the request to the run with it.
    res.once("close", () => { if (!res.writableFinished) upstream.destroy(); });
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain", "content-security-policy": LIVE_CSP, "cache-control": "no-store" });
      res.end("the run's browser view did not answer\n");
      resolve();
    });
    upstream.end();
  });
}

/** The viewer's WebSocket to the run's port: the request line and the handshake's own headers, the Host and Origin the
 *  run's viewer takes (its own), and nothing else of the owner's (no cookie); then both ways, unread. */
export function proxyLiveUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, handover: LiveHandover, rest: string): void {
  const key = String(req.headers["sec-websocket-key"] ?? "");
  const version = String(req.headers["sec-websocket-version"] ?? "");
  if (!/^[A-Za-z0-9+/]{22}==$/.test(key) || version !== "13") return void socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
  const upstream = connect({ host: LOOPBACK, port: handover.port });
  const end = () => {
    socket.destroy();
    upstream.destroy();
  };
  upstream.once("connect", () => {
    const own = `${LOOPBACK}:${handover.port}`;
    upstream.write(`GET ${rest} HTTP/1.1\r\nHost: ${own}\r\nOrigin: http://${own}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    if (head.length) upstream.write(head);
    upstream.pipe(socket).pipe(upstream);
  });
  upstream.on("error", () => {
    if (socket.writable) socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    upstream.destroy();
  });
  socket.on("error", end);
  socket.on("close", () => upstream.destroy());
  upstream.on("close", () => socket.destroy());
}
