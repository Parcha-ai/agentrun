// The cloud host's link back to the demo server, for a host that cannot reach the model endpoint (a sandbox outside
// the server's network). The host never dials out: it listens, and the server connects in (through the sandbox's
// authenticated port proxy) with a bearer token. Over that one WebSocket the host's model calls go to the server, which
// makes them with its own credentials and the run's budget, exactly as it does for a tab.
//
// The agent's provider talks plain HTTP to a relay on 127.0.0.1 in this process; the relay turns each request into a
// `model` frame and streams the answer back from `model-head`, `model-chunk` and `model-end` frames. The server may also
// `watch`: the run's agent events then flow back as `event` frames (a snapshot, then one batch per commit), which is how
// a page watches the run while it is here.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { watchEvents } from "@earendil-works/pi-durable";
import type { AgentEventStream, Harness, ConversationId } from "@earendil-works/pi-durable";
import { createHash, timingSafeEqual } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";

type Frame =
  | { t: "model"; id: number; path: string; body: unknown }
  | { t: "model-abort"; id: number }
  | { t: "watch" }
  | { t: "event"; kind: "snapshot" | "events"; data: unknown }
  | { t: "model-head"; id: number; status: number }
  | { t: "model-chunk"; id: number; data: string }
  | { t: "model-end"; id: number; status: number; error?: string };

const same = (a: string, b: string) => timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());

export interface CloudLink {
  /** The OpenAI-compatible base URL the agent's provider uses (`http://127.0.0.1:<port>/v1`). */
  readonly baseUrl: string;
  /** The run is open: a `watch` from the server streams this conversation's events. */
  attach(harness: Harness, conversationId: ConversationId): void;
  close(): Promise<void>;
}

export async function startCloudLink(opts: { port: number; host: string; token: string; waitMs?: number; log?: (event: string, data?: Record<string, unknown>) => void }): Promise<CloudLink> {
  const log = opts.log ?? (() => undefined);
  let link: WebSocket | undefined;
  let linked: () => void = () => undefined;
  let next = 1;
  const open = new Map<number, ServerResponse & { head?: boolean }>();
  let run: { harness: Harness; conversationId: ConversationId } | undefined;
  let watching: { ws: WebSocket; stream: AgentEventStream } | undefined;
  /** A `watch` that came before the run opened; served once it does. */
  let pendingWatch: WebSocket | undefined;
  const watch = async (ws: WebSocket) => {
    if (!run) {
      pendingWatch = ws;
      return;
    }
    await watching?.stream.stop().catch(() => undefined);
    const stream = await watchEvents(run.harness, run.conversationId, ctx);
    watching = { ws, stream };
    const send = (frame: Frame) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(frame));
    send({ t: "event", kind: "snapshot", data: stream.snapshot });
    stream.start(async (events) => void send({ t: "event", kind: "events", data: events }));
  };

  const wss = new WebSocketServer({ host: opts.host, port: opts.port, maxPayload: 64 * 1024 * 1024 });
  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    const auth = String(req.headers.authorization ?? "");
    if (!auth.startsWith("Bearer ") || !same(auth.slice(7), opts.token)) {
      ws.close(4003, "UNAUTHORIZED");
      return;
    }
    link?.close(4001, "REPLACED");
    link = ws;
    log("link.connected");
    linked();
    ws.on("message", (data) => {
      const frame = JSON.parse(String(data)) as Frame;
      if (frame.t === "watch") {
        void watch(ws).catch((error) => log("link.watch-failed", { error: (error as Error).message }));
        return;
      }
      const res = open.get((frame as { id: number }).id);
      if (!res) return;
      if (frame.t === "model-head") {
        res.writeHead(frame.status, { "content-type": frame.status < 400 ? "text/event-stream" : "application/json" });
        res.head = true;
      } else if (frame.t === "model-chunk") {
        if (!res.head) res.writeHead(200, { "content-type": "text/event-stream" });
        res.head = true;
        res.write(frame.data);
      } else if (frame.t === "model-end") {
        if (!res.head) res.writeHead(frame.status, { "content-type": "application/json" });
        if (frame.error && frame.status >= 400) res.write(JSON.stringify({ error: { message: frame.error } }));
        res.end();
        open.delete(frame.id);
      }
    });
    ws.on("close", () => {
      if (watching?.ws === ws) {
        void watching.stream.stop().catch(() => undefined);
        watching = undefined;
      }
      if (link !== ws) return;
      link = undefined;
      log("link.closed");
      for (const [id, res] of open) {
        if (!res.head) res.writeHead(503);
        res.end();
        open.delete(id);
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    wss.once("listening", () => resolve());
    wss.once("error", reject);
  });

  const waitForLink = (ms: number) =>
    link
      ? Promise.resolve(true)
      : new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => resolve(false), ms);
          linked = () => {
            clearTimeout(timer);
            resolve(true);
          };
        });

  const relay = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      const path = (req.url ?? "").replace(/^\/v1\//, "");
      if (req.method !== "POST" || !(await waitForLink(opts.waitMs ?? 30_000)) || !link) {
        res.writeHead(503, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "no link to the model proxy" } }));
        return;
      }
      const id = next++;
      open.set(id, res);
      res.on("close", () => {
        if (open.delete(id)) link?.send(JSON.stringify({ t: "model-abort", id } satisfies Frame));
      });
      link.send(JSON.stringify({ t: "model", id, path, body: JSON.parse(body || "{}") } satisfies Frame));
    });
  });
  await new Promise<void>((resolve) => relay.listen(0, "127.0.0.1", () => resolve()));
  const port = (relay.address() as { port: number }).port;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    attach(harness, conversationId) {
      run = { harness, conversationId };
      if (pendingWatch && pendingWatch === link) void watch(pendingWatch).catch((error) => log("link.watch-failed", { error: (error as Error).message }));
      pendingWatch = undefined;
    },
    async close() {
      link?.close(1000, "bye");
      wss.close();
      await new Promise<void>((r) => relay.close(() => r()));
    },
  };
}
