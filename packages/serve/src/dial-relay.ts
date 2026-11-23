// A dial computer under a runner in a process of its own (the image's server-and-runner, `agentrun-serve runner`): a
// hosted machine that dials (Fly Machines, Cloudflare, or E2B, Daytona or Modal set to dial) reaches the server's one
// public address, and the server relays its socket to the runner that made it.
//
// The runner builds its own HostedDial (the computer package's hosted/provider.ts): `url` is the server's public address
// (AGENTRUN_PUBLIC_URL, as the server reads it), `tokens` are minted into the shared store with the runner's name and
// this incarnation on each row (computer-attach.ts `owner`), and `hub` is the runner's own AttachHub. It serves that hub
// on a private attach listener: on loopback beside its server, or on its live host (AGENTRUN_RUNNER_LIVE_HOST,
// live-reach.ts) where it runs on another host, and says where on the runner's row in the store (runners, through its
// presence: runner/presence.ts), which the presence renews; its incarnation is the presence's, one per runner process.
// The server's attach upgrade looks a token up, sees another runner owns it, and opens a socket to that
// runner's listener (computer-attach.ts relayDial) with the proxy's proof under the seal key (live-reach.ts relayProof).
// The listener answers nothing without a good, fresh proof it has not taken before, for this token, this runner and
// this incarnation, on loopback too, and its attach routes take only a token whose row names this runner and
// incarnation. The daemon fetch stays the server's; nothing changes on the machine.
//
// A runner with no public address keeps no relay: its dial providers still refuse (hosted/provider.ts), and the server's
// Settings → Computers still says so (computers.ts runs_refused).
//
// A paired computer reaches a run on this runner the same way (`paired`): the run's claim routes the box here
// (workspace/paired-route.ts takeRoute, under the run's claim) and waits until the server has moved its socket onto this
// hub (bring), and the run's release lets it go (letGo) once its hold ended, every remove or KILL it sent answered. The
// listener takes a paired computer's token only while its route names this runner and incarnation. A route this runner
// brought whose hold ended (released, or at its deadline) with no bring in flight is dropped at the next sweep
// (PRESENCE_RENEW_MS); and when the box's socket leaves this hub for a route that names another runner (the run resumed
// there), this runner's hold of it ends.
import { createServer } from "node:http";
import type { Duplex } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { ATTACH_PATH, AttachHub, type HostedDial } from "@parcha/agentrun-computer";
import { type AttachTiming, bearerOf, createAttachRoutes, sha256Hex } from "./computer-attach.js";
import { LOOPBACK, relayKeyOf, relayProofs, runnerLiveOf } from "./live-reach.js";
import { logLine } from "./print.js";
import { PRESENCE_RENEW_MS, type Presence } from "./runner/presence.js";
import type { Store } from "./store/index.js";
import { PAIRED_ID_PREFIX, type PairedRelay } from "./workspace/attached-computers.js";
import { dropRoute, lateWords, PAIRED_BRING_MS, PAIRED_BRING_POLL_MS, readRoute, takeRoute } from "./workspace/paired-route.js";

/** A runner's relay: its HostedDial for its providers, the paired computers' bring and let-go, where its listener
 *  answers, and its close. */
export interface RunnerRelay {
  readonly dial: HostedDial;
  readonly paired: PairedRelay;
  readonly incarnation: string;
  readonly host: string;
  readonly port: number;
  /** Its listener and every socket it took closed, and its runner's row answering nowhere (the row stays its presence's). */
  close(): Promise<void>;
}

/** A claim's failure to have its paired computer here, in words: the claim fails computer_unavailable with them. */
const unavailable = (words: string): Error => Object.assign(new Error(words), { code: "computer_unavailable" });
/** A bring whose claim was cancelled (its create's signal aborted) before the box reached runner `runner`. */
const cancelledWords = (name: string, runner: string): string => `${name} was not brought to runner ${runner}: this run's claim was cancelled while it waited for the box, and its route was let go`;

export interface RunnerRelayOptions {
  readonly store: Pick<Store, "mintedTokens" | "pairedComputers" | "settings" | "runners" | "runs">;
  readonly sealKey: Buffer;
  /** The runner's name, as its claims and its row carry it. */
  readonly runner: string;
  /** The runner's word that it is there (runner/presence.ts): its incarnation is the relay's, and its row says where the
   *  relay answers. */
  readonly presence: Pick<Presence, "incarnation" | "relay">;
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
  const { store, runner, presence, now = Date.now } = options;
  const log = options.log ?? (() => {});
  const { incarnation } = presence;
  const live = runnerLiveOf(options.env, options.sealKey);
  const host = live?.host ?? LOOPBACK;
  const hub = new AttachHub();
  const mine = { runner, incarnation };
  /** The routes this process brought, by computer: the run, when it was taken, and whether a hold was seen on it. */
  const held = new Map<string, { run: string; since: number; seenHold: boolean }>();
  /** The bring in flight per computer, by its run. */
  const bringing = new Map<string, string>();
  /** When the box's socket leaves this hub: a route that now names another runner (or another process of this one)
   *  ends this runner's hold of it (the run resumed there); a route still here keeps it, for the box's redial. */
  const left = async (id: string): Promise<void> => {
    const route = await readRoute(store.settings, id);
    if (route.runner === runner && route.incarnation === incarnation) return;
    const hold = hub.hold(id);
    if (hold !== undefined) await hub.unclaim(id, hold);
    held.delete(id);
  };
  const routes = createAttachRoutes({
    store, hub, owner: mine, now,
    log: (event, fields) => log(logLine(event, fields)),
    onSocket: (computer, ws) => {
      if (computer.startsWith(PAIRED_ID_PREFIX)) ws.once("close", () => void left(computer).catch(() => undefined));
    },
    ...(options.timing ? { timing: options.timing } : {}),
  });
  const paired: PairedRelay = {
    hub,
    async bring(row, { run, until, claim, signal }) {
      // A claim cancelled before its bring takes nothing.
      if (signal?.aborted) throw unavailable(cancelledWords(row.name, runner));
      bringing.set(row.id, run);
      try {
        const took = await takeRoute({ settings: store.settings, runners: store.runners, runs: store.runs }, row.id, { ...mine, run, until }, { ...(claim ? { claim } : {}), name: row.name });
        if (!took.taken) throw unavailable(took.why);
        held.set(row.id, { run, since: now(), seenHold: false });
        const end = now() + PAIRED_BRING_MS;
        for (;;) {
          // The claim was cancelled while it waited: its route goes (the row removed while it is still this run's), and
          // the claim fails in words at once, never waiting out PAIRED_BRING_MS.
          if (signal?.aborted) {
            await dropRoute(store.settings, row.id, { ...mine, run }).catch(() => undefined);
            held.delete(row.id);
            throw unavailable(cancelledWords(row.name, runner));
          }
          if (hub.online(row.id)) return;
          const route = await readRoute(store.settings, row.id);
          const ours = route.runner === runner && route.incarnation === incarnation && route.run === run;
          // The server noted why the box can't come (not attached now, its relay refused), or the time is up: the route
          // goes, its words kept on the row, and the claim fails in them. Never a hang.
          const why = !ours ? (route.refused ?? `${row.name}'s route went to another run while this run waited for it: its next claim tries again`) : (route.refused ?? (now() >= end ? lateWords(row.name, runner) : undefined));
          if (why !== undefined) {
            if (ours) await dropRoute(store.settings, row.id, { ...mine, run }, why).catch(() => undefined);
            held.delete(row.id);
            throw unavailable(why);
          }
          // A cancel wakes the wait at once; the loop's top answers it.
          await sleep(PAIRED_BRING_POLL_MS, undefined, signal ? { signal } : undefined).catch(() => undefined);
        }
      } finally {
        if (bringing.get(row.id) === run) bringing.delete(row.id);
      }
    },
    async letGo(computer, hold, run) {
      // Its hold ends first: unclaim waits for every remove or KILL it sent. A route stays while a hold is left here, or
      // while another run's bring is in flight here.
      if (hold !== undefined) await hub.unclaim(computer, hold);
      if (hub.hold(computer) !== undefined) return;
      const bring = bringing.get(computer);
      if (bring !== undefined && bring !== run) return;
      held.delete(computer);
      await dropRoute(store.settings, computer, { ...mine, ...(run !== undefined ? { run } : {}) });
    },
  };
  // The sweep of the routes this process brought: one whose hold ended (released, or at its deadline), or that no hold
  // took within PAIRED_BRING_MS, with no bring in flight, goes.
  const sweep = setInterval(() => {
    for (const [id, at] of held) {
      if (bringing.has(id)) continue;
      if (hub.hold(id) !== undefined) {
        at.seenHold = true;
        continue;
      }
      if (!at.seenHold && now() - at.since < PAIRED_BRING_MS) continue;
      held.delete(id);
      void dropRoute(store.settings, id, { ...mine, run: at.run }).catch((error: unknown) => log(logLine("computer_route_undropped", { computer: id, run: at.run, error: error instanceof Error ? error.message : String(error) })));
    }
  }, PRESENCE_RENEW_MS);
  sweep.unref();
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
    clearInterval(sweep);
    await routes.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  // Said on the runner's row, which its presence renews: a runner that died without its close reads as gone with it.
  try {
    await presence.relay({ host, port });
  } catch (error) {
    await shut();
    throw error;
  }
  let closing: Promise<void> | undefined;
  return {
    dial: { url, tokens: routes.machineTokens, hub },
    paired,
    incarnation,
    host,
    port,
    close: () =>
      (closing ??= (async () => {
        await presence.relay(null).catch(() => undefined);
        await shut();
      })()),
  };
}
