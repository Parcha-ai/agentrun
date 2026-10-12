// The server's end of a cloud host's link (see cloud-link.ts): dial in, answer its model calls through the run's
// ModelProxy, redial while the run is there, and relay the run's agent events to whoever subscribed. The connection
// carries a bearer token the server gave the host at start.
import WebSocket from "ws";
import { isGpuFrame, serveGpu, type GpuFrame, type GpuServer } from "./gpu-rpc.ts";
import type { ModelProxy } from "./model-proxy.ts";

type Frame =
  | { t: "model"; id: number; path: string; body: Record<string, unknown> }
  | { t: "model-abort"; id: number }
  | { t: "event"; kind: "snapshot" | "events" | "thread"; data: unknown }
  | { t: "switch"; to: string; reason?: string; ask: string }
  | { t: "switched"; switchId: string }
  | GpuFrame;

/** `thread`: one teaching thread's own conversation (tab/threads.ts ThreadMsg), relayed by the host beside the root's events. */
export type LinkEvent = { kind: "snapshot" | "events" | "thread"; data: unknown };

export interface LinkDialer {
  /** Receive the run's agent events (a fresh snapshot first); returns the unsubscribe. */
  subscribe(listener: (event: LinkEvent) => void): () => void;
  close(): void;
}

export function dialLink(opts: {
  url: string;
  token: string;
  headers?: Record<string, string>;
  proxy: ModelProxy;
  /** The host's agent asks to move (switch_environment): resolve with the handover's id, or reject with why not. */
  onSwitch?: (to: string, reason: string) => Promise<{ switchId: string }>;
  /** The host's agent has the notice of move `switchId` committed. */
  onSwitched?: (switchId: string) => void;
  /** The GPU boxes this run's host may use (the cluster beat): the host asks for a box and runs commands in it through this link. Absent: the host's gpu calls are refused. */
  gpu?: GpuServer;
  log: (event: string, data?: Record<string, unknown>) => void;
  retryMs?: number;
}): LinkDialer {
  let closed = false;
  let socket: WebSocket | undefined;
  const aborts = new Map<number, AbortController>();
  const listeners = new Set<(event: LinkEvent) => void>();
  const askWatch = () => socket?.readyState === WebSocket.OPEN && socket.send(JSON.stringify({ t: "watch" }));
  const connect = () => {
    if (closed) return;
    const ws = (socket = new WebSocket(opts.url, { headers: { ...opts.headers, authorization: `Bearer ${opts.token}` }, perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 }));
    ws.on("open", () => {
      opts.log("link.dialed");
      if (listeners.size > 0) askWatch();
    });
    const gpu = opts.gpu ? serveGpu(opts.gpu, (out) => void (ws.readyState === ws.OPEN && ws.send(JSON.stringify(out))), opts.log) : undefined;
    ws.on("message", (data) => {
      const frame = JSON.parse(String(data)) as Frame;
      if (isGpuFrame(frame)) {
        if (gpu) gpu.handle(frame);
        else if ("id" in frame && frame.t !== "gpu-ok" && frame.t !== "gpu-data" && frame.t !== "gpu-exit" && frame.t !== "gpu-err") ws.send(JSON.stringify({ t: "gpu-err", id: frame.id, message: "this server has no GPU boxes for the run" } satisfies GpuFrame));
        return;
      }
      if (frame.t === "event") {
        for (const listener of listeners) listener({ kind: frame.kind, data: frame.data });
        return;
      }
      if (frame.t === "switched") {
        opts.onSwitched?.(frame.switchId);
        return;
      }
      if (frame.t === "switch") {
        const answer = (out: unknown) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(out));
        const refuse = (message: string) => answer({ t: "switch-refused", ask: frame.ask, message });
        if (!opts.onSwitch) return refuse("this server does not move agents");
        opts.onSwitch(frame.to, frame.reason ?? "").then((r) => answer({ t: "switch-accepted", ask: frame.ask, switchId: r.switchId }), (e: Error) => refuse(e.message));
        return;
      }
      if (frame.t === "model-abort") {
        aborts.get(frame.id)?.abort();
        return;
      }
      if (frame.t !== "model") return;
      const abort = new AbortController();
      aborts.set(frame.id, abort);
      const send = (out: unknown) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(out));
      void opts.proxy
        .forward(frame.path, frame.body, {
          head: (status) => send({ t: "model-head", id: frame.id, status }),
          chunk: (text) => send({ t: "model-chunk", id: frame.id, data: text }),
          end: (status, error) => send({ t: "model-end", id: frame.id, status, ...(error ? { error } : {}) }),
        }, abort.signal)
        .finally(() => aborts.delete(frame.id));
    });
    ws.on("close", (code) => {
      gpu?.close();
      for (const abort of aborts.values()) abort.abort();
      aborts.clear();
      if (!closed) setTimeout(connect, opts.retryMs ?? 2_000);
      if (code !== 1006) opts.log("link.closed", { code });
    });
    ws.on("error", () => undefined);
  };
  connect();
  return {
    subscribe(listener) {
      listeners.add(listener);
      askWatch();
      return () => listeners.delete(listener);
    },
    close() {
      closed = true;
      socket?.close(1000, "bye");
    },
  };
}
