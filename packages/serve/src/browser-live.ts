// The owner watches a run's browser live, and takes it over (browser-person.ts). The run's process runs pi-browser's own
// viewer (createLiveView, take-over) on an ephemeral loopback port of its own, for every provider: the vendors' own live-view URLs never leave that process.
// As each session launches, the process hands its viewer to the server in a file of that session's own, in a directory in
// the run's directory, outside work/ (BROWSER_LIVE_DIR/<tag>.json, 0600 in 0700, written whole and renamed into place):
// the port, the viewer's path id, its token, the session's tag and when. Its own file goes when the session is released,
// and the token dies with it (pi-browser kills it then); a session's release never touches another's file, so an old
// session's release that crosses a new one's launch (a relaunch) leaves the new one handed over.
//
// The server reads the newest for the owner alone (GET /v2/runs/{id}/browser) and answers the viewer under the run's path
// (/v2/runs/{id}/browser/live/*). The viewer's code (its page, script and style) is always this server's own, the files of
// the pi-browser it has installed, never anything a run's port answers: a run's port only ever carries the viewer's
// WebSocket, data and no code, proxied to that port alone and only from this server's own origin. The page is served
// under a CSP whose frame-ancestors is 'self' (the console's own origin). The token is never in a record, a timeline row, a run's view, its files (work/ alone is served), the model's
// context, a home, an export or an archive: only this file and the owner's answer hold it.
import { randomBytes } from "node:crypto";
import type { Stats } from "node:fs";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rm, writeFile } from "node:fs/promises";
import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { connect } from "node:net";
import { join } from "node:path";
import type { Duplex } from "node:stream";

/** The hand-over directory in the run's directory (never in work/): one file per open session. */
export const BROWSER_LIVE_DIR = "browser-live";
/** What the run's process hands the server for one session's viewer; `at`, when (the newest is the one shown). */
export type LiveHandover = { port: number; id: string; token: string; tag: string; at?: number };

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

/** Whether `at` is this user's alone, and not a link: a directory (0700) or a file (0600). */
const ownAlone = (at: Stats, dir: boolean): boolean => (dir ? at.isDirectory() : at.isFile()) && !at.isSymbolicLink() && (at.mode & 0o077) === 0 && (!process.getuid || at.uid === process.getuid());

/** Writes `handover` into `runDir` as its session's own file: whole, 0600, under a name of its own first, then renamed
 *  into place. The time it was handed over goes with it. */
export async function writeHandover(runDir: string, handover: LiveHandover): Promise<void> {
  if (!TAG.test(handover.tag)) throw new Error("a hand-over's tag is not a session's tag");
  const dir = join(runDir, BROWSER_LIVE_DIR);
  await mkdir(dir, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  if (!ownAlone(await lstat(dir), true)) throw new Error("the run's live view directory is not this user's alone");
  const making = join(dir, `.${randomBytes(6).toString("hex")}.tmp`);
  await writeFile(making, `${JSON.stringify({ ...handover, at: handover.at ?? Date.now() })}\n`, { mode: 0o600, flag: "wx" });
  try {
    await rename(making, join(dir, `${handover.tag}.json`));
  } catch (error) {
    await rm(making, { force: true });
    throw error;
  }
}

/** Removes session `tag`'s hand-over, and no other's; with no tag, every one (the run's process let its sessions go). */
export async function dropHandover(runDir: string, tag?: string): Promise<void> {
  if (tag === undefined) return void (await rm(join(runDir, BROWSER_LIVE_DIR), { recursive: true, force: true }));
  if (TAG.test(tag)) await rm(join(runDir, BROWSER_LIVE_DIR, `${tag}.json`), { force: true });
}

/** Every hand-over in `runDir`, newest first: each a plain file of this user's alone in a directory of this user's alone
 *  (not a link), and one; anything else is left out. */
export async function readHandovers(runDir: string): Promise<LiveHandover[]> {
  const dir = join(runDir, BROWSER_LIVE_DIR);
  try {
    if (!ownAlone(await lstat(dir), true)) return [];
    const found: LiveHandover[] = [];
    for (const name of await readdir(dir)) {
      if (!name.endsWith(".json") || !TAG.test(name.slice(0, -5))) continue;
      const file = join(dir, name);
      try {
        // Opened without following a link, and checked on the handle it read: a name swapped meanwhile reads nothing.
        const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
        let text: string;
        try {
          if (!ownAlone(await handle.stat(), false)) continue;
          text = await handle.readFile("utf8");
        } finally {
          await handle.close();
        }
        const value = JSON.parse(text) as Partial<LiveHandover>;
        const ok = Number.isInteger(value.port) && value.port! > 0 && value.port! < 65_536 && VIEWER_ID.test(String(value.id)) && TOKEN.test(String(value.token)) && value.tag === name.slice(0, -5) && Number.isFinite(value.at);
        if (ok) found.push({ port: value.port!, id: value.id!, token: value.token!, tag: value.tag!, at: value.at! });
      } catch {
        // gone meanwhile, or not one
      }
    }
    return found.sort((a, b) => b.at! - a.at! || b.tag.localeCompare(a.tag));
  } catch {
    return [];
  }
}

/** The newest hand-over in `runDir`, or undefined. */
export const readHandover = async (runDir: string): Promise<LiveHandover | undefined> => (await readHandovers(runDir))[0];
/** The hand-over of the viewer whose path id is `id`, or undefined. */
export const handoverById = async (runDir: string, id: string): Promise<LiveHandover | undefined> => (await readHandovers(runDir)).find((handover) => handover.id === id);

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

/** The viewer's page and files under the run's path ("/v/<id>", "/viewer.js", "/viewer.css"): this server's own copy of
 *  pi-browser's viewer, never the run's port's answer, under this route's own CSP, framed by this server's own origin alone.
 *  The page reads the viewer's id from its path and its token from the fragment, as pi-browser's own does. */
export const LIVE_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";
const LIVE_REST = /^\/(v\/[A-Za-z0-9_-]{22}|viewer\.js|viewer\.css)$/;
export const liveRest = (rest: string): boolean => LIVE_REST.test(rest);

export async function serveViewerFile(req: IncomingMessage, res: ServerResponse, rest: string): Promise<void> {
  const { viewerAssets } = await import("@parcha/pi-browser/live-view");
  const [type, body] = rest === "/viewer.js" ? ["text/javascript; charset=utf-8", viewerAssets.js] : rest === "/viewer.css" ? ["text/css; charset=utf-8", viewerAssets.css] : ["text/html; charset=utf-8", viewerAssets.html];
  res.writeHead(200, { "content-type": type, "content-length": Buffer.byteLength(body), "content-security-policy": LIVE_CSP, "referrer-policy": "no-referrer", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(req.method === "HEAD" ? undefined : body);
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
  // A WebSocket is never half open: either side ending ends both, so a run's port that never closes its side keeps
  // neither socket open.
  socket.once("end", end);
  upstream.once("end", end);
  socket.on("close", () => upstream.destroy());
  upstream.on("close", () => socket.destroy());
}
