// Adapted from Browser Use Pi (https://github.com/browser-use/browser-use-pi) at commit
// e7007f219b10fa2c2baae1bf3e2f902a5a2706fd, src/cdp.ts. MIT License, Copyright (c) 2026 Browser Use contributors; the
// license's full text is in this package's NOTICE, and UPSTREAM.json beside this file records the source.
// Changes: one connection over a socket the caller opens (core/dial.ts openDial); no lazy connection, no macOS approval
// prompt and no target bookkeeping; untyped params and results in place of devtools-protocol's types, so the package
// takes no dependency for them.

type Pending = { resolve(value: unknown): void; reject(error: Error): void };

/** Explicit commands over one flattened CDP WebSocket. No proxies. */
export class CDP {
  private nextId = 0;
  private pending = new Map<number, Pending>();
  /** Every event, with its session: the driver's dialogs and network tracking read them. Never receives responses. */
  observeEvent: ((method: string, params: unknown, sessionId?: string) => void) | undefined;

  private constructor(
    private socket: WebSocket,
    readonly timeoutMs: number,
  ) {
    socket.addEventListener("message", ({ data }) => {
      try {
        const message = JSON.parse(String(data));
        if (message.id !== undefined) {
          const request = this.pending.get(message.id);
          if (message.error) request?.reject(new Error(`CDP ${message.error.code}: ${message.error.message}`));
          else request?.resolve(message.result);
        } else {
          try { this.observeEvent?.(message.method, message.params, message.sessionId); } catch { /* an observer cannot change delivery */ }
        }
      } catch {
        this.fail(new Error("Malformed CDP message."));
        socket.close();
      }
    });
    socket.addEventListener("close", () => this.fail(new Error("CDP connection closed. Inspect state before retrying.")));
    socket.addEventListener("error", () => this.fail(new Error("CDP connection failed.")));
  }

  /** The connection over `socket`, once it is open; a socket that does not open within the timeout (at least 15 s) is closed and refused. */
  static async open(socket: WebSocket, timeoutMs = 15_000): Promise<CDP> {
    const connectMs = Math.max(timeoutMs, 15_000);
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timer);
        socket.removeEventListener("open", open);
        socket.removeEventListener("error", failed);
        socket.removeEventListener("close", failed);
        if (error) {
          socket.close();
          reject(error);
        } else resolve();
      };
      const open = () => finish();
      const failed = () => finish(new Error("Could not connect to CDP endpoint."));
      const timer = setTimeout(() => finish(new Error("CDP connection timed out.")), connectMs);
      socket.addEventListener("open", open, { once: true });
      socket.addEventListener("error", failed, { once: true });
      socket.addEventListener("close", failed, { once: true });
    });
    return new CDP(socket, timeoutMs);
  }

  send<T = any>(method: string, params: object = {}, sessionId?: string): Promise<T> {
    if (this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error("CDP connection is closed."));
    if (this.pending.size >= 256) return Promise.reject(new Error("Too many pending CDP commands (256)."));
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      const finish = (error?: Error, value?: unknown) => {
        clearTimeout(timer);
        this.pending.delete(id);
        if (error) reject(error);
        else resolve(value as T);
      };
      const timer = setTimeout(() => finish(new Error(`CDP ${method} exceeded ${this.timeoutMs} ms; the action may have happened.`)), this.timeoutMs);
      this.pending.set(id, { resolve: (value) => finish(undefined, value), reject: (error) => finish(error) });
      try {
        this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private fail(error: Error) {
    for (const request of [...this.pending.values()]) request.reject(error);
  }

  close() {
    this.fail(new Error("CDP connection closed."));
    this.socket.close();
  }
}
