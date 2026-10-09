// The cloud host's link back to the demo server, for a host that cannot reach the model endpoint (a sandbox outside
// the server's network). The host never dials out: it listens, and the server connects in (through the sandbox's
// authenticated port proxy) with a bearer token. Over that one WebSocket the host's model calls go to the server, which
// makes them with its own credentials and the run's budget, exactly as it does for a tab.
//
// The agent's provider talks plain HTTP to a relay on 127.0.0.1 in this process; the relay turns each request into a
// `model` frame and streams the answer back from `model-head`, `model-chunk` and `model-end` frames.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";

type Frame =
  | { t: "model"; id: number; path: string; body: unknown }
  | { t: "model-abort"; id: number }
  | { t: "model-head"; id: number; status: number }
  | { t: "model-chunk"; id: number; data: string }
  | { t: "model-end"; id: number; status: number; error?: string };

const same = (a: string, b: string) => timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());

export interface CloudLink {
  /** The OpenAI-compatible base URL the agent's provider uses (`http://127.0.0.1:<port>/v1`). */
  readonly baseUrl: string;
  close(): Promise<void>;
}

export async function startCloudLink(opts: { port: number; host: string; token: string; waitMs?: number; log?: (event: string, data?: Record<string, unknown>) => void }): Promise<CloudLink> {
  const log = opts.log ?? (() => undefined);
  let link: WebSocket | undefined;
  let linked: () => void = () => undefined;
  let next = 1;
  const open = new Map<number, ServerResponse & { head?: boolean }>();

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
    async close() {
      link?.close(1000, "bye");
      wss.close();
      await new Promise<void>((r) => relay.close(() => r()));
    },
  };
}
