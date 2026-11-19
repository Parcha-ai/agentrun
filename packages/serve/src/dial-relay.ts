// A dial computer under a runner in a process of its own (the image's server-and-runner, `agentrun-serve runner`): a
// hosted machine that dials (Fly Machines, Cloudflare, or E2B, Daytona or Modal set to dial) reaches the server's one
// public address, and the server relays its socket to the runner that made it.
//
// The runner builds its own HostedDial (the computer package's hosted/provider.ts): `url` is the server's public address
// (AGENTRUN_PUBLIC_URL, as the server reads it), `tokens` are minted into the shared store with the runner's name and
// this incarnation on each row (computer-attach.ts `owner`), and `hub` is the runner's own AttachHub. It serves that hub
// on a private attach listener: on loopback beside its server, or on its live host (AGENTRUN_RUNNER_LIVE_HOST,
// live-reach.ts) where it runs on another host, and keeps where in the store (runner_relays), renewed every
// RELAY_RENEW_MS. The server's attach upgrade looks a token up, sees another runner owns it, and opens a socket to that
// runner's listener (computer-attach.ts relayDial) with the proxy's proof under the seal key (live-reach.ts relayProof).
// The listener answers nothing without a good, fresh proof it has not taken before, for this token, this runner and
// this incarnation, on loopback too, and its attach routes take only a token whose row names this runner and
// incarnation. The daemon fetch stays the server's; nothing changes on the machine.
//
// A runner with no public address keeps no relay: its dial providers still refuse (hosted/provider.ts), and the server's
// Settings → Computers still says so (computers.ts runs_refused).
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { Duplex } from "node:stream";
import { ATTACH_PATH, AttachHub, type HostedDial } from "@parcha/agentrun-computer";
import { type AttachTiming, bearerOf, createAttachRoutes, RELAY_RENEW_MS, sha256Hex } from "./computer-attach.js";
import { LOOPBACK, relayKeyOf, relayProofs, runnerLiveOf } from "./live-reach.js";
import { logLine } from "./print.js";
import type { Store } from "./store/index.js";

/** A runner's relay: its HostedDial for its providers, where its listener answers, and its close. */
export interface RunnerRelay {
  readonly dial: HostedDial;
  readonly incarnation: string;
  readonly host: string;
  readonly port: number;
  /** Its listener and every socket it took closed, its row gone. */
  close(): Promise<void>;
}

export interface RunnerRelayOptions {
  readonly store: Pick<Store, "mintedTokens" | "pairedComputers" | "runnerRelays">;
  readonly sealKey: Buffer;
  /** The runner's name, as its claims and its row carry it. */
  readonly runner: string;
  /** AGENTRUN_PUBLIC_URL (or RENDER_EXTERNAL_URL), AGENTRUN_RUNNER_LIVE_HOST and AGENTRUN_RUNNER_LIVE_BIND. */
  readonly env: NodeJS.ProcessEnv;
  /** Told each line worth saying (a machine attached, refused); never a token. */
  readonly log?: (line: string) => void;
  /** For tests: the socket's liveness timing (the protocol's by default) and the clock. */
  readonly timing?: AttachTiming;
  readonly now?: () => number;
}

/** The server's public address as this runner's environment names it (cli.ts reads the same two), or undefined. */
export function publicUrlOf(env: NodeJS.ProcessEnv): string | undefined {
  const given = env.AGENTRUN_PUBLIC_URL || env.RENDER_EXTERNAL_URL;
  const parsed = given && URL.canParse(given) ? new URL(given) : undefined;
  return parsed && /^https?:$/.test(parsed.protocol) ? parsed.href.replace(/\/+$/, "") : undefined;
}

/** The runner's relay, started: undefined where its environment names no public address of the server's. */
export async function startRunnerRelay(options: RunnerRelayOptions): Promise<RunnerRelay | undefined> {
  const url = publicUrlOf(options.env);
  if (url === undefined) return undefined;
  const { store, runner, now = Date.now } = options;
  const log = options.log ?? (() => {});
  const incarnation = randomUUID();
  const live = runnerLiveOf(options.env, options.sealKey);
  const host = live?.host ?? LOOPBACK;
  const hub = new AttachHub();
  const routes = createAttachRoutes({
    store, hub, machinesOnly: true, owner: { runner, incarnation }, now,
    log: (event, fields) => log(logLine(event, fields)),
    ...(options.timing ? { timing: options.timing } : {}),
  });
  const proven = relayProofs(relayKeyOf(options.sealKey), now);
  const deny = (socket: Duplex, status: string, words = "", headers: Record<string, string> = {}) => {
    const lines = Object.entries({ ...headers, "content-type": "text/plain; charset=utf-8", "content-length": String(Buffer.byteLength(words)) }).map(([name, value]) => `${name}: ${value}\r\n`).join("");
    socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n${lines}\r\n${words}`);
  };
  // Nothing but the attach upgrade, and that only with the server's proof for its token, this runner and incarnation.
  const server = createServer((_req, res) => void res.writeHead(404, { "content-length": "0" }).end());
  server.on("upgrade", (req, socket: Duplex, head: Buffer) => {
    socket.on("error", () => socket.destroy());
    if ((req.url ?? "/").split("?")[0] !== ATTACH_PATH) return deny(socket, "404 Not Found");
    const bearer = bearerOf(req.headers.authorization);
    if (bearer === undefined || !proven(req, { tokenSha256: sha256Hex(bearer), runner, incarnation })) return deny(socket, "401 Unauthorized");
    routes.upgrade(req, socket, head, (status, words, headers) => deny(socket, status, words, headers));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, live?.bind ?? LOOPBACK, () => (server.off("error", reject), resolve()));
  });
  const port = (server.address() as { port: number }).port;
  const shut = async () => {
    await routes.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  try {
    await store.runnerRelays.put({ runner, incarnation, host, port });
  } catch (error) {
    await shut();
    throw error;
  }
  // Said again on its interval, so the server takes a runner that died without its close as gone (RELAY_STALE_MS).
  const renew = setInterval(() => void store.runnerRelays.seen(runner, incarnation).catch(() => undefined), RELAY_RENEW_MS);
  renew.unref();
  let closing: Promise<void> | undefined;
  return {
    dial: { url, tokens: routes.machineTokens, hub },
    incarnation,
    host,
    port,
    close: () =>
      (closing ??= (async () => {
        clearInterval(renew);
        await store.runnerRelays.remove(runner, incarnation).catch(() => undefined);
        await shut();
      })()),
  };
}
