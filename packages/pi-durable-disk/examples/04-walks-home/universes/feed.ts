// The stage's feed (show/README.md): every ShowEvent this producer emits, kept in order, folded for `GET /api/state`
// and streamed on `GET /api/events`. An event's SSE id is its index, so a page that fetched the state (header
// `x-last-event-id`) and then subscribes with `?after=N`, or reconnects with Last-Event-ID, misses nothing and sees
// nothing twice. Commands come in on `POST /api/command`; a refused one answers 409 with its reason. Loopback only.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { emptyState, reduce } from "./show/reduce.ts";
import type { ShowEvent, ShowState } from "./show/types.ts";

/** The stage's commands, plus this producer's own: warm the machines, fan out, collapse to a winner. */
export type FeedCommand = { t: "kill"; universe: string } | { t: "switch"; to: string } | { t: "reset" } | { t: "prewarm" } | { t: "fanout" } | { t: "collapse"; winner?: string };

export type CommandResult = { ok: true; [key: string]: unknown } | { ok: false; error: string };

export class Feed {
  readonly events: ShowEvent[] = [];
  #state: ShowState = emptyState();
  readonly #clients = new Set<ServerResponse>();

  get state(): ShowState {
    return this.#state;
  }

  emit(event: ShowEvent): void {
    const id = this.events.length;
    this.events.push(event);
    this.#state = reduce(this.#state, event);
    const frame = `id: ${id}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const c of this.#clients) c.write(frame);
  }

  /** Stream events after index `after` to `res`, then every new one. */
  subscribe(res: ServerResponse, after: number): () => void {
    for (let i = Math.max(-1, after) + 1; i < this.events.length; i++) res.write(`id: ${i}\ndata: ${JSON.stringify(this.events[i])}\n\n`);
    this.#clients.add(res);
    return () => this.#clients.delete(res);
  }

  close(): void {
    for (const c of this.#clients) c.end();
    this.#clients.clear();
  }
}

const sendJson = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
};

async function readBody(req: IncomingMessage, limit = 64 * 1024): Promise<string> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new Error("request body too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export interface FeedServerOptions {
  readonly feed: Feed;
  readonly port: number;
  /** Default 127.0.0.1: the feed is never public. */
  readonly host?: string;
  readonly command: (cmd: FeedCommand) => Promise<CommandResult>;
}

export async function serveFeed(o: FeedServerOptions): Promise<Server & { url: string }> {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://feed");
    try {
      if (url.pathname === "/api/state" && req.method === "GET") {
        res.setHeader("x-last-event-id", String(o.feed.events.length - 1));
        return sendJson(res, 200, o.feed.state);
      }
      if (url.pathname === "/api/events" && req.method === "GET") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
        // A reconnect's Last-Event-ID is newer than the `after` its first request carried, so it wins.
        const after = Number(req.headers["last-event-id"] ?? url.searchParams.get("after") ?? o.feed.events.length - 1);
        const off = o.feed.subscribe(res, Number.isFinite(after) ? after : o.feed.events.length - 1);
        req.on("close", off);
        return;
      }
      if (url.pathname === "/api/command" && req.method === "POST") {
        let cmd: FeedCommand;
        try {
          cmd = JSON.parse(await readBody(req)) as FeedCommand;
        } catch (error) {
          return sendJson(res, 400, { ok: false, error: `not a command: ${(error as Error).message}` });
        }
        const r = await o.command(cmd);
        return sendJson(res, r.ok ? 200 : 409, r);
      }
      return sendJson(res, 404, { error: "no such route", path: url.pathname });
    } catch (error) {
      if (!res.headersSent) sendJson(res, 500, { error: (error as Error).message });
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(o.port, o.host ?? "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : o.port;
  return Object.assign(server, { url: `http://${o.host ?? "127.0.0.1"}:${port}` });
}
