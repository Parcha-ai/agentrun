// The box relay's VM half: how a run's process reaches its VM box without the VM provider's token. The token and the SDK
// client are the server's alone (boxes.ts, BOX_KEYS), so a run's process runs pi-transport's VM provider over a client of
// its own (relayedVmSdk) whose every call comes here, on loopback with its run's own door token (box-relay.ts checks it),
// and is made here with the server's client only when it is one of the calls a run's tools make of that run's own box:
// find it, read its state and its tags, start a program in it, and that program's input, output and exit. Nothing else
// passes: no create, listing, end or tag change (the server makes the box, has it mount the run's folder, and ends it),
// and no call to a sandbox that does not carry the run's label. The SDK speaks gRPC, so the relay carries its calls, not
// its bytes on the wire: each program started here is held by an id of its own until its exit is read and its output
// streams are done.
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Agent } from "undici";
import { relayAddress } from "./box-relay.js";
import { redacted } from "./key-refusal.js";

/** The label that names a box's run (run-box.ts RUN_LABEL), kept here so the run's process loads no more than it needs. */
const RUN_LABEL = "agentrun.run";
/** The most bytes one relayed write to a program's input may send. */
const MAX_INPUT_BYTES = 64 * 2 ** 20;
/** The most programs one run may hold here at once. */
const MAX_EXECS_PER_RUN = 64;
/** How many bytes of a program's output stream the relay holds before it stops reading the stream, until the run's
 *  process reads them. */
const MAX_BUFFERED_BYTES = 16 * 2 ** 20;
/** How long a program the run's process stopped asking about is held, once it exited. A program is let go:
 *  - once its exit was read (or failed to be) and both its output replies ended, whole or broken (settle);
 *  - at once when a caller goes away mid-read (the reply's close);
 *  - at the run's end (drop), whatever it is doing, a program still starting then included, as it lands;
 *  - else EXEC_KEEP_MS after its exit: an exit or an output not read yet is still the caller's to read.
 *  A program still running holds its slot until it exits or the run ends. */
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
/** Its message is the SDK's, which can quote anything: cut of every value the server holds, and of secret-shaped text,
 *  by serve's one rule (key-refusal.ts redacted), before it goes to the run's process. */
const failureOf = (error: unknown, secrets: readonly string[] = []): Failure => {
  const name = (error as { constructor?: { name?: string } } | null)?.constructor?.name ?? "Error";
  const code = (error as { code?: unknown } | null)?.code;
  return { name, ...(typeof code === "number" ? { code } : {}), message: redacted(String((error as Error)?.message ?? error), secrets).slice(0, 300) };
};

/** One output stream, read from the program as soon as it starts (the SDK's stream holds its output only while it is
 *  read), and held here until the run's process reads it, up to MAX_BUFFERED_BYTES ahead. */
type Pump = { chunks: Uint8Array[]; bytes: number; done: boolean; cancelled: boolean; failure?: unknown; wake?: () => void; space?: () => void; cancel(): void };
function pump(source: AsyncIterable<Uint8Array>): Pump {
  const iterator = source[Symbol.asyncIterator]();
  const state: Pump = {
    chunks: [], bytes: 0, done: false, cancelled: false,
    // Let go: what it holds is dropped, the source's read is ended, and whoever waits on it is woken.
    cancel() {
      if (state.cancelled) return;
      state.cancelled = true;
      state.chunks.length = 0;
      state.bytes = 0;
      state.done = true;
      void Promise.resolve(iterator.return?.()).catch(() => undefined);
      state.space?.();
      state.wake?.();
    },
  };
  void (async () => {
    try {
      for (;;) {
        const next = await iterator.next();
        if (next.done || state.cancelled) break;
        state.chunks.push(next.value);
        state.bytes += next.value.length;
        state.wake?.();
        while (state.bytes > MAX_BUFFERED_BYTES && !state.cancelled) await new Promise<void>((resolve) => (state.space = resolve));
      }
    } catch (error) {
      if (!state.cancelled) state.failure = error ?? new Error("the stream failed");
    }
    state.done = true;
    state.wake?.();
  })();
  return state;
}

/** `read`: the streams whose read began (each is read once); `finished`: those whose reply ended, whole or broken (a
 *  stream that failed has nothing more to give). */
type Held = { run: string; process: VmProcess; streams: Record<"stdout" | "stderr", Pump>; exited?: number; waited: boolean; read: Set<"stdout" | "stderr">; finished: Set<"stdout" | "stderr">; timer?: NodeJS.Timeout };

/** The relay's handler of a run's VM calls, over the server's client `sdk`: `handle(runId, path, req, res)` answers the
 *  call at `path` (what follows `/runs/<id>/vm/`), the caller's token already checked. `drop(runId)` lets go of the run's
 *  programs (at its end). */
export function vmRelay(sdk: VmSdk, secrets: () => readonly string[] = () => []): { handle(runId: string, path: string, req: IncomingMessage, res: ServerResponse): Promise<void>; drop(runId: string): void; footprint(): { programs: number; starting: number } } {
  const known = new Map<string, { sandbox: VmSandbox; run: string | undefined }>();
  const execs = new Map<string, Held>();
  /** The program starts each run has under way, from the moment its request is taken (before the sandbox's lookup): each
   *  counts toward the run's limit, and one its run's end (drop) marks is let go as it lands, never held. A run is here
   *  only while it has one, so an ended run leaves nothing behind. */
  const starting = new Map<string, Set<{ dropped: boolean }>>();
  const startOf = (runId: string) => {
    const start = { dropped: false };
    const starts = starting.get(runId) ?? new Set();
    starts.add(start);
    starting.set(runId, starts);
    return start;
  };
  const started = (runId: string, start: { dropped: boolean }) => {
    const starts = starting.get(runId);
    starts?.delete(start);
    if (starts && !starts.size) starting.delete(runId);
  };

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
  const failed = (res: ServerResponse, error: unknown): void => void (res.headersSent ? res.destroy() : answer(res, 502, { failure: failureOf(error, secrets()) }));
  const notThere = (res: ServerResponse) => answer(res, 404, { failure: { name: "NotFoundError", code: 5, message: "no such sandbox" } });
  const refused = (res: ServerResponse, path: string) => answer(res, 403, { message: `the box relay does not make ${path}: a run's process reaches only its own box's programs and files` });
  const forget = (id: string) => {
    const held = execs.get(id);
    if (held?.timer) clearTimeout(held.timer);
    // Its streams' reads end with it, and a reply still writing one is let go.
    held?.streams.stdout.cancel();
    held?.streams.stderr.cancel();
    execs.delete(id);
  };
  /** A program is let go once its exit was read and both its streams' replies ended (delivered whole, or broken because
   *  the stream failed), or EXEC_KEEP_MS after its exit. */
  const settle = (id: string) => {
    const held = execs.get(id);
    if (!held || held.exited === undefined) return;
    if (held.waited && held.finished.size === 2) return forget(id);
    held.timer ??= setTimeout(() => forget(id), EXEC_KEEP_MS);
    held.timer.unref?.();
  };

  async function handle(runId: string, path: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== "POST") return answer(res, 405, { message: "the Modal sandbox relay takes POST" });
    const onSandbox = /^sandbox\/([^/]+)\/(find|poll|tags|exec)$/.exec(path);
    // A start is under way from here: a run's end while its sandbox is looked up, or its program started, still finds it.
    const start = onSandbox?.[2] === "exec" ? startOf(runId) : undefined;
    if (onSandbox) try {
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
            // Its slot was taken as the request came (startOf), and is given back once the program is held or did not start.
            const others = (starting.get(runId)?.size ?? 1) - 1;
            if ([...execs.values()].filter((held) => held.run === runId).length + others >= MAX_EXECS_PER_RUN) return answer(res, 429, { message: `a run holds at most ${MAX_EXECS_PER_RUN} programs in its box at once` });
            const process = await found.sandbox.exec(command as string[], { mode: "binary", ...(typeof body?.workdir === "string" ? { workdir: body.workdir } : {}), ...(typeof body?.timeoutMs === "number" ? { timeoutMs: body.timeoutMs } : {}) });
            // The run's programs were let go while this one started (its end): it is let go too, its output never read.
            if (start!.dropped) {
              for (const stream of [process.stdout, process.stderr]) void Promise.resolve(stream[Symbol.asyncIterator]().return?.()).catch(() => undefined);
              return answer(res, 410, { message: "the run ended while the program started: it is not held" });
            }
            const exec = randomUUID();
            const held: Held = { run: runId, process, streams: { stdout: pump(process.stdout), stderr: pump(process.stderr) }, waited: false, read: new Set(), finished: new Set() };
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
    } finally {
      if (start) started(runId, start);
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
          // The exit is read whether the provider gives it or fails to: either way the caller has its answer, and the
          // program goes once its streams' replies have ended.
          let code: number;
          try {
            code = await held.process.wait();
          } catch (error) {
            held.waited = true;
            held.exited ??= -1;
            failed(res, error);
            return settle(id);
          }
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
          // A caller that goes away (its process ended, or it stopped reading) lets the stream go: its read is ended and
          // nothing waits on it.
          let gone = false;
          let woke: () => void = () => {};
          res.once("close", () => {
            if (res.writableFinished) return;
            gone = true;
            stream.cancel();
            woke();
          });
          for (;;) {
            while (stream.chunks.length && !gone) {
              const chunk = stream.chunks.shift()!;
              stream.bytes -= chunk.length;
              stream.space?.();
              if (!res.write(chunk)) await new Promise<void>((resolve) => {
                woke = resolve;
                res.once("drain", resolve);
              });
            }
            if (stream.done || gone) break;
            await new Promise<void>((resolve) => (stream.wake = woke = resolve));
          }
          if (gone) return void forget(id);
          // A stream that broke, or was let go before it was all sent (the run's end), is a broken answer, never a short
          // one: the caller sees its read fail.
          if (stream.failure !== undefined || stream.cancelled) res.destroy();
          else res.end();
          // Ended either way: a failed stream holds no slot once its exit is read too.
          held.finished.add(name);
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
      for (const start of starting.get(runId) ?? []) start.dropped = true;
      for (const [id, held] of execs) if (held.run === runId) forget(id);
    },
    /** What the relay holds now, for the tests: its programs, and the runs with a start under way. */
    footprint: () => ({ programs: execs.size, starting: starting.size }),
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

/** How the run's process's relay client waits on the relay: never on a clock of its own. A program's exit (`wait`) and
 *  its output streams take as long as the program runs, which its caller bounds (bash's timeout, and pi-transport's
 *  backstop over it); Node's own fetch would give up after 300 s with no answer or no bytes, failing a longer command
 *  as lost. */
export const RELAY_AGENT_OPTIONS = Object.freeze({ headersTimeout: 0, bodyTimeout: 0 });

/** The SDK client a run's process hands pi-transport's VM provider: each call it makes of a box goes to the relay in data
 *  root `root`, with the run's own door token. It finds a sandbox and runs programs in it; it makes, lists and ends none. */
export function relayedVmSdk(root: string, runDir: string, runId: string, agentOptions: { headersTimeout: number; bodyTimeout: number } = RELAY_AGENT_OPTIONS) {
  // Its own dispatcher, with the waits above: made at its first call, kept for the process.
  let opened: Promise<{ dispatcher: Agent; dial: typeof import("undici").fetch }> | undefined;
  const open = () => (opened ??= import("undici").then(({ Agent, fetch }) => ({ dispatcher: new Agent(agentOptions), dial: fetch })));
  const call = async (path: string, body?: BodyInit, json = true): Promise<Response> => {
    const [{ url, token }, { dispatcher, dial }] = await Promise.all([relayAddress(root, runDir), open()]);
    return dial(`${url}/runs/${encodeURIComponent(runId)}/vm/${path}`, { method: "POST", headers: { authorization: `Bearer ${token}`, ...(json ? { "content-type": "application/json" } : { "content-type": "application/octet-stream" }) }, ...(body === undefined ? {} : { body: body as never }), redirect: "error", dispatcher }) as unknown as Promise<Response>;
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
