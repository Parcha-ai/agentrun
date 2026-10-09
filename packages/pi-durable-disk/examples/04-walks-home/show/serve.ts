// The stage's server: the built page, D3's tab app at /tab/ (same origin, so the iframe can postMessage freely), and the
// feed at /api/*. The feed is the scripted player unless SHOW_API names a live one, which is proxied untouched.
// Every response carries COOP/COEP/CORP: Wasmer and MuJoCo WASM need cross-origin isolation, and an iframe document must
// itself satisfy the parent's COEP, so the headers are set on the tab app's files too.
//   SHOW_PIPE_LINK_FILE  a file holding a 03 run link (http://host:port/run/ID#SECRET): the feed is that pipe, watched live
//   SHOW_PIPE_ROLE (operator)  the hello mode the stage connects as: "operator" may switch and ask, "view" only watches
//   SHOW_DESKTOP_LINK_FILE  a 03 run link whose host may have a desktop (default: SHOW_PIPE_LINK_FILE): the stage trades its
//                       secret for a ticket and proxies the picture, so the secret never reaches the page
//   SHOW_ASK_AFTER_SWITCH (0)  1: ask the agent where it is after each completed switch (the v1 switch beat; off, so the v2 chat shows only real turns)
//   SHOW_MODE=operator  the scripted feed waits for commands (switch, fanout, kill, collapse) instead of playing itself
//   SHOW_PORT (8750)  SHOW_HOST (127.0.0.1)  SHOW_API  SHOW_SPEED (1)  SHOW_START (seconds to skip)  SHOW_AUTOKILL (seconds into training, "off" to wait)
//   TAB_DIR  the tab app's dist directory (default: a stub that speaks the protocol)
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { proxyStream, requestTicket } from "./desktop.ts";
import { LiveLink, linkKey } from "./link.ts";
import { isFile, modelDisk, runDisk, type DiskBackend } from "./disk.ts";
import { PipeFeed, type FeedSource } from "./pipe-feed.ts";
import { ReadbackWatcher } from "./readback.ts";
import { ScenarioPlayer } from "./scenario.ts";
import { ScenarioV2 } from "./scenario-v2.ts";
import type { ShowCommand } from "./types.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const PAGE = join(here, "page", "dist");
const STUB = join(here, "page", "stub-tab");
const TAB = process.env.TAB_DIR ? resolve(process.env.TAB_DIR) : STUB;
const POLICY = process.env.POLICY_DIR ? resolve(process.env.POLICY_DIR) : join(here, "page", "policy");
const UPSTREAM = process.env.SHOW_API?.replace(/\/$/, "");
const SPEED = Number(process.env.SHOW_SPEED ?? 1);
const START = Number(process.env.SHOW_START ?? 0);
const autoKill = process.env.SHOW_AUTOKILL === "off" ? null : process.env.SHOW_AUTOKILL ? Number(process.env.SHOW_AUTOKILL) : undefined;

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".map": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webc": "application/octet-stream",
  ".onnx": "application/octet-stream",
  ".bin": "application/octet-stream",
};

function isolate(res: ServerResponse): void {
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("Cache-Control", "no-store");
}

function sendJson(res: ServerResponse, code: number, body: unknown): void {
  res.statusCode = code;
  res.setHeader("content-type", TYPES[".json"]);
  res.end(JSON.stringify(body));
}

function serveFile(root: string, rel: string, res: ServerResponse): void {
  const file = normalize(join(root, rel === "" || rel.endsWith("/") ? `${rel}index.html` : rel));
  // The resolved path must stay inside the root: `..` segments and absolute-looking requests end here.
  if (file !== root && !file.startsWith(root + sep)) return void sendJson(res, 403, { error: "outside root" });
  if (!existsSync(file) || !statSync(file).isFile()) return void sendJson(res, 404, { error: "not found", path: rel });
  res.setHeader("content-type", TYPES[extname(file)] ?? "application/octet-stream");
  res.setHeader("content-length", statSync(file).size);
  createReadStream(file).pipe(res);
}

async function body(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 64_000) throw new Error("body too large");
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const clients = new Set<ServerResponse>();
// The stage's model of the agent's disk for the tab's storage requests: paths to bytes, durable for the life of the
// server, emptied by a `reset` so a new take starts with a fresh disk. A live driver replaces this with the real disk.
// With a pipe feed the disk is the real run's work/ (over the 03 server's route, with the secret this server holds); with the
// scripted feed it is the model. Assigned once the feed exists.
let disk: DiskBackend = modelDisk();
const DISK_PATH = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+){0,3}$/;

async function bytesBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new Error("body too large");
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

/** Every event a source emits goes to every connected page, with its index as the SSE id. */
function relay(source: FeedSource): void {
  source.subscribe((event) => {
    const id = source.events.length - 1;
    for (const c of clients) c.write(`id: ${id}\ndata: ${JSON.stringify(event)}\n\n`);
  });
}

const PIPE_LINK_FILE = process.env.SHOW_PIPE_LINK_FILE;
const TAKE_STATUS = process.env.SHOW_TAKE_STATUS;
const DESKTOP_LINK_FILE = process.env.SHOW_DESKTOP_LINK_FILE ?? PIPE_LINK_FILE;
// The links are followed live: whoever starts the 03 server rewrites the file (a restart, a retake: a new run), and the feed, the
// desktop and the disk all follow it. A link that is not there yet means "no server yet", never a crash.
const pipeLink = PIPE_LINK_FILE ? new LiveLink(PIPE_LINK_FILE) : undefined;
const desktopLink = DESKTOP_LINK_FILE ? (DESKTOP_LINK_FILE === PIPE_LINK_FILE ? pipeLink! : new LiveLink(DESKTOP_LINK_FILE)) : undefined;
const DESKTOP = desktopLink ? () => desktopLink.tryCurrent() : undefined;
let player: FeedSource;
if (pipeLink) {
  const { default: WS } = await import("ws");
  const feed = new PipeFeed({
    resolve: () => {
      const t = pipeLink.tryCurrent();
      return t ? { url: t.wsUrl, run: t.run, token: t.secret, key: linkKey(t) } : undefined;
    },
    // A new run: pages hold the old one's snapshot, so they are told to fetch the new one.
    onReset: () => {
      for (const c of clients) c.write(`event: reset\ndata: {}\n\n`);
    },
    ...(process.env.SHOW_PIPE_ROLE === "view" || process.env.SHOW_PIPE_ROLE === "operator" ? { role: process.env.SHOW_PIPE_ROLE } : {}),
    // Off unless asked: the question after a switch is a v1 beat, and in the v2 chat it would be a turn the user never typed.
    askAfterSwitch: process.env.SHOW_ASK_AFTER_SWITCH === "1",
    trace: process.env.SHOW_PIPE_TRACE === "1",
    connect: (url) => new WS(url, { maxPayload: 64 * 1024 * 1024 }) as never,
    log: (event, data) => console.log(JSON.stringify({ event, ...data })),
  });
  relay(feed);
  await feed.start();
  player = feed;
  // The take server's own read-back of work/ (its --evidence-readback), as notes. SHOW_TAKE_STATUS is its status file; the log it names
  // moves with a retake, so it is looked up each time. Only the three read-back events are read from it (the log also holds the run's link).
  if (TAKE_STATUS) {
    new ReadbackWatcher({
      file: () => {
        try {
          const logFile = (JSON.parse(readFileSync(TAKE_STATUS, "utf8")) as { logFile?: unknown }).logFile;
          return typeof logFile === "string" ? logFile : undefined;
        } catch {
          return undefined;
        }
      },
      run: () => feed.run,
      key: () => {
        const t = pipeLink.tryCurrent();
        return t ? linkKey(t) : undefined;
      },
      feedKey: () => feed.linkKey,
      onNote: (note) => feed.addNote(note),
    }).start();
  }
  // The tab's files are the real run's: its secret stays here, and a write names the tab the pipe says holds the run.
  disk = runDisk(() => pipeLink.tryCurrent(), () => feed.writerTab);
} else {
  player = newPlayer();
}

function newPlayer(start = START, paused = false): ScenarioPlayer | ScenarioV2 {
  // SHOW_SCENARIO=v2: the rehearsal of the v2 take (a creature drawn in the browser, the agent, a GPU, checkpoints, home).
  const p = process.env.SHOW_SCENARIO === "v2" ? new ScenarioV2() : new ScenarioPlayer({ autoKillAfter: autoKill, operator: process.env.SHOW_MODE === "operator" });
  relay(p);
  // SHOW_START jumps the script forward (seconds), so rehearsal can begin mid-run at real speed.
  p.begin();
  if (start > 0) p.advance(start * 1000);
  if (!paused) p.start(SPEED);
  return p;
}

async function proxy(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
  const init: RequestInit = { method: req.method, headers: { accept: String(req.headers.accept ?? "*/*") } };
  if (req.method === "POST") {
    init.body = await body(req);
    (init.headers as Record<string, string>)["content-type"] = "application/json";
  }
  const lastId = req.headers["last-event-id"];
  if (typeof lastId === "string") (init.headers as Record<string, string>)["last-event-id"] = lastId;
  const upstream = await fetch(`${UPSTREAM}${path}`, init);
  res.statusCode = upstream.status;
  res.setHeader("content-type", upstream.headers.get("content-type") ?? "application/json");
  // The snapshot's event index: the page resumes the stream after it. Dropped, the page replays events it already holds.
  const lastEventId = upstream.headers.get("x-last-event-id");
  if (lastEventId !== null) res.setHeader("x-last-event-id", lastEventId);
  if (!upstream.body) return void res.end();
  const reader = upstream.body.getReader();
  req.on("close", () => void reader.cancel());
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    res.write(value);
  }
  res.end();
}

const server = createServer(async (req, res) => {
  isolate(res);
  const url = new URL(req.url ?? "/", "http://x");
  const path = url.pathname;
  try {
    if (path.startsWith("/api/")) {
      // The host's desktop, if it has one: the secret stays here, the page gets a same-origin picture path.
      if (path === "/api/desktop" && req.method === "GET") {
        if (!DESKTOP) return sendJson(res, 404, { ok: false, reason: "not configured" });
        const target = DESKTOP();
        if (!target) return sendJson(res, 404, { ok: false, reason: "no desktop yet" });
        const t = await requestTicket(target).catch(() => ({ ok: false as const, status: 502 }));
        return t.ok ? sendJson(res, 200, { url: t.url, ttlMs: t.ttlMs }) : sendJson(res, 404, { ok: false, reason: "no desktop yet" });
      }
      if (path.startsWith("/api/disk/")) {
        const key = decodeURIComponent(path.slice("/api/disk/".length));
        if (!DISK_PATH.test(key) || key.split("/").includes("..")) return sendJson(res, 400, { error: "bad path" });
        if (req.method === "PUT") {
          const w = await disk.write(key, await bytesBody(req, 16 * 1024 * 1024));
          return w.status === 200 ? sendJson(res, 200, { ok: true, bytes: (w as { bytes: number }).bytes }) : sendJson(res, w.status, { ok: false, error: (w as { error: string }).error });
        }
        if (req.method === "GET") {
          const r = await disk.read(key, typeof req.headers["if-none-match"] === "string" ? req.headers["if-none-match"] : undefined);
          // 204, not 404: a first read of a file that does not exist yet is normal and must not log a console error.
          if (r.status === 204) return void res.writeHead(204).end();
          if (r.status === 304) return void res.writeHead(304, { etag: (r as { etag: string }).etag }).end();
          if (isFile(r)) return void res.writeHead(200, { "content-type": "application/octet-stream", etag: r.etag, "content-length": String(r.bytes.length) }).end(r.bytes);
          return sendJson(res, r.status, { ok: false, error: (r as { error: string }).error });
        }
        return sendJson(res, 405, { error: "GET or PUT" });
      }
      // What this stage serves the home beat from, for the preflight's probe (SHOW_URL): a pipe feed's tab reads the run's own
      // work/home/policy.json; any other feed's page asks the tab to load /policy/home.json. Names only: no paths, no secrets.
      if (path === "/api/stage" && req.method === "GET") return sendJson(res, 200, { feed: UPSTREAM ? "upstream" : PIPE_LINK_FILE ? "pipe" : "scripted", tab: TAB === STUB ? "stub" : "app" });
      if (UPSTREAM) return await proxy(req, res, path + url.search);
      if (path === "/api/state" && req.method === "GET") {
        res.setHeader("x-last-event-id", String(player.events.length - 1));
        return sendJson(res, 200, player.state);
      }
      if (path === "/api/events" && req.method === "GET") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive", "Cross-Origin-Resource-Policy": "same-origin" });
        // Send the headers now: with no event waiting, they would otherwise not leave until the first one, and a client (an
        // EventSource's onopen, a fetch) would wait on an open stream that has said nothing. A comment line is ignored by EventSource.
        res.write(": stream open\n\n");
        // Replay what the page's snapshot missed: `?after=N` or Last-Event-ID, the index of the last event it has.
        // A reconnect carries Last-Event-ID, which is newer than the `after` the first request was made with, so it wins.
        const after = Number(req.headers["last-event-id"] ?? url.searchParams.get("after") ?? player.events.length - 1);
        for (let i = after + 1; i < player.events.length; i++) res.write(`id: ${i}\ndata: ${JSON.stringify(player.events[i])}\n\n`);
        clients.add(res);
        req.on("close", () => clients.delete(res));
        return;
      }
      // Dev only, scripted feed only: restart the script at `seconds` (used by scripts/storyboard.mjs for stills).
      if (path === "/api/dev/seek" && req.method === "POST") {
        if (PIPE_LINK_FILE) return sendJson(res, 409, { ok: false, message: "a pipe feed has no script to seek" });
        const { seconds, paused } = JSON.parse(await body(req)) as { seconds: number; paused?: boolean };
        player.stop();
        // `paused` freezes the script at exactly `seconds`, so a still shows the moment it was asked for.
        player = newPlayer(Number(seconds) || 0, paused === true);
        for (const c of clients) c.write(`event: reset\ndata: {}\n\n`);
        return sendJson(res, 200, { ok: true });
      }
      if (path === "/api/command" && req.method === "POST") {
        const cmd = JSON.parse(await body(req)) as ShowCommand;
        if (cmd.t === "reset") {
          if (PIPE_LINK_FILE) return sendJson(res, 409, { ok: false, message: "a pipe feed is one run; there is nothing to reset" });
          player.stop();
          disk.reset?.();
          // A reset starts the script over at 0:00; SHOW_START only positions the first boot.
          player = newPlayer(0);
          for (const c of clients) c.write(`event: reset\ndata: {}\n\n`);
          return sendJson(res, 200, { ok: true });
        }
        const r = await player.command(cmd);
        return sendJson(res, r.ok ? 200 : 409, r);
      }
      return sendJson(res, 404, { error: "no such route", path });
    }
    if (path.startsWith("/desktop/") && req.method === "GET") {
      const target = DESKTOP?.();
      if (!target) return sendJson(res, 404, { error: "no desktop configured" });
      return await proxyStream(target, path, req, res);
    }
    if (path === "/tab") {
      res.statusCode = 301;
      res.setHeader("location", "/tab/");
      return void res.end();
    }
    if (path.startsWith("/tab/")) return serveFile(TAB, decodeURIComponent(path.slice(5)), res);
    if (path.startsWith("/policy/")) return serveFile(POLICY, decodeURIComponent(path.slice(8)), res);
    return serveFile(PAGE, decodeURIComponent(path.slice(1)), res);
  } catch (error) {
    sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

const port = Number(process.env.SHOW_PORT ?? 8750);
const host = process.env.SHOW_HOST ?? "127.0.0.1";
server.listen(port, host, () => {
  console.log(`show: http://${host}:${port}/  feed=${UPSTREAM ?? (PIPE_LINK_FILE ? "pipe" : "scripted")}  tab=${TAB === STUB ? "stub" : TAB}`);
});
