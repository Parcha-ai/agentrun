// The first command of a session's box, written for AgentRun: it serves the box's sockets on the box's own loopback, then
// runs the harness. A box has no network but its own loopback (bubblewrap's --unshare-net), and the host binds two Unix
// sockets into it: the model front's and the egress proxy's. A CLI speaks HTTP to a port, so this listens on
// a port of the box's own loopback and pipes each connection to its socket, nothing else.
//  - The harness gets this process's stdio as its own, so its bytes pass unchanged; its environment is the box's.
//  - TERM, INT and HUP are passed on to it, and this exits as it did: its code, or its signal raised again.
//  - Anything in the box can kill this process: the box then has no way out at all, never one around the sockets.
// It imports only node's own modules, so the box binds this one file.
//
//   node box-forward.js --listen <port>=<socket> [--listen <port>=<socket> ...] -- <command> [args...]
import { spawn, type ChildProcess } from "node:child_process";
import { connect, createServer, type Server } from "node:net";
import { fileURLToPath } from "node:url";

/** A port inside the box, and the socket it serves. */
export interface ForwardListen {
  port: number;
  socket: string;
}

/** The box's own loopback, inside its network namespace: where the forwarder serves the host's sockets. */
export const BOX_LOOPBACK = "127.0.0.1"; // key-gate: loopback-rule loopback inside the box network namespace

/** This script, as the host binds it into a box (read-only, with node). */
export const BOX_FORWARD = fileURLToPath(import.meta.url);

/** The box's first command: this forwarder serving `listen`, then `harness`. `parseForward` reads back exactly these. */
export function forwardChild(harness: { command: string; args: readonly string[] }, listen: readonly ForwardListen[]): { command: string; args: string[] } {
  return { command: process.execPath, args: [BOX_FORWARD, ...listen.flatMap((l) => ["--listen", `${l.port}=${l.socket}`]), "--", harness.command, ...harness.args] };
}

/** The forwarder's arguments, or the named reason they are refused. */
export function parseForward(argv: readonly string[]): { listen: ForwardListen[]; command: string; args: string[] } {
  const listen: ForwardListen[] = [];
  let at = 0;
  for (; at < argv.length && argv[at] !== "--"; at += 2) {
    const value = argv[at + 1] ?? "";
    const match = /^([1-9][0-9]{0,4})=(\/[^\0]+)$/.exec(value);
    if (argv[at] !== "--listen" || !match || Number(match[1]) > 65535) throw new Error(`box-forward: expected --listen <port>=<absolute socket path>, got ${JSON.stringify([argv[at], value].join(" ").slice(0, 120))}`);
    listen.push({ port: Number(match[1]), socket: match[2]! });
  }
  const [command, ...args] = argv.slice(at + 1);
  if (argv[at] !== "--" || !command) throw new Error("box-forward: the harness's command goes after --");
  if (new Set(listen.map((l) => l.port)).size !== listen.length) throw new Error("box-forward: a port is listed twice");
  return { listen, command, args };
}

/** Serve `socket` on the box's loopback at `port`: each connection piped to the socket, both ended together. */
export function forward({ port, socket }: ForwardListen): Promise<Server> {
  const server = createServer((client) => {
    const upstream = connect(socket);
    const end = () => {
      client.destroy();
      upstream.destroy();
    };
    client.on("error", end).on("close", end);
    upstream.on("error", end).on("close", end);
    client.pipe(upstream);
    upstream.pipe(client);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, BOX_LOOPBACK, () => resolve(server));
  });
}

const RELAYED = ["SIGTERM", "SIGINT", "SIGHUP"] as const;

/** Listen on every port, run the harness, and exit as it does. */
export async function main(argv: readonly string[]): Promise<void> {
  let parsed: ReturnType<typeof parseForward>;
  try {
    parsed = parseForward(argv);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exit(64);
  }
  // The handlers are set before anything starts: the harness runs before spawn returns here, so a TERM it or the host sends
  // then must find them. One that comes before the harness exists ends this process by it, as if it had none.
  let child: ChildProcess | undefined;
  for (const signal of RELAYED) {
    process.on(signal, () => {
      if (child) child.kill(signal);
      else exitBy(signal);
    });
  }
  const servers: Server[] = [];
  try {
    for (const listen of parsed.listen) servers.push(await forward(listen));
  } catch (error) {
    process.stderr.write(`box-forward: cannot listen in the box: ${(error as Error).message}\n`);
    process.exit(71);
  }
  child = spawn(parsed.command, parsed.args, { stdio: "inherit" });
  child.once("error", (error) => {
    process.stderr.write(`box-forward: the harness did not start: ${error.message}\n`);
    process.exit(127);
  });
  child.once("exit", (code, signal) => {
    for (const server of servers) server.close();
    if (signal) exitBy(signal);
    else process.exit(code ?? 1);
  });
}

/** Exit by `signal`, with this process's handler for it gone. */
function exitBy(signal: NodeJS.Signals): void {
  process.removeAllListeners(signal);
  process.kill(process.pid, signal);
}

// Run as the command only (node box-forward.js ...), never when imported.
if ((import.meta as { main?: boolean }).main) void main(process.argv.slice(2));
