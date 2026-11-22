// One ACP agent process, and the client connection the adapter speaks to it with over its stdio (newline-delimited
// JSON-RPC, the official SDK's ndJsonStream). Written for AgentRun.
//  - It starts with the environment allowlist (child.ts), in its own process group, watched by this process
//    (parentWatched) inside the host's confinement: a SIGKILLed host leaves no agent behind.
//  - Its stderr is kept, its tail only, for a failure's words; nothing it prints reaches the log whole. The keys it was
//    handed are cut from the tail before it is shortened, a key's end at the head of a cut tail goes too, and so does a
//    key's start at its end (one the agent is still writing, read mid-run) (key-cut.ts).
//  - kill() ends its whole group; so does an abort of `signal`.
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { client, ndJsonStream, type ClientConnection, type RequestPermissionRequest, type RequestPermissionResponse, type SessionNotification } from "@agentclientprotocol/sdk";
import { parentWatched, type ParentWatch } from "@parcha/agentrun-kernel/host";
import { childEnv, confined, type ConfineChild } from "./child.js";
import { cutKeys, keysToCut } from "./key-cut.js";

const STDERR_TAIL = 8 * 1024;

export interface AgentProcessOptions {
  command: string;
  args: readonly string[];
  cwd: string;
  /** What the child gets beyond the allowlist. */
  env: Record<string, string>;
  /** The environment the allowlist reads. Default `process.env`. */
  from?: Readonly<Record<string, string | undefined>>;
  confine?: ConfineChild;
  parentWatch?: ParentWatch;
  /** The key values in `env` (the recipe's keys): cut from its stderr before the tail is shortened. */
  keys?: readonly string[];
  signal: AbortSignal;
  /** Each session/update the agent sends, in the order it sent them. */
  onUpdate(update: SessionNotification): void;
  /** The agent asks permission for a tool call: the answer, or a rejection while `signal` (the connection's) aborts. */
  onPermission(request: RequestPermissionRequest, signal: AbortSignal): Promise<RequestPermissionResponse>;
}

export interface AgentProcess {
  readonly connection: ClientConnection;
  readonly pid: number | undefined;
  readonly exited: Promise<{ code: number | null; signal: string | null }>;
  alive(): boolean;
  stderrTail(): string;
  kill(): void;
}

/** Start the agent and open the client connection over its stdio. */
export function startAgent(options: AgentProcessOptions): AgentProcess {
  const run = confined(parentWatched({ command: options.command, args: [...options.args] }, options.parentWatch), options.confine);
  const child = spawn(run.command, run.args, { cwd: options.cwd, env: childEnv(options.from ?? process.env, options.env), detached: true, stdio: ["pipe", "pipe", "pipe"] });
  // What it printed, raw, kept a key's length beyond the tail: a key split across chunks, or across the tail's start, is
  // still whole here, and cut whole (stderrTail). `cut`: whether its start was ever dropped.
  const keys = keysToCut(options.keys ?? []);
  const keep = STDERR_TAIL + (keys[0]?.length ?? 0);
  let raw = "";
  let cut = false;
  const take = (text: string) => {
    raw += text;
    if (raw.length > keep) {
      raw = raw.slice(-keep);
      cut = true;
    }
  };
  // A key's start at the end goes at every read, the agent alive or not: alive, it may be a key still being written;
  // ended, the most it drops is a key's length less one, and only text that spells a key's start.
  const stderrTail = (): string => cutKeys(raw, keys, { head: cut, tail: true }).slice(-STDERR_TAIL);
  child.stderr!.setEncoding("utf8");
  child.stderr!.on("data", take);
  // A write to a stdin the agent closed is its exit's to report, never an unhandled error.
  child.stdin!.on("error", () => {});
  let done = false;
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    child.once("error", (err) => {
      take(`\n${String(err.message)}`);
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

  const app = client({ name: "agentrun" })
    .onNotification("session/update", ({ params }) => options.onUpdate(params))
    .onRequest("session/request_permission", ({ params, signal }) => options.onPermission(params, signal));
  const connection = app.connect(ndJsonStream(Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>, Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>));
  void exited.then(() => connection.close(new Error(`the agent's process ended: ${stderrTail().trim().slice(-300) || "it printed nothing"}`)));
  return { connection, pid: child.pid, exited, alive: () => !done, stderrTail, kill };
}
