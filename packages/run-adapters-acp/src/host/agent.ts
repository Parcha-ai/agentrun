// One ACP agent process, and the client connection the adapter speaks to it with over its stdio (newline-delimited
// JSON-RPC, the official SDK's ndJsonStream). Written for AgentRun.
//  - It starts with the environment allowlist (child.ts), in its own process group, watched by this process
//    (parentWatched) inside the host's confinement: a SIGKILLed host leaves no agent behind.
//  - Its stderr is kept, its tail only, for a failure's words; nothing it prints reaches the log whole.
//  - kill() ends its whole group; so does an abort of `signal`.
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { client, ndJsonStream, type ClientConnection, type RequestPermissionRequest, type RequestPermissionResponse, type SessionNotification } from "@agentclientprotocol/sdk";
import { parentWatched, type ParentWatch } from "@parcha/agentrun-kernel/host";
import { childEnv, confined, type ConfineChild } from "./child.js";

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
  let stderr = "";
  child.stderr!.setEncoding("utf8");
  child.stderr!.on("data", (chunk: string) => void (stderr = (stderr + chunk).slice(-STDERR_TAIL)));
  // A write to a stdin the agent closed is its exit's to report, never an unhandled error.
  child.stdin!.on("error", () => {});
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

  const app = client({ name: "agentrun" })
    .onNotification("session/update", ({ params }) => options.onUpdate(params))
    .onRequest("session/request_permission", ({ params, signal }) => options.onPermission(params, signal));
  const connection = app.connect(ndJsonStream(Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>, Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>));
  void exited.then(() => connection.close(new Error(`the agent's process ended: ${stderr.trim().slice(-300) || "it printed nothing"}`)));
  return { connection, pid: child.pid, exited, alive: () => !done, stderrTail: () => stderr, kill };
}
