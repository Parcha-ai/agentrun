// One `opencode serve` for one drive of a session, and the HTTP client the drive speaks to it with. Written for AgentRun.
//  - The child's environment is an allowlist: PATH, LANG and TZ from this process, then what the drive names (its private
//    homes, its config, its server password and OpenCode's own switches). Nothing else is inherited, so no provider key,
//    token or host secret reaches it.
//  - It runs in its own process group, which `kill()` ends whole, and dies with this process: started with a watch on its
//    parent (./host's parentWatched), inside the host's confinement, so a host that is SIGKILLed leaves no OpenCode behind.
//  - Its port is the one it says it listens on (its line `opencode server listening on <loopback URL>`): `--port 0` is
//    not a free port of the system's choosing to OpenCode, which takes its default when that is free.
//  - Every request carries the server's basic auth (user `opencode`, the drive's own password).
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { parentWatched, type ParentWatch } from "@parcha/agentrun-kernel/host";

/** The variables a child takes from this process, when they are set. */
export const INHERITED_ENV = Object.freeze(["PATH", "LANG", "TZ"] as const);

/** A command and its arguments, as the drive starts it. */
export interface ChildCommand {
  command: string;
  args: string[];
}

/** The host's confinement of a child: the same command and arguments, started under the host's own (a
 *  `setpriv --no-new-privs` prefix, say). It may only add in front, and never sees or changes the child's environment. */
export type ConfineChild = (child: Readonly<ChildCommand>) => ChildCommand;

/** The command `confine` makes of `child`, refused unless it ends with the child's command and arguments unchanged. */
export function confined(child: ChildCommand, confine: ConfineChild | undefined): ChildCommand {
  if (!confine) return child;
  const out = confine({ command: child.command, args: [...child.args] });
  const argv = [out?.command, ...(Array.isArray(out?.args) ? out.args : [])];
  const tail = argv.slice(argv.length - child.args.length - 1);
  const kept = argv.length > child.args.length + 1 && tail.length === child.args.length + 1 && tail.every((a, i) => a === (i === 0 ? child.command : child.args[i - 1]));
  if (typeof out?.command !== "string" || !argv.every((a) => typeof a === "string") || !kept) throw new Error("opencode: the host's confinement must start the child's own command and arguments, after its own");
  return { command: out.command, args: out.args };
}

/** The child's environment: the allowlist from `from`, then what the caller names. */
export function childEnv(from: Readonly<Record<string, string | undefined>>, extra: Readonly<Record<string, string>> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of INHERITED_ENV) {
    const value = from[name];
    if (typeof value === "string") env[name] = value;
  }
  return { ...env, ...extra };
}

const LISTENING = /opencode server listening on (http:\/\/127\.0\.0\.1:(\d+))\b/;
const STDERR_TAIL = 8 * 1024;

export interface OpenCodeServerOptions {
  command: string;
  args: string[];
  cwd: string;
  /** What the child gets beyond the allowlist. */
  env: Record<string, string>;
  /** The environment the allowlist reads. Default `process.env`. */
  from?: Readonly<Record<string, string | undefined>>;
  password: string;
  confine?: ConfineChild;
  parentWatch?: ParentWatch;
  /** How long OpenCode may take to say it listens. Default 60 s. */
  startMs?: number;
  signal: AbortSignal;
  log?: (message: string, fields?: Record<string, unknown>) => void;
}

export interface OpenCodeServer {
  readonly url: string;
  readonly pid: number | undefined;
  /** A request to the server: its status and its JSON body (undefined when empty or not JSON). */
  request(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<{ status: number; body: unknown; text: string }>;
  /** The server's event stream: each event's JSON, until the stream ends or `signal` aborts. */
  events(signal: AbortSignal): AsyncIterable<{ type?: string; properties?: Record<string, unknown> }>;
  readonly exited: Promise<{ code: number | null; signal: string | null }>;
  alive(): boolean;
  stderrTail(): string;
  kill(): void;
}

/** Start `opencode serve` and resolve once it says where it listens. */
export async function startOpenCodeServer(options: OpenCodeServerOptions): Promise<OpenCodeServer> {
  const run = confined(parentWatched({ command: options.command, args: options.args }, options.parentWatch), options.confine);
  const child = spawn(run.command, run.args, { cwd: options.cwd, env: childEnv(options.from ?? process.env, options.env), detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr!.setEncoding("utf8");
  child.stderr!.on("data", (chunk: string) => void (stderr = (stderr + chunk).slice(-STDERR_TAIL)));
  let done = false;
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    child.once("error", (err) => {
      stderr = (stderr + `\n${String(err.message)}`).slice(-STDERR_TAIL);
      done = true;
      resolve({ code: null, signal: null });
    });
    child.once("close", (code, signal) => {
      done = true;
      resolve({ code, signal });
    });
  });
  const kill = () => {
    if (done || child.pid === undefined) return;
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      try { child.kill("SIGKILL"); } catch { /* gone */ }
    }
  };
  if (options.signal.aborted) kill();
  else options.signal.addEventListener("abort", kill, { once: true });

  // The port, from the line OpenCode prints when it listens; everything else it prints is kept for a failure's message.
  const url = await new Promise<string>((resolve, reject) => {
    let out = "";
    const lines = createInterface({ input: child.stdout!, crlfDelay: Infinity });
    const timer = setTimeout(() => finish(new Error(`OpenCode did not say it listens within ${Math.round((options.startMs ?? 60_000) / 1000)} s`)), options.startMs ?? 60_000);
    const finish = (result: string | Error) => {
      clearTimeout(timer);
      if (typeof result === "string") resolve(result);
      else {
        kill();
        reject(new Error(`opencode: ${result.message}: ${(out + stderr).trim().slice(-600) || "it printed nothing"}`));
      }
    };
    lines.on("line", (line) => {
      out = (out + line + "\n").slice(-STDERR_TAIL);
      const listening = LISTENING.exec(line);
      if (listening) finish(listening[1]!);
    });
    void exited.then(({ code, signal }) => finish(new Error(`OpenCode exited before it listened (${signal ?? `code ${code}`})`)));
  });

  const auth = `Basic ${Buffer.from(`opencode:${options.password}`).toString("base64")}`;
  const request: OpenCodeServer["request"] = async (method, path, body, signal) => {
    const response = await fetch(`${url}${path}`, {
      method,
      headers: { authorization: auth, ...(body === undefined ? {} : { "content-type": "application/json" }), accept: "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: signal ? AbortSignal.any([signal, options.signal]) : options.signal,
    });
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {}
    return { status: response.status, body: parsed, text };
  };

  async function* events(signal: AbortSignal): AsyncIterable<{ type?: string; properties?: Record<string, unknown> }> {
    const response = await fetch(`${url}/event`, { headers: { authorization: auth, accept: "text/event-stream" }, signal: AbortSignal.any([signal, options.signal]) });
    if (response.status !== 200 || !response.body) throw new Error(`opencode: OpenCode's event stream answered ${response.status}`);
    const decoder = new TextDecoder();
    let buffer = "";
    let data: string[] = [];
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      for (let at = buffer.search(/\r\n|\r|\n/); at >= 0; at = buffer.search(/\r\n|\r|\n/)) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + (buffer.startsWith("\r\n", at) ? 2 : 1));
        if (line === "") {
          const text = data.join("\n");
          data = [];
          if (!text) continue;
          try {
            yield JSON.parse(text) as { type?: string; properties?: Record<string, unknown> };
          } catch {
            options.log?.("opencode: an event that is not JSON was skipped", { bytes: text.length });
          }
        } else if (line.startsWith("data:")) data.push(line.slice(line.startsWith("data: ") ? 6 : 5));
      }
    }
  }

  return { url, pid: child.pid, request, events, exited, alive: () => !done, stderrTail: () => stderr, kill };
}
