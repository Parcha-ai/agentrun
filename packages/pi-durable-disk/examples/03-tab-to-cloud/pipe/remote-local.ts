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

export function remoteLocalHost(options: { log?: (event: string, data?: Record<string, unknown>) => void } = {}): CloudHost {
  const log = options.log ?? (() => undefined);
  const children = new Map<string, Child>();

  async function stopRemote(id: string): Promise<void> {
    const at = children.get(id);
    if (!at) return;
    children.delete(id);
    if (at.child.exitCode === null && at.child.signalCode === null) {
      const exited = new Promise((r) => at.child.once("exit", r));
      at.child.kill("SIGTERM");
      await Promise.race([exited, new Promise((r) => setTimeout(r, 5_000))]);
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

    async startRemote(ref, _env, invite: Invite) {
      await stopRemote(ref.id);
      const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "pda-remote-local-"));
      const token = randomBytes(24).toString("base64url");
      writeFileSync(join(dir, "token"), `${token}\n`, { mode: 0o600 });
      const child = spawn(process.execPath, [REMOTE_HOST, "--port", "0", "--host", "127.0.0.1", "--token-file", join(dir, "token"), "--work", join(dir, "work")], {
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir, LANG: "C.UTF-8", DEMO_ENV_LABEL: REMOTE_LOCAL.phrase, DEMO_ENV_CLASS: REMOTE_LOCAL.label },
        stdio: ["ignore", "pipe", "pipe"],
      });
      children.set(ref.id, { child, dir });
      const port = await new Promise<number>((resolve, reject) => {
        let out = "";
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
        child.once("exit", (code) => reject(new Error(`the remote host exited ${code}: ${out.slice(-300)}`)));
      });
      const socket = await new Promise<WebSocket>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/`, { headers: { authorization: `Bearer ${token}` }, maxPayload: 64 * 1024 * 1024 });
        ws.once("open", () => resolve(ws));
        ws.once("error", reject);
      });
      socket.send(JSON.stringify(invite));
      log("remote.local", { run: ref.id, port, pid: child.pid });
      return { socket, host: `${REMOTE_LOCAL.label} (pid ${child.pid})` };
    },

    stopRemote: (ref) => stopRemote(ref.id),

    async close() {
      for (const id of [...children.keys()]) await stopRemote(id);
    },
  };
}
