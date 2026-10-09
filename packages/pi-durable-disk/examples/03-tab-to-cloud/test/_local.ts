// A demo server on a local directory instead of an Archil mount: the claim is a plain directory, the barrier a no-op
// (or a hook), the model a local stub. For tests of the pipe's protocol; the live suite runs the same server on the disk.
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FencedError, openClaimDir } from "@parcha/pi-durable-disk";
import type { AcquireOptions, Claim } from "@parcha/pi-durable-disk";
import { createDemoServer, type DemoServer, type DemoServerOptions } from "../pipe/server.ts";

export type LocalClaimHooks = { barrier?: () => Promise<void>; fenceNow?: () => boolean };

export function localClaim(root: string, opts: AcquireOptions, hooks: LocalClaimHooks = {}): Claim {
  const runRoot = join(root, "runs", opts.ref.id);
  mkdirSync(runRoot, { recursive: true });
  let fenced: unknown;
  return {
    ref: opts.ref,
    disk: opts.ref.disk,
    root: runRoot,
    work: join(runRoot, "work"),
    store: join(runRoot, "store"),
    reused: false,
    forced: false,
    timings: { mountMs: 0, verifyMs: 0 },
    get fenced() {
      return fenced !== undefined;
    },
    markFenced(cause?: unknown) {
      fenced ??= cause ?? true;
    },
    async barrier() {
      if (fenced !== undefined || hooks.fenceNow?.()) throw new FencedError("fenced (local claim)");
      await hooks.barrier?.();
      return { ms: 0 };
    },
    async release() {
      return { via: "none" as const };
    },
  };
}

/** A tiny OpenAI-compatible stub: streams `reply` as one chunk plus a usage chunk. */
export async function modelStub(reply: (body: Record<string, unknown>) => string): Promise<{ url: string; requests: Record<string, unknown>[]; close(): Promise<void> }> {
  const requests: Record<string, unknown>[] = [];
  const server: Server = createServer((req, res) => {
    let text = "";
    req.on("data", (c) => (text += c));
    req.on("end", () => {
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(text) as Record<string, unknown>;
      } catch {
        // A request the pipe aborted while sending it.
        res.writeHead(400).end();
        return;
      }
      requests.push(body);
      res.writeHead(200, { "content-type": "text/event-stream" });
      const id = `chatcmpl-${requests.length}`;
      const chunk = (delta: Record<string, unknown>, finish: string | null) =>
        `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 0, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      res.write(chunk({ role: "assistant", content: reply(body) }, null));
      res.write(chunk({}, "stop"));
      res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 0, model: body.model, choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}/v1`, requests, close: () => new Promise((r) => server.close(() => r())) };
}

export async function localServer(options: Partial<DemoServerOptions> & { hooks?: LocalClaimHooks } = {}): Promise<{ server: DemoServer; url: string; root: string; remove(): Promise<void> }> {
  const root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "pda-demo-"));
  const server = createDemoServer({
    disk: "dsk-local",
    region: "local",
    control: null,
    mountRoot: root,
    model: { baseUrl: "http://127.0.0.1:9/v1", model: "stub", budgetTokens: 1_000_000 },
    acquire: async (opts) => localClaim(root, opts, options.hooks),
    claimDir: (dir) => openClaimDir(dir, { fstype: null }),
    lease: { heartbeatMs: 500, expiryMs: 5_000, marginMs: 1_000 },
    ...options,
  });
  const port = await server.listen(0);
  return {
    server,
    url: `ws://127.0.0.1:${port}/ws`,
    root,
    async remove() {
      await server.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
