// Copyright 2026 Vercel Inc. Licensed under the Apache License, Version 2.0; see LICENSE in this package.
// From github.com/vercel-labs/durable-harness, packages/harness-codex/src/app-server.ts at ea8aa4060c (UPSTREAM.json records its blob and sha256).
// Changed by Parcha, imports rewritten for AgentRun; patches: 004-names
import type { LineChannel } from './host/process.js';

/**
 * A JSON-RPC 2.0 client for `codex app-server --stdio`, over a child's stdio
 * as a `LineChannel`: one JSON object per line each way. In a session's VM
 * the channel is the relay's `RemoteProcess` (docs/workspaces.md §5.6); a
 * test can hand it any channel.
 *
 * Three kinds of message arrive: responses to our requests, notifications
 * (`item/*`, `turn/*`, deltas), and requests from the server that block
 * until we answer them (`item/tool/call`, approvals). `onRequest` answers
 * the latter; a handler that throws is answered with a JSON-RPC error.
 */

export interface RpcNotification {
  method: string;
  params?: any;
}

export interface RpcServerRequest extends RpcNotification {
  id: number | string;
}

/** A JSON-RPC error app-server answered with. */
export class RpcError extends Error {
  constructor(
    readonly method: string,
    readonly code: number,
    message: string,
    readonly data?: unknown
  ) {
    super(`codex app-server ${method}: ${message} (${code})`);
  }
}

export interface AppServerOptions {
  onNotification?: (n: RpcNotification) => void;
  onRequest?: (r: RpcServerRequest) => Promise<unknown>;
  /** A line that is not JSON (app-server logs go to stderr; this should not happen). */
  onNoise?: (line: string) => void;
}

export class AppServer {
  private nextId = 1;
  private readonly pending = new Map<number, { method: string; resolve: (v: any) => void; reject: (e: unknown) => void }>();
  private closedWith: Error | undefined;
  /** Resolves with the reason once stdout ends (the child exited or closed it). */
  readonly closed: Promise<Error>;

  constructor(
    readonly proc: LineChannel,
    private readonly options: AppServerOptions = {}
  ) {
    this.closed = this.read();
  }

  private async read(): Promise<Error> {
    try {
      for await (const line of this.proc.lines()) {
        if (!line.trim()) continue;
        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch {
          this.options.onNoise?.(line);
          continue;
        }
        if (msg.id != null && msg.method == null) this.settle(msg);
        else if (msg.id != null) void this.answer(msg as RpcServerRequest);
        else if (typeof msg.method === 'string') this.options.onNotification?.(msg as RpcNotification);
      }
    } catch {}
    const exit = await Promise.race([this.proc.exited, new Promise<undefined>((r) => setTimeout(r, 1000, undefined))]);
    const how = exit ? (exit.signal ?? `code ${exit.code}`) : 'stdout closed';
    const err = new Error(`codex app-server exited (${how}): ${this.proc.stderrTail().trim().slice(-800)}`);
    this.closedWith = err;
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
    return err;
  }

  private settle(msg: { id: number; result?: unknown; error?: { code: number; message: string; data?: unknown } }): void {
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (msg.error) p.reject(new RpcError(p.method, msg.error.code, msg.error.message, msg.error.data));
    else p.resolve(msg.result);
  }

  private async answer(req: RpcServerRequest): Promise<void> {
    try {
      const handler = this.options.onRequest;
      if (!handler) throw Object.assign(new Error(`unhandled ${req.method}`), { code: -32601 });
      const result = await handler(req);
      this.proc.send({ id: req.id, result });
    } catch (err) {
      const code = typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : -32000;
      this.proc.send({ id: req.id, error: { code, message: (err as Error).message ?? String(err) } });
    }
  }

  /** Send a request and wait for its result. Rejects with `RpcError`, or when the child goes away. */
  request<T = any>(method: string, params: unknown): Promise<T> {
    if (this.closedWith) return Promise.reject(this.closedWith);
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject });
      if (!this.proc.send({ id, method, params })) {
        this.pending.delete(id);
        reject(new Error(`codex app-server: stdin is closed (${method})`));
      }
    });
  }

  notify(method: string, params: unknown = {}): void {
    this.proc.send({ method, params });
  }

  /** `initialize` with the experimental API (dynamic tools, `thread/inject_items`), then `initialized`. */
  async initialize(clientName = 'agentrun-codex', version = '0'): Promise<{ userAgent?: string; codexHome?: string }> {
    const result = await this.request('initialize', {
      clientInfo: { name: clientName, version, title: null },
      capabilities: { experimentalApi: true },
    });
    this.notify('initialized', {});
    return result;
  }
}
