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
import type { Context } from "@earendil-works/chord";
import { RelayHolder, ThreadRelay } from "./thread-relay.ts";
import type { ThreadRef } from "./tab/threads.ts";
import { createGpuClient, isGpuFrame, type GpuClient, type GpuFrame } from "./pipe/gpu-rpc.ts";
import { FrameSwitchChannel, type SwitchRequest } from "./switch-tool.ts";

type Frame =
  | { t: "model"; id: number; path: string; body: unknown }
  | { t: "model-abort"; id: number }
  | { t: "watch" }
  | { t: "event"; kind: "snapshot" | "events" | "thread" | "models"; data: unknown }
  | { t: "model-head"; id: number; status: number }
  | { t: "model-chunk"; id: number; data: string }
  | { t: "model-end"; id: number; status: number; error?: string }
  | SwitchRequest
  | { t: "switch-accepted"; ask: string; switchId: string }
  | { t: "switch-refused"; ask?: string; message: string }
  | { t: "switched"; switchId: string }
  /** A line of the instance's own trail (its lease: slow heartbeat writes, the fence's reason; its health), for the server to keep: it outlives a dead VM. Best effort, never queued behind a slow socket. */
  | { t: "trail"; at: string; event: string; data?: Record<string, unknown> }
  | GpuFrame;

/** The names a registry gave its models, by `provider/modelId` (what the page shows in its header instead of an id). */
export function modelNamesOf(models: { getModels(): readonly { provider: string; id: string; name: string }[] }): Record<string, string> {
  return Object.fromEntries(models.getModels().map((m) => [`${m.provider}/${m.id}`, m.name]));
}

/** Whether a batch of agent events changes which model the agent is on. */
export const changesModel = (events: readonly { type: string }[]): boolean => events.some((e) => e.type === "agent_changed");

/** What `drainTrail` needs of a socket. */
export interface TrailSocket {
  readonly readyState: number;
  readonly OPEN: number;
  readonly bufferedAmount: number;
  send(data: string): void;
}

/** Send held trail lines in order while the socket is open and its buffer is under `limit`; whatever does not fit stays held (a socket that is backed up is not made worse). Never throws. */
export function drainTrail(socket: TrailSocket, held: Frame[], limit: number): void {
  while (held.length > 0 && socket.readyState === socket.OPEN && socket.bufferedAmount < limit) {
    const frame = held.shift()!;
    try {
      socket.send(JSON.stringify(frame));
    } catch {
      // The trail is best effort.
    }
  }
}

const same = (a: string, b: string) => timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());

/** The host's own listing of its teaching threads (cluster/teach-skills.ts threadsOf); with it the link relays each thread's conversation beside the root's. */
export type ThreadsOf = (harness: Harness, context: Context) => Promise<readonly ThreadRef[]>;

export interface CloudLink {
  /** The OpenAI-compatible base URL the agent's provider uses (`http://127.0.0.1:<port>/v1`). */
  readonly baseUrl: string;
  /** The run is open: a `watch` from the server streams this conversation's events. */
  attach(harness: Harness, conversationId: ConversationId, threadsOf?: ThreadsOf, modelNames?: () => Record<string, string>): void;
  /** The notice of move `switchId` is committed: told to the server over the link, now or as soon as it dials in. */
  notifySwitched(switchId: string): void;
  /** One line of this instance's trail to the server, over the link: sent at once when the link is up and not backed up, held (the last 200) until it dials in otherwise, dropped past that. Synchronous, never throws, never waits. */
  trail(event: string, data?: Record<string, unknown>): void;
  /** How the agent's switch_environment tool reaches the server: over this link. */
  readonly switchChannel: FrameSwitchChannel;
  /** The GPU boxes the server lends this host (the cluster beat): acquire one per thread, run commands in it. The server holds the Modal key; the host only asks. */
  readonly gpu: GpuClient;
  close(): Promise<void>;
}

export async function startCloudLink(opts: { port: number; host: string; token: string; waitMs?: number; log?: (event: string, data?: Record<string, unknown>) => void }): Promise<CloudLink> {
  const log = opts.log ?? (() => undefined);
  let link: WebSocket | undefined;
  let linked: () => void = () => undefined;
  let next = 1;
  const open = new Map<number, ServerResponse & { head?: boolean }>();
  let run: { harness: Harness; conversationId: ConversationId; threadsOf?: ThreadsOf; modelNames?: () => Record<string, string> } | undefined;
  const relays = new RelayHolder();
  /** `watch`es are taken one at a time: two viewers that subscribe together must not interleave their stops and starts. */
  let watchChain: Promise<void> = Promise.resolve();
  /** Moves whose notice committed before the server dialed in: told when it does. */
  const switchedIds = new Set<string>();
  const trailHeld: Frame[] = [];
  const TRAIL_HELD_MAX = 200;
  const TRAIL_BACKED_UP = 256 * 1024;
  const switchChannel = new FrameSwitchChannel((frame) => {
    if (!link || link.readyState !== link.OPEN) return false;
    link.send(JSON.stringify(frame satisfies Frame));
    return true;
  });
  const gpu = createGpuClient((frame) => {
    if (!link || link.readyState !== link.OPEN) return false;
    link.send(JSON.stringify(frame satisfies Frame));
    return true;
  });
  let watching: { ws: WebSocket; stream: AgentEventStream } | undefined;
  /** A `watch` that came before the run opened; served once it does. */
  let pendingWatch: WebSocket | undefined;
  const watchNow = async (ws: WebSocket) => {
    if (!run) {
      pendingWatch = ws;
      return;
    }
    await watching?.stream.stop().catch(() => undefined);
    const stream = await watchEvents(run.harness, run.conversationId, ctx);
    watching = { ws, stream };
    const send = (frame: Frame) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(frame));
    send({ t: "event", kind: "snapshot", data: stream.snapshot });
    // The names the host's registry gave its models, so a page that only watches can say "Qwen3.5-27B (Golden Gate edit)" and not an id: with the snapshot, and again when the agent's model changes.
    const names = run.modelNames;
    if (names) send({ t: "event", kind: "models", data: names() });
    stream.start(async (events) => {
      send({ t: "event", kind: "events", data: events });
      if (names && changesModel(events)) send({ t: "event", kind: "models", data: names() });
    });
    // The teaching threads are child conversations the pipe's root stream does not carry: followed here and relayed as `thread` events (a viewer that joins gets every transcript again).
    if (run.threadsOf) {
      const { harness, threadsOf } = run;
      // A new subscriber gets a new relay (its first look sends every thread's snapshot again, to this socket); the one before it is stopped, and subscribers close together are taken in order.
      await relays.replace(() => {
        log("thread.relay.started");
        return new ThreadRelay(harness, ctx, () => threadsOf(harness, ctx), (msg) => send({ t: "event", kind: "thread", data: msg }), { log });
      });
    }
  };

  const watch = (ws: WebSocket): Promise<void> => {
    const run = watchChain.catch(() => undefined).then(() => watchNow(ws));
    watchChain = run;
    return run;
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
    for (const id of switchedIds) ws.send(JSON.stringify({ t: "switched", switchId: id } satisfies Frame));
    switchedIds.clear();
    drainTrail(ws, trailHeld, TRAIL_BACKED_UP);
    linked();
    ws.on("message", (data) => {
      const frame = JSON.parse(String(data)) as Frame;
      if (isGpuFrame(frame)) {
        gpu.handle(frame);
        return;
      }
      if (frame.t === "switch-accepted" || frame.t === "switch-refused") {
        switchChannel.accept(frame);
        return;
      }
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
        void relays.close();
      }
      if (link !== ws) return;
      link = undefined;
      gpu.lose("the link to the server closed");
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
    switchChannel,
    gpu,
    trail(event, data) {
      const frame: Frame = { t: "trail", at: new Date().toISOString(), event, ...(data ? { data } : {}) };
      try {
        if (link && link.readyState === link.OPEN) {
          // Lines held while the socket was backed up go first, in order, while there is room.
          trailHeld.push(frame);
          if (trailHeld.length > TRAIL_HELD_MAX) trailHeld.shift();
          drainTrail(link, trailHeld, TRAIL_BACKED_UP);
        } else {
          trailHeld.push(frame);
          if (trailHeld.length > TRAIL_HELD_MAX) trailHeld.shift();
        }
      } catch {
        // The trail is best effort: it never throws into whoever reports.
      }
    },
    notifySwitched(switchId) {
      if (link && link.readyState === link.OPEN) link.send(JSON.stringify({ t: "switched", switchId } satisfies Frame));
      else switchedIds.add(switchId);
    },
    attach(harness, conversationId, threadsOf, modelNames) {
      run = { harness, conversationId, ...(threadsOf ? { threadsOf } : {}), ...(modelNames ? { modelNames } : {}) };
      if (pendingWatch && pendingWatch === link) void watch(pendingWatch).catch((error) => log("link.watch-failed", { error: (error as Error).message }));
      pendingWatch = undefined;
    },
    async close() {
      switchChannel.lose("the link closed");
      gpu.lose("the link closed");
      link?.close(1000, "bye");
      wss.close();
      await new Promise<void>((r) => relay.close(() => r()));
    },
  };
}
