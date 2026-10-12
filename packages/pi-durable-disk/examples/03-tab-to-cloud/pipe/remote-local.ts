// A remote host on this machine, for a second host that needs no systemd unit and no disk client: the server starts
// remote-host.ts as a child process on a free loopback port, dials it with a bearer token and invites it, and the
// child runs the agent through the pipe, as a GPU sandbox does (pipe/daytona.ts). Its workspace is a temporary
// directory, removed when the run leaves it.
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import type { CloudHost, Invite } from "./server.ts";
import type { Environment } from "../wire.ts";

const REMOTE_HOST = join(dirname(fileURLToPath(import.meta.url)), "..", "remote-host.ts");

export const REMOTE_LOCAL: Environment = {
  id: "remote-local",
  label: "Second process",
  phrase: "a second process on your user's server, with no disk client",
  kind: "remote",
  detail: "remote-host.ts as a child process, through the pipe",
};

type Child = { child: ChildProcess; dir: string };

/** `script` is what each child runs (remote-host.ts unless a test gives a fixture). */
export function remoteLocalHost(options: { log?: (event: string, data?: Record<string, unknown>) => void; script?: string } = {}): CloudHost {
  const log = options.log ?? (() => undefined);
  const script = options.script ?? REMOTE_HOST;
  const children = new Map<string, Child>();
  /**
   * Starts on their way, by run. A stop of that run or a close of the host marks one cancelled, and the start then stops what it
   * spawned and fails instead of handing it over: a test's server stops its run and closes this host while the run's move is
   * still starting it, and a start that resumed after both would leave a remote host nobody stops (its process keeps the test's open).
   */
  const starting = new Map<string, { cancelled: string | null; done: Promise<unknown> }>();
  let closed = false;

  async function stopRemote(id: string): Promise<void> {
    const pending = starting.get(id);
    if (pending) pending.cancelled ??= "stopped";
    await stopChild(id);
  }

  async function stopChild(id: string): Promise<void> {
    const at = children.get(id);
    if (!at) return;
    children.delete(id);
    if (at.child.exitCode === null && at.child.signalCode === null) {
      const exited = new Promise((r) => at.child.once("exit", r));
      at.child.kill("SIGTERM");
      let fallback: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([exited, new Promise((r) => (fallback = setTimeout(r, 5_000)))]);
      clearTimeout(fallback); // a host that exited at once leaves no 5 s timer holding the process
      if (at.child.exitCode === null && at.child.signalCode === null) at.child.kill("SIGKILL");
    }
    rmSync(at.dir, { recursive: true, force: true });
  }

  return {
    environments: [REMOTE_LOCAL],
    async start() {
      throw new Error("remote-local has no cloud environment: it runs runs through the pipe");
    },
    async stop() {},

    async startRemote(ref, _env, invite: Invite, signal?: AbortSignal) {
      if (closed) throw new Error("the remote-local host is closed");
      const entry: { cancelled: string | null; done: Promise<unknown> } = { cancelled: null, done: Promise.resolve() };
      const earlier = starting.get(ref.id);
      if (earlier) earlier.cancelled ??= "replaced";
      starting.set(ref.id, entry);
      // The server gives up on a start it no longer wants (its own deadline, a run that moved on): that cancels it the same way.
      const giveUp = () => {
        entry.cancelled ??= "given up";
        void stopChild(ref.id);
      };
      if (signal?.aborted) entry.cancelled = "given up";
      else signal?.addEventListener("abort", giveUp, { once: true });
      const check = () => {
        const why = closed ? "closed" : entry.cancelled;
        if (why) throw new Error(`the remote-local start of ${ref.id} was ${why === "closed" ? "overtaken: the host was closed" : why}`);
      };
      const run = (async () => {
        try {
          await stopChild(ref.id); // the run's earlier host: this start replaces it (a stop of the run would cancel this start too)
          check();
          return await startChild(ref, invite, check);
        } finally {
          signal?.removeEventListener("abort", giveUp);
          if (starting.get(ref.id) === entry) starting.delete(ref.id);
        }
      })();
      entry.done = run.catch(() => undefined);
      return run;
    },

    stopRemote: (ref) => stopRemote(ref.id),

    async close() {
      closed = true;
      for (const pending of starting.values()) pending.cancelled ??= "closed";
      for (const id of [...children.keys()]) await stopChild(id); // a start waiting for its host to listen fails as soon as it exits
      await Promise.all([...starting.values()].map((pending) => pending.done));
      for (const id of [...children.keys()]) await stopChild(id);
    },
  };

  /** Spawn a run's remote host, wait for it to listen, dial and invite it; `check` throws when the start was cancelled meanwhile. */
  async function startChild(ref: Parameters<NonNullable<CloudHost["startRemote"]>>[0], invite: Invite, check: () => void) {
    const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "pda-remote-local-"));
    const token = randomBytes(24).toString("base64url");
    writeFileSync(join(dir, "token"), `${token}\n`, { mode: 0o600 });
    const child = spawn(process.execPath, [script, "--port", "0", "--host", "127.0.0.1", "--token-file", join(dir, "token"), "--work", join(dir, "work")], {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir, LANG: "C.UTF-8", DEMO_ENV_LABEL: REMOTE_LOCAL.phrase, DEMO_ENV_CLASS: REMOTE_LOCAL.label, ...(process.env.PDA_REMOTE_LOCAL_NOTE ? { DEMO_ENV_NOTE: process.env.PDA_REMOTE_LOCAL_NOTE } : {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.set(ref.id, { child, dir });
    try {
      return await dialChild(ref, invite, check, child, token);
    } catch (e) {
      if (children.get(ref.id)?.child === child) await stopChild(ref.id); // a start that fails stops the host it spawned
      throw e;
    }
  }

  async function dialChild(ref: Parameters<NonNullable<CloudHost["startRemote"]>>[0], invite: Invite, check: () => void, child: ChildProcess, token: string) {
    const port = await new Promise<number>((resolve, reject) => {
      let out = "";
      // cleared on every way out (listening, exit), so a host stopped before it listens leaves no 30 s timer holding the process
      const timer = setTimeout(() => reject(new Error(`the remote host did not listen: ${out.slice(-300)}`)), 30_000);
      child.stdout!.on("data", (d: Buffer) => {
        out += String(d);
        const line = out.split("\n").find((l) => l.includes('"event":"listening"'));
        if (line) {
          clearTimeout(timer);
          resolve((JSON.parse(line) as { port: number }).port);
        }
      });
      child.stderr!.on("data", (d: Buffer) => (out += String(d)));
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`the remote host exited ${code}: ${out.slice(-300)}`));
      });
    });
    check();
    const socket = await new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/`, { headers: { authorization: `Bearer ${token}` }, maxPayload: 64 * 1024 * 1024 });
      ws.once("open", () => resolve(ws));
      ws.once("error", reject);
    });
    try {
      check();
    } catch (e) {
      socket.close();
      throw e;
    }
    socket.send(JSON.stringify(invite));
    log("remote.local", { run: ref.id, port, pid: child.pid });
    return { socket, host: `${REMOTE_LOCAL.label} (pid ${child.pid})` };
  }
}
