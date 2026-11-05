// The box relay's VM half: how a run's process reaches its VM box without the VM provider's token. The token and the SDK
// client are the server's alone (boxes.ts, BOX_KEYS), so a run's process runs pi-transport's VM provider over a client of
// its own (relayedVmSdk) whose every call comes here, on loopback with its run's own door token (box-relay.ts checks it),
// and is made here with the server's client only when it is one of the calls a run's tools make of that run's own box:
// find it, read its state and its tags, start a program in it, and that program's input, output and exit. Nothing else
// passes: no create, listing, end or tag change (the server makes and seeds the box, pulls its work/ back and ends it),
// and no call to a sandbox that does not carry the run's label. The SDK speaks gRPC, so the relay carries its calls, not
// its bytes on the wire: each program started here is held by an id of its own until its exit is read and its output
// streams are done.
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { relayAddress } from "./box-relay.js";

/** The label that names a box's run (run-box.ts RUN_LABEL), kept here so the run's process loads no more than it needs. */
const RUN_LABEL = "agentrun.run";
/** The most bytes one relayed write to a program's input may send. */
const MAX_INPUT_BYTES = 64 * 2 ** 20;
/** The most programs one run may hold here at once. */
const MAX_EXECS_PER_RUN = 64;
/** How many bytes of a program's output stream the relay holds before it stops reading the stream, until the run's
 *  process reads them. */
const MAX_BUFFERED_BYTES = 16 * 2 ** 20;
/** How long a program the run's process stopped asking about is held, once it exited. */
const EXEC_KEEP_MS = 10 * 60_000;
/** The most sandboxes the relay remembers the run of; past it, it asks the provider again. */
const KNOWN_MAX = 1024;

/** One program started in a VM sandbox, in binary mode: the part of the SDK's process the relay carries. */
export type VmProcess = {
  readonly stdin: { writeBytes(bytes: Uint8Array): Promise<void>; close(): Promise<void> };
  readonly stdout: AsyncIterable<Uint8Array>;
  readonly stderr: AsyncIterable<Uint8Array>;
  wait(): Promise<number>;
};
/** The part of the SDK's sandbox the relay calls. */
export type VmSandbox = {
  readonly sandboxId: string;
  exec(command: string[], params: { mode: "binary"; timeoutMs?: number; workdir?: string }): Promise<VmProcess>;
  poll(): Promise<number | null>;
  getTags(): Promise<Record<string, string>>;
};
/** The part of the SDK's client the relay calls: a sandbox by its id. */
export type VmSdk = { readonly sandboxes: { fromId(id: string): Promise<VmSandbox> } };

/** An SDK error as the relay answers it: its class's name and its gRPC code, which pi-transport's provider classifies by. */
type Failure = { name: string; code?: number; message: string };
const failureOf = (error: unknown): Failure => {
  const name = (error as { constructor?: { name?: string } } | null)?.constructor?.name ?? "Error";
  const code = (error as { code?: unknown } | null)?.code;
  return { name, ...(typeof code === "number" ? { code } : {}), message: String((error as Error)?.message ?? error).slice(0, 300) };
};

/** One output stream, read from the program as soon as it starts (the SDK's stream holds its output only while it is
 *  read), and held here until the run's process reads it, up to MAX_BUFFERED_BYTES ahead. */
type Pump = { chunks: Uint8Array[]; bytes: number; done: boolean; failure?: unknown; wake?: () => void; space?: () => void };
function pump(source: AsyncIterable<Uint8Array>): Pump {
  const state: Pump = { chunks: [], bytes: 0, done: false };
  void (async () => {
    try {
      for await (const chunk of source) {
        state.chunks.push(chunk);
        state.bytes += chunk.length;
        state.wake?.();
        while (state.bytes > MAX_BUFFERED_BYTES) await new Promise<void>((resolve) => (state.space = resolve));
      }
    } catch (error) {
      state.failure = error ?? new Error("the stream failed");
    }
    state.done = true;
    state.wake?.();
  })();
  return state;
}

type Held = { run: string; process: VmProcess; streams: Record<"stdout" | "stderr", Pump>; exited?: number; waited: boolean; read: Set<"stdout" | "stderr">; timer?: NodeJS.Timeout };

/** The relay's handler of a run's VM calls, over the server's client `sdk`: `handle(runId, path, req, res)` answers the
 *  call at `path` (what follows `/runs/<id>/vm/`), the caller's token already checked. `drop(runId)` lets go of the run's
 *  programs (at its end). */
export function vmRelay(sdk: VmSdk): { handle(runId: string, path: string, req: IncomingMessage, res: ServerResponse): Promise<void>; drop(runId: string): void } {
  const known = new Map<string, { sandbox: VmSandbox; run: string | undefined }>();
  const execs = new Map<string, Held>();

  /** Sandbox `id` and the run its label names, as the provider says; undefined when it has none. */
  const sandboxOf = async (id: string) => {
    const held = known.get(id);
    if (held) return held;
    const sandbox = await sdk.sandboxes.fromId(id);
    const tags = await sandbox.getTags();
    const value = { sandbox, run: typeof tags[RUN_LABEL] === "string" ? tags[RUN_LABEL] : undefined };
    if (known.size >= KNOWN_MAX) known.clear();
    known.set(id, value);
    return value;
  };
  const answer = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };
  const failed = (res: ServerResponse, error: unknown): void => void (res.headersSent ? res.destroy() : answer(res, 502, { failure: failureOf(error) }));
  const notThere = (res: ServerResponse) => answer(res, 404, { failure: { name: "NotFoundError", code: 5, message: "no such sandbox" } });
  const refused = (res: ServerResponse, path: string) => answer(res, 403, { message: `the box relay does not make ${path}: a run's process reaches only its own box's programs and files` });
  const forget = (id: string) => {
    const held = execs.get(id);
    if (held?.timer) clearTimeout(held.timer);
    execs.delete(id);
  };
  /** A program is let go once its exit was read and both its streams were read through, or EXEC_KEEP_MS after its exit. */
  const settle = (id: string) => {
    const held = execs.get(id);
    if (!held || held.exited === undefined) return;
    if (held.waited && held.read.size === 2 && held.streams.stdout.done && held.streams.stderr.done) return forget(id);
    held.timer ??= setTimeout(() => forget(id), EXEC_KEEP_MS);
    held.timer.unref?.();
  };

  async function handle(runId: string, path: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== "POST") return answer(res, 405, { message: "the VM relay takes POST" });
    const onSandbox = /^sandbox\/([^/]+)\/(find|poll|tags|exec)$/.exec(path);
    if (onSandbox) {
      const id = decodeURIComponent(onSandbox[1]!);
      let found;
      try {
        found = await sandboxOf(id);
      } catch (error) {
        return failureOf(error).name === "NotFoundError" || failureOf(error).code === 5 ? notThere(res) : failed(res, error);
      }
      // A sandbox of another run, or of none, is not there for this one: as the provider answers one it does not have.
      if (found.run !== runId) return notThere(res);
      try {
        switch (onSandbox[2]) {
          case "find":
            return answer(res, 200, { id });
          case "poll":
            return answer(res, 200, { code: await found.sandbox.poll() });
          case "tags":
            return answer(res, 200, { tags: await found.sandbox.getTags() });
          default: {
            const body = (await jsonOf(req)) as { command?: unknown; workdir?: unknown; timeoutMs?: unknown } | null;
            const command = body?.command;
            if (!Array.isArray(command) || !command.length || !command.every((part) => typeof part === "string")) return answer(res, 400, { message: "exec names its command: a list of strings" });
            if ([...execs.values()].filter((held) => held.run === runId).length >= MAX_EXECS_PER_RUN) return answer(res, 429, { message: `a run holds at most ${MAX_EXECS_PER_RUN} programs in its box at once` });
            const process = await found.sandbox.exec(command as string[], { mode: "binary", ...(typeof body?.workdir === "string" ? { workdir: body.workdir } : {}), ...(typeof body?.timeoutMs === "number" ? { timeoutMs: body.timeoutMs } : {}) });
            const exec = randomUUID();
            const held: Held = { run: runId, process, streams: { stdout: pump(process.stdout), stderr: pump(process.stderr) }, waited: false, read: new Set() };
            execs.set(exec, held);
            process.wait().then((code) => {
              held.exited = code;
              settle(exec);
            }, () => {
              held.exited = -1;
              settle(exec);
            });
            return answer(res, 200, { exec });
          }
        }
      } catch (error) {
        return failed(res, error);
      }
    }
    const onExec = /^exec\/([^/]+)\/(stdin|stdin-close|stdout|stderr|wait)$/.exec(path);
    if (!onExec) return refused(res, path);
    const id = decodeURIComponent(onExec[1]!);
    const held = execs.get(id);
    // Another run's program is not there for this one.
    if (!held || held.run !== runId) return answer(res, 404, { message: "no such program" });
    try {
      switch (onExec[2]) {
        case "stdin": {
          const bytes = await bytesOf(req);
          if (bytes === null) return answer(res, 413, { message: `a write sends at most ${MAX_INPUT_BYTES} bytes` });
          await held.process.stdin.writeBytes(new Uint8Array(bytes));
          return answer(res, 200, {});
        }
        case "stdin-close":
          await held.process.stdin.close();
          return answer(res, 200, {});
        case "wait": {
          const code = await held.process.wait();
          held.waited = true;
          answer(res, 200, { code });
          return settle(id);
        }
        default: {
          const name = onExec[2] as "stdout" | "stderr";
          if (held.read.has(name)) return answer(res, 409, { message: `the program's ${name} is read once` });
          held.read.add(name);
          const stream = held.streams[name];
          res.writeHead(200, { "content-type": "application/octet-stream", "cache-control": "no-store" });
          for (;;) {
            while (stream.chunks.length) {
              const chunk = stream.chunks.shift()!;
              stream.bytes -= chunk.length;
              stream.space?.();
              if (!res.write(chunk)) await new Promise((resolve) => res.once("drain", resolve));
            }
            if (stream.done) break;
            await new Promise<void>((resolve) => (stream.wake = resolve));
          }
          // A stream that broke is a broken answer, never a short one: the caller sees its read fail.
          if (stream.failure !== undefined) res.destroy();
          else res.end();
          settle(id);
          return;
        }
      }
    } catch (error) {
      return failed(res, error);
    }
  }

  return {
    handle,
    drop(runId) {
      for (const [id, held] of execs) if (held.run === runId) forget(id);
    },
  };
}

async function bytesOf(req: IncomingMessage): Promise<Buffer | null> {
  const parts: Buffer[] = [];
  let size = 0;
  for await (const part of req) {
    size += (part as Buffer).length;
    if (size > MAX_INPUT_BYTES) return null;
    parts.push(part as Buffer);
  }
  return Buffer.concat(parts);
}
const jsonOf = async (req: IncomingMessage): Promise<unknown> => {
  const bytes = await bytesOf(req);
  try {
    return bytes ? JSON.parse(bytes.toString("utf8") || "null") : null;
  } catch {
    return null;
  }
};

/** An error as the SDK would throw it, from the relay's answer: its class's name, so pi-transport's provider reads it the
 *  same (NotFoundError, a gRPC code). */
function errorOf(failure: Failure | undefined, fallback: string): Error {
  const name = failure?.name && /^[A-Za-z]+$/.test(failure.name) ? failure.name : "Error";
  const Named = { [name]: class extends Error {} }[name]!;
  return Object.assign(new Named(failure?.message ?? fallback), typeof failure?.code === "number" ? { code: failure.code } : {});
}

/** The SDK client a run's process hands pi-transport's VM provider: each call it makes of a box goes to the relay in data
 *  root `root`, with the run's own door token. It finds a sandbox and runs programs in it; it makes, lists and ends none. */
export function relayedVmSdk(root: string, runDir: string, runId: string) {
  const call = async (path: string, body?: BodyInit, json = true): Promise<Response> => {
    const { url, token } = await relayAddress(root, runDir);
    return fetch(`${url}/runs/${encodeURIComponent(runId)}/vm/${path}`, { method: "POST", headers: { authorization: `Bearer ${token}`, ...(json ? { "content-type": "application/json" } : { "content-type": "application/octet-stream" }) }, ...(body === undefined ? {} : { body }), redirect: "error" });
  };
  const result = async <T>(path: string, body?: unknown): Promise<T> => {
    const answer = await call(path, body === undefined ? undefined : JSON.stringify(body));
    const value = (await answer.json().catch(() => null)) as (T & { failure?: Failure; message?: string }) | null;
    if (!answer.ok) throw errorOf(value?.failure, value?.message ?? `the box relay answered ${answer.status}`);
    return value as T;
  };
  /** A program's output stream: read from the relay once its reader starts, failing as the relay's answer fails. */
  const stream = (exec: string, name: "stdout" | "stderr"): AsyncIterable<Uint8Array> => ({
    async *[Symbol.asyncIterator]() {
      const answer = await call(`exec/${exec}/${name}`);
      if (!answer.ok || !answer.body) throw errorOf(undefined, `the box relay answered ${answer.status} to the program's ${name}`);
      for await (const chunk of answer.body as unknown as AsyncIterable<Uint8Array>) yield chunk;
    },
  });
  const sandbox = (sandboxId: string) => {
    const at = `sandbox/${encodeURIComponent(sandboxId)}`;
    return {
      sandboxId,
      poll: async () => (await result<{ code: number | null }>(`${at}/poll`, {})).code,
      getTags: async () => (await result<{ tags: Record<string, string> }>(`${at}/tags`, {})).tags,
      terminate: async (): Promise<number> => {
        throw new Error("a run's process ends no box: the server does");
      },
      exec: async (command: string[], params: { mode: "binary"; timeoutMs?: number; workdir?: string }) => {
        const { exec } = await result<{ exec: string }>(`${at}/exec`, { command, ...(params.workdir ? { workdir: params.workdir } : {}), ...(params.timeoutMs === undefined ? {} : { timeoutMs: params.timeoutMs }) });
        const id = encodeURIComponent(exec);
        return {
          stdin: {
            writeBytes: async (bytes: Uint8Array) => {
              const answer = await call(`exec/${id}/stdin`, bytes as unknown as BodyInit, false);
              if (!answer.ok) throw errorOf(((await answer.json().catch(() => null)) as { failure?: Failure } | null)?.failure, `the box relay answered ${answer.status} to a write`);
            },
            close: async () => void (await result(`exec/${id}/stdin-close`, {})),
          },
          stdout: stream(id, "stdout"),
          stderr: stream(id, "stderr"),
          wait: async () => (await result<{ code: number }>(`exec/${id}/wait`, {})).code,
        };
      },
    };
  };
  const none = (what: string) => () => {
    throw new Error(`a run's process ${what} no box: the server does`);
  };
  return {
    apps: { fromName: none("names") },
    images: { fromRegistry: none("names"), fromId: none("names") },
    sandboxes: {
      create: none("makes"),
      list: none("lists"),
      fromId: async (id: string) => {
        await result(`sandbox/${encodeURIComponent(id)}/find`, {});
        return sandbox(id);
      },
    },
  };
}
